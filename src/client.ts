import { assertSupportedActions, BrowserEngine, type BrowserOptions } from './engines/browser.ts';
import { runHttp, type EngineAttempt, type EngineResult } from './engines/http.ts';
import {
  domainUnreachable,
  invalidRequest,
  serverError,
  temporaryDownloadError,
  unprocessable,
  unsupported,
  UpstreamProblem,
  XyteError,
} from './errors.ts';
import { htmlToMarkdown } from './markdown.ts';
import { direct, isApiEndpoint, type AttemptOutcome, type ProxyContext, type ProxyProvider } from './proxy.ts';
import { SessionPool, type PooledSession, type SessionPoolOptions } from './sessions.ts';
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

export interface ExtractOptions {
  /** Aborts the request (all attempts). Rejects with the signal's reason. */
  signal?: AbortSignal;
  /** This request's warnings, in addition to the client's `onWarning`. */
  onWarning?: (message: string) => void;
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
   * field. Requests for a field without an extractor are rejected with a 400, except `markdown`,
   * which has a built-in (non-AI, like Zyte's) converter.
   */
  extractors?: Partial<Record<ExtractionField, Extractor>>;
  /** Server-managed sessions (`sessionContext`): pool size, max age, bans before retiring. */
  sessions?: SessionPoolOptions;
  /** Low-level HTTP sender; replace to add logging, or for tests. */
  transport?: Transport;
  /** Called before each retry. */
  onRetry?: (info: { attempt: number; url: string; reason: string }) => void;
  /**
   * Called after every attempt with the provider that served it (the one a combinator picked),
   * the outcome, latency and page size: per-provider success rates and costs, in your metrics.
   */
  onAttempt?: (info: AttemptInfo) => void;
  /**
   * When a plain HTTP request (GET, no body) is banned, retry it in a browser, which gets past
   * JavaScript challenges, and return the page's raw HTTP response as `httpResponseBody`, as
   * Zyte does when it picks a browser itself. Needs Playwright (or `browser.connect`). Default false.
   */
  browserFallback?: boolean;
  /**
   * Requests that run but not as asked, e.g. a `geolocation` the exit can't apply (`direct()`,
   * a plain proxy URL). Default: `console.warn`, once per distinct message.
   */
  onWarning?: (message: string, info: { url: string }) => void;
}

export interface AttemptInfo extends AttemptOutcome {
  url: string;
  /** 0 for the first try. */
  attempt: number;
  /** The provider that served the attempt: the leaf a combinator chose, e.g. `oxylabs-residential`. */
  provider: string;
  /** Rendered in a browser (requested, or `browserFallback`). */
  browser: boolean;
}

const warned = new Set<string>();
const warnOnce = (message: string): void => {
  if (warned.has(message) || warned.size > 1000) return;
  warned.add(message);
  console.warn(`[xyte] ${message}`);
};

const BROWSER_OUTPUTS = ['browserHtml', 'screenshot'] as const;
/** Client-managed sessions (`session.id`) remembered per process. */
const MAX_CLIENT_SESSIONS = 10_000;
const BROWSER_ONLY = ['actions', 'networkCapture', 'javascript', 'viewport', 'screenshotOptions', 'includeIframes'] as const;
const HTTP_ONLY = [
  'httpRequestMethod',
  'httpRequestBody',
  'httpRequestText',
  'customHttpRequestHeaders',
  'followRedirect',
] as const;

export class Xyte {
  private readonly proxy: ProxyProvider;
  private readonly retries: number;
  private readonly timeoutMs: number;
  private readonly isBan: (page: BanCheck) => boolean;
  private readonly browser: BrowserEngine;
  private readonly transport: Transport;
  private readonly sessions = new Map<string, CookieJar>();
  private readonly pool: SessionPool;
  private readonly limit: <T>(task: () => Promise<T>) => Promise<T>;

