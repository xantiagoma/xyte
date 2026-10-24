import { assertSupportedActions, BrowserEngine, type BrowserOptions } from './engines/browser.ts';
import { runHttp, type EngineAttempt, type EngineResult } from './engines/http.ts';
import {
  domainUnreachable,
  invalidRequest,
  temporaryDownloadError,
  unsupported,
  XyteError,
} from './errors.ts';
import { direct, type ProxyProvider } from './proxy.ts';
import { defaultTransport, type Transport } from './transport.ts';
import { EXTRACTION_FIELDS, type ExtractionField, type ExtractRequest, type ExtractResponse } from './types.ts';
import { CookieJar, randomSessionId, sleep } from './util.ts';

/** Computes one AI-extraction output (e.g. `product`) from the downloaded page. */
export type Extractor = (input: {
  url: string;
  html: string;
  request: ExtractRequest;
  /** Options of the field, e.g. `productOptions`. */
  options: unknown;
}) => unknown | Promise<unknown>;

export interface BanCheck {
  url: string;
  statusCode: number;
  headers: { name: string; value: string }[];
  html?: string;
}

export interface XyteOptions {
  /** Where requests exit. Default: `direct()` (no proxy). */
  proxy?: ProxyProvider;
  /**
   * Retries after a ban, a proxy failure or a network error, each through a fresh session
   * (a new exit IP). Default 3, like Zyte's own clients.
   */
  retries?: number;
  /** Per-attempt timeout, seconds. Default 60. */
  timeout?: number;
  /** Max requests in flight; extra calls queue. Default: unlimited. */
  concurrency?: number;
  /**
   * Decides whether a downloaded page is a ban (retried, then a 520) rather than the real page.
   * Default: `isLikelyBan`. Pass `false` to return every page as is.
   */
  isBan?: ((page: BanCheck) => boolean) | false;
  /** Browser rendering for `browserHtml`, `screenshot`, `actions`, `networkCapture`. */
  browser?: BrowserOptions;
  /**
   * Implementations for Zyte's extraction outputs (`product`, `article`, `markdown`, …), keyed by
   * field. Requests for a field without an extractor are rejected with a 400.
   */
  extractors?: Partial<Record<ExtractionField, Extractor>>;
  /** Low-level HTTP sender; replace to add logging, or for tests. */
  transport?: Transport;
  /** Called before each retry. */
  onRetry?: (info: { attempt: number; url: string; reason: string }) => void;
}

const BROWSER_OUTPUTS = ['browserHtml', 'screenshot'] as const;
const BROWSER_ONLY = ['actions', 'networkCapture', 'javascript', 'viewport', 'screenshotOptions'] as const;
const HTTP_ONLY = [
  'httpRequestMethod',
  'httpRequestBody',
  'httpRequestText',
  'customHttpRequestHeaders',
  'followRedirect',
] as const;
const UNSUPPORTED_FIELDS = ['sessionContext', 'sessionContextParameters', 'includeIframes'] as const;

export class Xyte {
  private readonly proxy: ProxyProvider;
  private readonly retries: number;
  private readonly timeoutMs: number;
  private readonly isBan: (page: BanCheck) => boolean;
  private readonly browser: BrowserEngine;
  private readonly transport: Transport;
  private readonly sessions = new Map<string, CookieJar>();
  private readonly limit: <T>(task: () => Promise<T>) => Promise<T>;

  constructor(private readonly options: XyteOptions = {}) {
    this.proxy = options.proxy ?? direct();
    this.retries = options.retries ?? 3;
    this.timeoutMs = (options.timeout ?? 60) * 1000;
    this.isBan = options.isBan === false ? () => false : (options.isBan ?? isLikelyBan);
    this.browser = new BrowserEngine(options.browser);
    this.transport = options.transport ?? defaultTransport;
    this.limit = limiter(options.concurrency ?? Number.POSITIVE_INFINITY);
  }

  /**
   * Same contract as `POST https://api.zyte.com/v1/extract`: resolves with the 200 body, rejects
   * with an `XyteError` carrying Zyte's status and problem type.
   */
  extract(request: ExtractRequest): Promise<ExtractResponse> {
    return this.limit(() => this.run(request));
  }

  /** Closes the shared browser, if one was started. */
  close(): Promise<void> {
    return this.browser.close();
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await this.close();
  }