  constructor(private readonly options: XyteOptions = {}) {
    this.proxy = options.proxy ?? direct();
    this.retries = options.retries ?? 3;
    this.timeoutMs = (options.timeout ?? 60) * 1000;
    this.isBan = options.isBan === false ? () => false : (options.isBan ?? isLikelyBan);
    this.browser = new BrowserEngine(options.browser);
    this.transport = options.transport ?? defaultTransport;
    this.limit = limiter(options.concurrency ?? Number.POSITIVE_INFINITY);
    this.pool = new SessionPool(options.sessions);
  }

  /**
   * Same contract as `POST https://api.zyte.com/v1/extract`: resolves with the 200 body, rejects
   * with an `XyteError` carrying Zyte's status and problem type.
   */
  extract(request: ExtractRequest, options: ExtractOptions = {}): Promise<ExtractResponse> {
    return this.limit(async () => {
      options.signal?.throwIfAborted();
      return this.run(lenient(request), options);
    });
  }

  /** Closes the shared browser, if one was started. */
  close(): Promise<void> {
    return this.browser.close();
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await this.close();
  }

  private async run(request: ExtractRequest, options: ExtractOptions): Promise<ExtractResponse> {
    const cancel = options.signal;
    const plan = this.plan(request);
    const warnings = new Set<string>();
    const warn = (message: string) => {
      if (warnings.has(message)) return;
      warnings.add(message);
      if (this.options.onWarning) this.options.onWarning(message, { url: request.url });
      else warnOnce(message);
      options.onWarning?.(message);
    };
    const country = request.geolocation?.toUpperCase();
    const pinnedSession = request.session?.id;
    const poolKey = request.sessionContext ? SessionPool.key(request.sessionContext) : undefined;
    // Pooled sessions that failed this request: retries go through another one.
    const failedSessions = new Set<string>();
    let lastReason = 'unknown error';
    let lastCause: unknown;
    let lastWasBan = false;
    const requestId = randomSessionId();
    // browserFallback: after a ban, a plain GET goes on in a browser.
    let inBrowser = plan.browser;
    const canEscalate =
      this.options.browserFallback === true &&
      !plan.browser &&
      (request.httpRequestMethod ?? 'GET') === 'GET' &&
      request.httpRequestBody == null &&
      request.httpRequestText == null &&
      request.followRedirect !== false;

    for (let attempt = 0; attempt <= this.retries; attempt++) {
      if (attempt > 0) {
        this.options.onRetry?.({ attempt, url: request.url, reason: lastReason });
        await sleep(backoff(attempt));
        cancel?.throwIfAborted();
      }

      // A server-managed session (sessionContext) comes from the pool; a ban counts against it.
      const pooled = poolKey ? this.pool.acquire(poolKey, failedSessions) : undefined;
      let outcome: 'ok' | 'ban' = 'ban';
      const started = Date.now();
      const escalated = inBrowser && !plan.browser;
      const context: ProxyContext = {
        url: new URL(request.url),
        country,
        ipType: request.ipType,
        sessionId: pooled?.id ?? pinnedSession ?? randomSessionId(),
        attempt,
        browser: inBrowser,
        requestId,
        path: [],
      };
      // The attempt's verdict on the provider, reported in the finally below.
      let verdict: Omit<AttemptOutcome, 'ms'> = { result: 'aborted' };
      let resolved = false;
      try {
        const timeout = AbortSignal.timeout(this.timeoutMs);
        const signal = cancel ? AbortSignal.any([timeout, cancel]) : timeout;

        let jar: CookieJar;
        let result: EngineResult;
        let trusted = false;
        let direct = true;
        try {
          if (pooled) {
            pooled.ready ??= this.initSession(request, pooled, context, signal);
            await pooled.ready.catch((error) => {
              this.pool.discard(poolKey!, pooled);
              throw error;
            });
          }
          jar = pooled ? new CookieJar(pooled.jar.all()) : this.jarFor(request, pinnedSession);
          resolved = true;
          const endpoint = await Promise.resolve()
            .then(() => this.proxy.resolve(context))
            .catch((error: unknown) => {
              // A provider's own answer (a spent budget's 429) as is; anything else means it is
              // misconfigured, and retrying won't help.
              if (error instanceof XyteError) throw error;
              throw serverError(`proxy provider "${this.proxy.name}" failed: ${describe(error)}`, error);
            });
          direct = endpoint == null;
          const remoteBrowser = plan.browser && this.options.browser?.connect != null;
          if (country && !isApiEndpoint(endpoint) && !remoteBrowser && (endpoint == null || endpoint.appliesCountry === false)) {
            warn(
              `geolocation "${country}" not applied: ${endpoint == null ? 'requests exit directly from this machine' : 'the proxy URL has no country parameter'} (provider "${this.proxy.name}")`,
            );
          }
          if (isApiEndpoint(endpoint)) {
            // A scraping API takes the whole request (it renders, solves and proxies itself).
            const answer = await endpoint.api(request, { context, signal });
            result = { response: answer.response, statusCode: answer.statusCode, headers: answer.headers ?? [], html: answer.html };
            trusted = answer.trusted === true;
          } else {
            const engineAttempt: EngineAttempt = { request, context, proxy: endpoint, jar, signal };
            result = inBrowser ? await this.browser.run(engineAttempt) : await runHttp(engineAttempt, this.transport);
          }
        } catch (error) {
          if (escalated && error instanceof XyteError && error.status === 500) {
            // No browser to fall back to (Playwright missing): go on over HTTP.
            warn(`browserFallback skipped: ${error.detail ?? error.message}`);
            inBrowser = false;
            lastReason = 'ban detected; no browser for browserFallback';
            continue;
          }
          if (error instanceof XyteError) throw error;
          if (cancel?.aborted) throw cancel.reason;
          const classified = classifyError(error, { direct, host: context.url.hostname });
          if (classified === 'unreachable') {
            throw domainUnreachable(`could not resolve ${new URL(request.url).hostname}`, error);
          }
          lastReason = describe(error);
          lastCause = error;
          // An upstream API's ban (Zyte's /download/website-ban) is a ban, not a provider failure.
          lastWasBan = error instanceof UpstreamProblem && error.problem.type.includes('ban');
          verdict = { result: lastWasBan ? 'ban' : 'error', reason: lastReason };
          continue;
        }

        const page = { statusCode: result.statusCode, bytes: result.html ? new TextEncoder().encode(result.html).byteLength : undefined };

        if (!trusted && this.isBan({ url: result.response.url ?? request.url, statusCode: result.statusCode, headers: result.headers, html: result.html })) {
          lastReason = `ban detected (HTTP ${result.statusCode})${escalated ? ' in the browser' : ''}`;
          lastCause = undefined;
          lastWasBan = true;
          verdict = { result: 'ban', reason: lastReason, ...page };
          if (canEscalate) inBrowser = true;
          continue;
        }

        outcome = 'ok';
        verdict = { result: 'ok', ...page };
        // Merge, not replace: parallel requests on one session each add their cookies.
        if (pooled) pooled.jar.merge(jar);
        else if (pinnedSession) this.rememberSession(pinnedSession, jar);
        return this.finish(request, plan, result, jar);
      } finally {
        if (pooled) {
          this.pool.release(pooled, outcome);
          if (outcome === 'ban') failedSessions.add(pooled.id);
        }
        if (resolved) {
          const report: AttemptOutcome = { ...verdict, ms: Date.now() - started };
          this.proxy.report?.(context, report);
          this.options.onAttempt?.({
            ...report,
            url: request.url,
            attempt,
            provider: context.path?.at(-1) ?? this.proxy.name,
            browser: context.browser,
          });
        }
      }
    }

    // The upstream API's own last answer (Zyte's 520 /download/website-ban…), as Zyte gave it.
    if (lastCause instanceof UpstreamProblem) throw new XyteError(lastCause.problem, { cause: lastCause });
    throw temporaryDownloadError(`${lastReason} after ${this.retries + 1} attempts`, {
      ban: lastWasBan,
      cause: lastCause,
    });
  }

  /**
   * Runs `sessionContextParameters.actions` once for a new pooled session, in a browser at the
   * request URL, through the session's sticky exit. Its cookies seed the session.
   */
  private async initSession(
    request: ExtractRequest,
    session: PooledSession,
    context: ProxyContext,
    signal: AbortSignal,
  ): Promise<void> {
    const actions = request.sessionContextParameters?.actions;
    if (!actions?.length) return;
    // Its own request id: the init's resolve is reported apart from the attempt's.
    const initContext = { ...context, browser: true, requestId: `${context.requestId}:init`, path: [] };
    const started = Date.now();
    let result: AttemptOutcome['result'] = 'aborted';
    try {
      const proxy = await this.proxy.resolve(initContext);
      // A scraping API keeps its own sessions; there is no local browser to initialize.
      if (isApiEndpoint(proxy)) return;
      result = 'error';
      await this.browser.run({
        request: { url: request.url, browserHtml: true, actions, device: request.device },
        context: initContext,
        proxy,
        jar: session.jar,
        signal,
      });
      result = 'ok';
    } finally {
      this.proxy.report?.(initContext, { result, ms: Date.now() - started });
    }
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

    if (request.sessionContext) assertSupportedActions(request.sessionContextParameters?.actions);

    const extractions = EXTRACTION_FIELDS.filter((field) => request[field] != null && request[field] !== false);
    if (request.markdown && (request.serp || request.customAttributes)) {
      throw unprocessable('markdown cannot be combined with serp or customAttributes');
    }
    for (const field of extractions) {
      // Zyte's markdown is non-AI: built in, unless an extractor overrides it.
      if (field === 'markdown') continue;
      if (!this.options.extractors?.[field] && !this.proxy.extracts) {
        throw unsupported(`"${field}" without an extractor (pass one in \`extractors.${field}\`)`);
      }
    }

    const wantsBrowser = BROWSER_OUTPUTS.some((field) => request[field] === true);
    if (wantsBrowser && request.httpResponseBody) {
      throw unprocessable('httpResponseBody cannot be combined with browserHtml or screenshot');
    }
    if (request.httpRequestBody != null && request.httpRequestText != null) {
      throw unprocessable('httpRequestBody and httpRequestText cannot be combined');
    }
    const probe = new Headers();
    for (const { name, value } of [
      ...(request.customHttpRequestHeaders ?? []),
      ...(request.requestHeaders?.referer != null ? [{ name: 'referer', value: request.requestHeaders.referer }] : []),
    ]) {
      try {
        probe.set(String(name), String(value));
      } catch {
        throw invalidRequest(`invalid HTTP header ${JSON.stringify(name)}`);
      }
    }

    // Extraction alone picks its source from `<field>Options.extractFrom`, else HTTP.
    const extractFromBrowser = extractions.some((field) => {
      const from =
        (request as unknown as Record<string, { extractFrom?: string } | undefined>)[`${field}Options`]?.extractFrom ??
        request.extractFrom;
      return from === 'browserHtml' || from === 'browserHtmlOnly';
    });

    const browser = wantsBrowser || (!request.httpResponseBody && extractFromBrowser);
    if (browser) {
      for (const field of HTTP_ONLY) {
        if (request[field] != null) throw unprocessable(`"${field}" can only be used with httpResponseBody`);
      }
      assertSupportedActions(request.actions);
    } else {
      for (const field of BROWSER_ONLY) {
        if (request[field] != null) throw unprocessable(`"${field}" requires browserHtml or screenshot`);
      }
      const hasOutput =
        request.httpResponseBody || request.httpResponseHeaders || request.responseCookies || extractions.length > 0;
      if (!hasOutput) {
        throw unprocessable('no output requested: set httpResponseBody, browserHtml, screenshot or an extraction field');
      }
    }
    return { browser, extractions };
  }