  private async run(request: ExtractRequest): Promise<ExtractResponse> {
    const plan = this.plan(request);
    const country = request.geolocation?.toUpperCase();
    const pinnedSession = request.session?.id;
    let lastReason = 'unknown error';
    let lastCause: unknown;
    let lastWasBan = false;

    for (let attempt = 0; attempt <= this.retries; attempt++) {
      if (attempt > 0) {
        this.options.onRetry?.({ attempt, url: request.url, reason: lastReason });
        await sleep(backoff(attempt));
      }

      const sessionId = pinnedSession ?? randomSessionId();
      const jar = this.jarFor(request, pinnedSession);
      const signal = AbortSignal.timeout(this.timeoutMs);

      let result: EngineResult;
      try {
        const proxy = await this.proxy.resolve({
          url: new URL(request.url),
          country,
          ipType: request.ipType,
          sessionId,
          attempt,
          browser: plan.browser,
        });
        const engineAttempt: EngineAttempt = { request, proxy, jar, signal };
        result = plan.browser ? await this.browser.run(engineAttempt) : await runHttp(engineAttempt, this.transport);
      } catch (error) {
        if (error instanceof XyteError) throw error;
        const classified = classifyError(error);
        if (classified === 'unreachable') {
          throw domainUnreachable(`could not resolve ${new URL(request.url).hostname}`, error);
        }
        lastReason = describe(error);
        lastCause = error;
        lastWasBan = false;
        continue;
      }

      if (this.isBan({ url: result.response.url ?? request.url, statusCode: result.statusCode, headers: result.headers, html: result.html })) {
        lastReason = `ban detected (HTTP ${result.statusCode})`;
        lastCause = undefined;
        lastWasBan = true;
        continue;
      }

      if (pinnedSession) this.sessions.set(pinnedSession, jar);
      return this.finish(request, plan, result, jar);
    }

    throw temporaryDownloadError(`${lastReason} after ${this.retries + 1} attempts`, {
      ban: lastWasBan,
      cause: lastCause,
    });
  }