  private rememberSession(sessionId: string, jar: CookieJar): void {
    const existing = this.sessions.get(sessionId);
    if (existing) {
      existing.merge(jar);
      this.sessions.delete(sessionId);
    }
    this.sessions.set(sessionId, existing ?? jar);
    // Bounded: the least recently used sessions are forgotten first.
    while (this.sessions.size > MAX_CLIENT_SESSIONS) this.sessions.delete(this.sessions.keys().next().value!);
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
      // Already answered upstream (e.g. Zyte API itself as the provider).
      if ((response as Record<string, unknown>)[field] !== undefined) continue;
      const extractor = this.options.extractors?.[field] ?? (field === 'markdown' ? builtInMarkdown : undefined);
      // The provider was expected to extract (see ProxyProvider.extracts) but this one didn't.
      if (!extractor) throw unsupported(`"${field}" without an extractor (pass one in \`extractors.${field}\`)`);
      (response as Record<string, unknown>)[field] = await extractor({
        url: response.url ?? request.url,
        html: result.html ?? '',
        request,
        options: (request as Record<string, unknown>)[`${field}Options`],
      });
    }
    if (request.responseCookies) response.responseCookies = jar.all();
    if (request.session?.id) response.session = { id: request.session.id };
    if (request.echoData !== undefined) response.echoData = request.echoData;
    if (request.jobId != null) response.jobId = request.jobId;
    return response;
  }
}

const builtInMarkdown: Extractor = ({ html, url, options }) =>
  htmlToMarkdown(html, { url, scope: (options as { scope?: 'mainContent' | 'fullPage' } | undefined)?.scope });

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
/**
 * What Zyte quietly ignores instead of rejecting (checked against api.zyte.com): a Cookie header
 * in `customHttpRequestHeaders` (cookies go in `requestCookies`), `sessionContext` next to
 * `session` (the client-managed session wins), an empty `sessionContext`, and
 * `sessionContextParameters` without a context.
 */
function lenient(request: ExtractRequest): ExtractRequest {
  const { sessionContext, sessionContextParameters, customHttpRequestHeaders, ...rest } = request;
  return {
    ...rest,
    ...(customHttpRequestHeaders && {
      customHttpRequestHeaders: customHttpRequestHeaders.filter((h) => String(h.name).toLowerCase() !== 'cookie'),
    }),
    ...(!request.session && sessionContext?.length ? { sessionContext, sessionContextParameters } : {}),
  };
}

export function isLikelyBan(page: BanCheck): boolean {
  if (BAN_STATUSES.has(page.statusCode)) return true;
  const html = page.html;
  if (!html || html.length > 512 * 1024) return false;
  return CHALLENGE_MARKERS.some((marker) => marker.test(html));
}

/**
 * Only a direct connection's failure to resolve the *target* is a 421. Through a proxy, a DNS
 * error is about the proxy's own host (a typo, an outage): retried, so `rotate()` moves on.
 */
function classifyError(error: unknown, target: { direct: boolean; host: string }): 'unreachable' | 'retry' {
  if (!target.direct) return 'retry';
  const text = describe(error);
  if (!/ENOTFOUND|ERR_NAME_NOT_RESOLVED|DNS.*not.*found/i.test(text)) return 'retry';
  const hostOf = (e: unknown) => (e as { hostname?: string } | undefined)?.hostname;
  const failedHost = hostOf(error) ?? hostOf((error as { cause?: unknown })?.cause);
  return failedHost == null || failedHost === target.host || text.includes(target.host) ? 'unreachable' : 'retry';
}

function describe(error: unknown): string {
  if (error instanceof Error) {
    // The root cause: undici nests a proxy's 407 as fetch failed → "Request was cancelled" →
    // "Proxy response (407) !== 200 when HTTP Tunneling".
    let root: unknown = error.cause;
    for (let depth = 0; root instanceof Error && root.cause instanceof Error && depth < 5; depth++) root = root.cause;
    const cause = root instanceof Error ? ` (${root.message})` : '';
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