  /** Mirrors Zyte's request validation, and decides HTTP vs browser. */
  private plan(request: ExtractRequest): { browser: boolean; extractions: ExtractionField[] } {
    if (typeof request.url !== 'string') throw invalidRequest('"url" is required');
    let url: URL;
    try {
      url = new URL(request.url);
    } catch {
      throw invalidRequest(`"url" must be an absolute URL, got ${JSON.stringify(request.url)}`);
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') throw invalidRequest('"url" must be http or https');

    for (const field of UNSUPPORTED_FIELDS) if (request[field] != null) throw unsupported(`"${field}"`);

    const extractions = EXTRACTION_FIELDS.filter((field) => request[field] != null && request[field] !== false);
    for (const field of extractions) {
      if (!this.options.extractors?.[field]) {
        throw unsupported(`"${field}" without an extractor (pass one in \`extractors.${field}\`)`);
      }
    }

    const wantsBrowser = BROWSER_OUTPUTS.some((field) => request[field] === true);
    if (wantsBrowser && request.httpResponseBody) {
      throw invalidRequest('httpResponseBody cannot be combined with browserHtml or screenshot');
    }
    if (request.httpRequestBody != null && request.httpRequestText != null) {
      throw invalidRequest('httpRequestBody and httpRequestText cannot be combined');
    }
    if (request.customHttpRequestHeaders?.some((h) => h.name?.toLowerCase() === 'cookie')) {
      throw invalidRequest('use requestCookies, not a Cookie header in customHttpRequestHeaders');
    }

    // Extraction alone picks its source from `<field>Options.extractFrom`, else HTTP.
    const extractFromBrowser = extractions.some((field) => {
      const from = (request as unknown as Record<string, { extractFrom?: string } | undefined>)[`${field}Options`]?.extractFrom;
      return from === 'browserHtml' || from === 'browserHtmlOnly';
    });

    const browser = wantsBrowser || (!request.httpResponseBody && extractFromBrowser);
    if (browser) {
      for (const field of HTTP_ONLY) {
        if (request[field] != null) throw invalidRequest(`"${field}" can only be used with httpResponseBody`);
      }
      assertSupportedActions(request.actions);
    } else {
      for (const field of BROWSER_ONLY) {
        if (request[field] != null) throw invalidRequest(`"${field}" requires browserHtml or screenshot`);
      }
      const hasOutput =
        request.httpResponseBody || request.httpResponseHeaders || request.responseCookies || extractions.length > 0;
      if (!hasOutput) {
        throw invalidRequest('no output requested: set httpResponseBody, browserHtml, screenshot or an extraction field');
      }
    }
    return { browser, extractions };
  }

  private jarFor(request: ExtractRequest, sessionId: string | undefined): CookieJar {
    if (request.requestCookies) return new CookieJar(request.requestCookies);
    if (request.cookieManagement === 'discard') return new CookieJar();
    // Cookies persist across requests only within a Zyte session.
    const existing = sessionId ? this.sessions.get(sessionId) : undefined;
    return new CookieJar(existing?.all());
  }

  private async finish(
    request: ExtractRequest,
    plan: { extractions: ExtractionField[] },
    result: EngineResult,
    jar: CookieJar,
  ): Promise<ExtractResponse> {
    const response: ExtractResponse = { ...result.response };
    for (const field of plan.extractions) {
      const extractor = this.options.extractors![field]!;
      (response as Record<string, unknown>)[field] = await extractor({
        url: response.url ?? request.url,
        html: result.html ?? '',
        request,
        options: (request as Record<string, unknown>)[`${field}Options`],
      });
    }
    if (request.responseCookies) response.responseCookies = jar.all();
    if (request.echoData !== undefined) response.echoData = request.echoData;
    if (request.jobId != null) response.jobId = request.jobId;
    return response;
  }
}

/** Shorthand for `new Xyte(options)`. */
export function createXyte(options?: XyteOptions): Xyte {
  return new Xyte(options);
}

const BAN_STATUSES = new Set([403, 429, 503]);

/** Anti-bot interstitials that come back with a 200. */
const CHALLENGE_MARKERS = [
  /<title>\s*Just a moment\.\.\.\s*<\/title>/i, // Cloudflare
  /cf-browser-verification|cf_chl_opt|challenges\.cloudflare\.com\/cdn-cgi\/challenge-platform/i,
  /_Incapsula_Resource|Incapsula incident ID/i, // Imperva
  /captcha-delivery\.com|geo\.captcha-delivery/i, // DataDome
  /px-captcha|perimeterx/i, // HUMAN
  /<title>\s*Pardon Our Interruption/i, // Distil / Imperva
  /Access Denied<\/h1>[\s\S]{0,400}Reference&#32;&#35;|errors\.edgesuite\.net/i, // Akamai
];

/**
 * Default ban heuristic: 403/429/503 statuses, or a known anti-bot challenge page. Other 4xx/5xx
 * are real answers and are returned in `statusCode`, as Zyte does.
 */
export function isLikelyBan(page: BanCheck): boolean {
  if (BAN_STATUSES.has(page.statusCode)) return true;
  const html = page.html;
  if (!html || html.length > 512 * 1024) return false;
  return CHALLENGE_MARKERS.some((marker) => marker.test(html));
}

function classifyError(error: unknown): 'unreachable' | 'retry' {
  const text = describe(error);
  if (/ENOTFOUND|EAI_AGAIN.*ENOTFOUND|ERR_NAME_NOT_RESOLVED|getaddrinfo .*ENOTFOUND|DNS.*not.*found/i.test(text)) {
    // Through a proxy, the proxy resolves names; a DNS failure here is the target's.
    return 'unreachable';
  }
  return 'retry';
}

function describe(error: unknown): string {
  if (error instanceof Error) {
    const cause = error.cause instanceof Error ? ` (${error.cause.message})` : '';
    const code = (error as { code?: string }).code;
    return `${error.message}${code && !error.message.includes(code) ? ` [${code}]` : ''}${cause}`.split('\n')[0]!;
  }
  return String(error);
}

/** Exponential backoff with full jitter: ~0.5s, 1s, 2s… capped at 8s. */
function backoff(attempt: number): number {
  const ceiling = Math.min(8000, 500 * 2 ** (attempt - 1));
  return ceiling / 2 + Math.random() * (ceiling / 2);
}

function limiter(max: number): <T>(task: () => Promise<T>) => Promise<T> {
  if (!Number.isFinite(max)) return (task) => task();
  let active = 0;
  const queue: (() => void)[] = [];
  return async (task) => {
    if (active >= max) await new Promise<void>((resolve) => queue.push(resolve));
    active++;
    try {
      return await task();
    } finally {
      active--;
      queue.shift()?.();
    }
  };
}
