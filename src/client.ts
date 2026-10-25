import { assertActionHandlers, classifyActions, type ActionHandlers, type ZyteOnlyAction } from './actions.ts';
import { BrowserEngine, type BrowserOptions } from './engines/browser.ts';
import { ResponseCache, type CacheOptions } from './cache.ts';
import { Pacer, type RateLimits } from './pace.ts';
import { BROWSER_ONLY, BROWSER_OUTPUTS, HTTP_ONLY } from './fields.ts';
import { runHttp, type EngineAttempt, type EngineResult } from './engines/http.ts';
import {
  type XyteProblem,
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
import { EXTRACTION_FIELDS, type Action, type ExtractionField, type ExtractRequest, type ExtractResponse } from './types.ts';
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
  /** This request's report once it's done, in addition to the client's `onRequest`. */
  onReport?: (report: RequestReport) => void;
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
   * Handlers for Zyte's own actions outside Zyte: `searchKeyword` (default: a heuristic that
   * finds the search box), `setLocation` (per site), `interaction` (scripts by id). With
   * `zyteApi()` as the provider, Zyte runs them instead.
   */
  actions?: ActionHandlers;
  /**
   * What happens to an action that can't run where the attempt landed: a Zyte-only action with
   * no handler on a local-browser provider (proxies, `direct()`, remote browsers), or any action
   * on an HTML-only API (Scrappey, ScrapingBot), once there's no provider to pass over to.
   * `warn` (default) skips it (`notExecuted` in the response's `actions`, plus a warning) and runs
   * the rest; `error` passes over to `zyteApi()` when a combinator has it, else rejects with a
   * 400; `zyte` passes over to `zyteApi()` when a combinator has it (the built-in search
   * heuristic's actions too), else like `warn`. Actions you have a handler for always run locally.
   * See docs/actions.md.
   */
  unsupportedActions?: 'warn' | 'error' | 'zyte';
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
   * Called once per `extract()`, success or failure, with what it took: every attempt (provider,
   * route, result, latency, bytes), totals per provider, and the outcome. For logs, metrics and
   * analytics; the response itself stays Zyte's.
   */
  onRequest?: (report: RequestReport) => void;
  /**
   * Keep responses for a while and answer repeats from them (and let identical requests in flight
   * share one run): `{ ttl: 3600 }`, or per site `{ ttl: { 'wolt.com': 600, '*': 3600 } }`.
   * Requests with a `session` or `sessionContext` are never cached. Off by default.
   */
  cache?: CacheOptions;
  /**
   * How fast, and how many at once, attempts go to each site: `{ 'yelp.co.uk': '2/s', '*': '10/s' }`
   * (each site under `'*'` on its own), or `{ rate, per, concurrency }`. Per process. Off by default.
   */
  rateLimits?: RateLimits;
  /**
   * Your prices, per provider (its name, or a prefix: `oxylabs` covers `oxylabs-residential`):
   * `{ oxylabs: { perGB: 6 }, 'zyte-api': { perRequest: 0.0013 } }`. Attempts and reports then
   * carry `costUsd`. Plans and volume discounts differ, so there are no built-in prices.
   */
  rates?: Rates;
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
  /** The `extract()` call it belongs to (same id as its `RequestReport`). */
  requestId: string;
  url: string;
  /** 0 for the first try. */
  attempt: number;
  /** The combinators' choices down to `provider`, outermost first, e.g. `['rotate(oxylabs-residential,zyte-api)', 'zyte-api']`. */
  path: string[];
  /** The provider that served the attempt: the leaf a combinator chose, e.g. `oxylabs-residential`. */
  provider: string;
  /** Rendered in a browser (requested, or `browserFallback`). */
  browser: boolean;
  /** The request's `tags` (as on Zyte, e.g. `{ spider: 'yelp' }`), to group attempts by in metrics. */
  tags?: ExtractRequest['tags'];
  /** With `rates`: what this attempt cost, in USD. */
  costUsd?: number;
}

/** What a provider costs you. All in USD; any combination. */
export interface Rate {
  /** Per GB on the wire (`transferBytes`): residential and datacenter proxies. */
  perGB?: number;
  /** Per attempt that got an answer (`ok` or `ban`): APIs that bill every request. */
  perRequest?: number;
  /** Per `ok` attempt only: APIs that bill successful requests. */
  perSuccess?: number;
}

export type Rates = Readonly<Record<string, Rate>>;

/** The rate for a provider: its exact name, else the longest key it starts with (`oxylabs` → `oxylabs-residential`). */
export function rateFor(rates: Rates, provider: string): Rate | undefined {
  if (rates[provider]) return rates[provider];
  const key = Object.keys(rates)
    .filter((k) => provider.startsWith(`${k}-`))
    .sort((a, b) => b.length - a.length)[0];
  return key ? rates[key] : undefined;
}

/** What one attempt cost at `rate`. Errors and pass-overs got no answer: nothing to bill. */
export function attemptCost(rate: Rate | undefined, attempt: Pick<AttemptOutcome, 'result' | 'transferBytes'>): number {
  if (!rate || (attempt.result !== 'ok' && attempt.result !== 'ban')) return 0;
  return (
    ((attempt.transferBytes ?? 0) / 1e9) * (rate.perGB ?? 0) + (rate.perRequest ?? 0) + (attempt.result === 'ok' ? (rate.perSuccess ?? 0) : 0)
  );
}

/** Attempts and bytes of one provider within a request (or across reports, summed). */
export interface ProviderUsage {
  attempts: number;
  ok: number;
  ban: number;
  error: number;
  aborted: number;
  /** Bytes on the wire (`transferBytes`), summed. */
  transferBytes: number;
  /** Time spent in its attempts, summed. */
  ms: number;
  /** With `rates`: what its attempts cost, in USD. */
  costUsd?: number;
}

/** What one `extract()` took and how it ended: `onRequest` / `onReport`. */
export interface RequestReport {
  requestId: string;
  url: string;
  host: string;
  /** The request's `tags` (Zyte's way to label requests for its stats), for grouping reports. */
  tags?: ExtractRequest['tags'];
  /** The request's `jobId`, if it had one. */
  jobId?: string;
  /** `ok`: a response came back (the target's own 4xx/5xx included); `error`: an `XyteError`; `aborted`: cancelled. */
  outcome: 'ok' | 'error' | 'aborted';
  /** The target's status, when a response came back. */
  statusCode?: number;
  /** The problem it failed with. */
  error?: XyteProblem;
  /** The provider that served the response (the last attempt's). */
  provider?: string;
  /** The last attempt rendered in a browser. */
  browser: boolean;
  /** `browserFallback` moved it from HTTP to a browser. */
  escalated: boolean;
  /** Milliseconds waiting for a `concurrency` slot, then working. */
  queuedMs: number;
  /**
   * With `cache`: `hit` (answered from the cache: no attempts), `shared` (an identical request
   * in flight answered it), or `miss` (fetched, and stored if cacheable).
   */
  cache?: 'hit' | 'shared' | 'miss';
  ms: number;
  attempts: AttemptInfo[];
  /** Totals over the attempts. */
  transferBytes: number;
  /** With `rates`: what the request cost, in USD (0 for a cache hit). */
  costUsd?: number;
  byProvider: Record<string, ProviderUsage>;
  warnings: string[];
}

/** Per-request bookkeeping that ends up in the `RequestReport`. */
interface Trace {
  requestId: string;
  attempts: AttemptInfo[];
  warnings: string[];
}

/** Sums attempts per provider. */
export function usageByProvider(attempts: readonly AttemptInfo[]): Record<string, ProviderUsage> {
  const usage: Record<string, ProviderUsage> = {};
  for (const a of attempts) {
    const u = (usage[a.provider] ??= { attempts: 0, ok: 0, ban: 0, error: 0, aborted: 0, transferBytes: 0, ms: 0 });
    u.attempts++;
    u[a.result]++;
    u.transferBytes += a.transferBytes ?? 0;
    u.ms += a.ms;
    if (a.costUsd !== undefined) u.costUsd = (u.costUsd ?? 0) + a.costUsd;
  }
  return usage;
}

const warned = new Set<string>();
const warnOnce = (message: string): void => {
  if (warned.has(message) || warned.size > 1000) return;
  warned.add(message);
  console.warn(`[xyte] ${message}`);
};

/** Providers passed over in one request (see docs/actions.md#pass-overs), at most. */
const MAX_PASS_OVERS = 10;
/** Client-managed sessions (`session.id`) remembered per process. */
const MAX_CLIENT_SESSIONS = 10_000;

export class Xyte {
  private readonly proxy: ProxyProvider;
  private readonly retries: number;
  private readonly timeoutMs: number;
  private readonly isBan: (page: BanCheck) => boolean;
  private readonly browser: BrowserEngine;
  private readonly transport: Transport;
  private readonly sessions = new Map<string, CookieJar>();
  private readonly pool: SessionPool;
  private readonly cache: ResponseCache | undefined;
  private readonly pacer: Pacer | undefined;
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
    this.cache = options.cache ? new ResponseCache(options.cache) : undefined;
    this.pacer = options.rateLimits ? new Pacer(options.rateLimits) : undefined;
  }

  /**
   * Same contract as `POST https://api.zyte.com/v1/extract`: resolves with the 200 body, rejects
   * with an `XyteError` carrying Zyte's status and problem type.
   */
  extract(request: ExtractRequest, options: ExtractOptions = {}): Promise<ExtractResponse> {
    const ttl = this.cache?.ttlFor(request) ?? 0;
    if (!this.cache || ttl <= 0) return this.extractNow(request, options);
    const queued = Date.now();
    return this.cache
      .through(request, ttl, () => this.extractNow(request, options))
      .then(({ response, how }) => {
        // A miss was reported by the run itself; a hit or a shared run gets its own report.
        if (how !== 'miss') this.report(request, options, { requestId: randomSessionId(), attempts: [], warnings: [] }, { queued, started: queued, response, aborted: false, cache: how });
        return response;
      });
  }

  private extractNow(request: ExtractRequest, options: ExtractOptions): Promise<ExtractResponse> {
    const queued = Date.now();
    const trace: Trace = { requestId: randomSessionId(), attempts: [], warnings: [] };
    return this.limit(async () => {
      const started = Date.now();
      let response: ExtractResponse | undefined;
      let failure: unknown;
      try {
        options.signal?.throwIfAborted();
        response = await this.run(lenient(request), options, trace);
        return response;
      } catch (error) {
        failure = error;
        throw error;
      } finally {
        this.report(request, options, trace, {
          queued,
          started,
          response,
          failure,
          aborted: options.signal?.aborted === true,
          cache: this.cache && this.cache.ttlFor(request) > 0 ? 'miss' : undefined,
        });
      }
    });
  }

  private report(request: ExtractRequest, options: ExtractOptions, trace: Trace, end: ReportEnd): void {
    if (this.options.onRequest == null && options.onReport == null) return;
    const report = buildReport(request, trace, { ...end, rated: this.options.rates != null });
    this.options.onRequest?.(report);
    options.onReport?.(report);
  }

  /** Closes the shared browser, if one was started. */
  close(): Promise<void> {
    return this.browser.close();
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await this.close();
  }

  private async run(request: ExtractRequest, options: ExtractOptions, trace: Trace): Promise<ExtractResponse> {
    const cancel = options.signal;
    const plan = this.plan(request);
    const warnings = new Set<string>();
    const warn = (message: string) => {
      if (warnings.has(message)) return;
      warnings.add(message);
      trace.warnings.push(message);
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
    const { requestId } = trace;
    // browserFallback: after a ban, a plain GET goes on in a browser.
    let inBrowser = plan.browser;
    const canEscalate =
      this.options.browserFallback === true &&
      !plan.browser &&
      (request.httpRequestMethod ?? 'GET') === 'GET' &&
      request.httpRequestBody == null &&
      request.httpRequestText == null &&
      request.followRedirect !== false;

    // Pass-overs (a provider skipped because it can't serve the request as configured: your action
    // handlers, Zyte's own actions, what an HTML-only API can't do) make no request, so they don't
    // use up retries: only real attempts count. A route that never leads to a suitable provider
    // would pass over forever, hence the caps.
    let passedOver = false;
    let passOvers = 0;
    let passOversInARow = 0;
    let real = 0;
    for (let attempt = 0; ; attempt++) {
      if (attempt > 0) {
        if (passedOver) passOversInARow++;
        else {
          real++;
          passOversInARow = 0;
        }
      }
      if (real > this.retries) break;
      // A provider passed over (below) made no request: not a retry, nothing to back off from.
      if (attempt > 0 && !passedOver) {
        this.options.onRetry?.({ attempt, url: request.url, reason: lastReason });
        await sleep(backoff(attempt));
        cancel?.throwIfAborted();
      }
      passedOver = false;

      // A server-managed session (sessionContext) comes from the pool; a ban counts against it.
      const pooled = poolKey ? this.pool.acquire(poolKey, failedSessions) : undefined;
      // 'skip': passed over, no request, so no verdict on the pooled session either.
      let outcome: 'ok' | 'ban' | 'skip' = 'ban';
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
      // The site's rateLimits slot, held for the attempt's network call.
      let releaseSlot: (() => void) | undefined;
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
          // Inside a combinator, an attempt that can't run the request's actions the way they're
          // configured can be passed over for the next provider: no request, no retry spent.
          const leaf = context.path?.at(-1) ?? this.proxy.name;
          const canPassOver = (context.path?.length ?? 0) > 0 && passOvers < MAX_PASS_OVERS && passOversInARow < 3;
          const passOver = (reason: string) => {
            passedOver = true;
            outcome = 'skip';
            passOvers++;
            lastReason = reason;
            verdict = { result: 'aborted', reason };
          };
          const zyteOnly = inBrowser ? classifyActions(request.actions, this.actionHandlers, context.url) : { own: [], builtIn: [], none: [] };
          const mode = this.options.unsupportedActions ?? 'warn';
          if (isApiEndpoint(endpoint)) {
            // Your handlers run in xyte's browser, which an API (Zyte's included) doesn't use: look
            // for a provider that runs them. With nothing else to go to, the API gets the request
            // as is (Zyte then runs its own version), and you hear about it.
            // The same for what the API says it can't do (actions, screenshots… on an HTML-only API).
            const own = zyteOnly.own[0];
            const cannot = endpoint.unsupported?.(request) ?? [];
            if ((own || cannot.length > 0) && canPassOver) {
              passOver(own ? `"${own.action}" has your handler: passed over ${leaf}` : `${leaf} can't do ${cannot.join(', ')}: passed over`);
              continue;
            }
            const sent = this.apiRequest(request, { leaf, cannot, own: zyteOnly.own, mode, warn });
            // A scraping API takes the whole request (it renders, solves and proxies itself).
            releaseSlot = await this.pacer?.acquire(request.url, signal);
            const answer = await endpoint.api(sent.request, { context, signal });
            if (sent.dropped.size > 0) answer.response.actions = mergeActionResults(request.actions ?? [], answer.response.actions, sent.dropped);
            result = { response: answer.response, statusCode: answer.statusCode, headers: answer.headers ?? [], html: answer.html };
            trusted = answer.trusted === true;
          } else {
            // Here Zyte's own actions run through local handlers. Those you didn't write a handler for
            // can go to zyteApi() if a combinator has it: 'zyte' sends them all (the built-in search
            // heuristic included), 'error' the ones nothing here can run, rather than failing.
            const forZyte = mode === 'zyte' ? [...zyteOnly.builtIn, ...zyteOnly.none] : mode === 'error' ? zyteOnly.none : [];
            if (forZyte.length > 0 && this.proxy.zyteActions && canPassOver) {
              passOver(`"${forZyte[0]!.action}" has no handler of yours: passed over ${leaf} for Zyte`);
              continue;
            }
            if (zyteOnly.none.length > 0 && mode === 'error') assertActionHandlers(request.actions, this.actionHandlers, context.url);
            const engineAttempt: EngineAttempt = { request, context, proxy: endpoint, jar, signal, actions: this.actionsFor(warn) };
            releaseSlot = await this.pacer?.acquire(request.url, signal);
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

        const page = {
          statusCode: result.statusCode,
          bytes: result.html ? new TextEncoder().encode(result.html).byteLength : undefined,
          transferBytes: result.transferBytes,
        };

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
        releaseSlot?.();
        if (pooled) {
          this.pool.release(pooled, outcome === 'ban' ? 'ban' : 'ok');
          if (outcome === 'ban') failedSessions.add(pooled.id);
        }
        if (resolved) {
          const report: AttemptOutcome = { ...verdict, ms: Date.now() - started };
          this.proxy.report?.(context, report);
          const info: AttemptInfo = {
            ...report,
            requestId,
            url: request.url,
            attempt,
            provider: context.path?.at(-1) ?? this.proxy.name,
            path: context.path ?? [],
            browser: context.browser,
            ...(request.tags && { tags: request.tags }),
          };
          if (this.options.rates) info.costUsd = attemptCost(rateFor(this.options.rates, info.provider), info);
          trace.attempts.push(info);
          this.options.onAttempt?.(info);
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
      if (this.strictActions) assertActionHandlers(actions, this.actionHandlers, initContext.url);
      result = 'error';
      await this.browser.run({
        request: { url: request.url, browserHtml: true, actions, device: request.device },
        context: initContext,
        proxy,
        jar: session.jar,
        signal,
        actions: this.actionsFor((message) => (this.options.onWarning ? this.options.onWarning(message, { url: request.url }) : warnOnce(message))),
      });
      result = 'ok';
    } finally {
      this.proxy.report?.(initContext, { result, ms: Date.now() - started });
    }
  }

  /**
   * What goes to an API provider when nothing better is left: outputs it can't produce are a
   * 400; actions it can't run, and your `interaction` scripts (which exist only in your handlers,
   * so Zyte would answer "script not found" and stop the actions after them), are left out and
   * reported `notExecuted` in their place, or a 400 with `unsupportedActions: 'error'`.
   */
  private apiRequest(
    request: ExtractRequest,
    { leaf, cannot, own, mode, warn }: { leaf: string; cannot: readonly string[]; own: ZyteOnlyAction[]; mode: string; warn: (message: string) => void },
  ): { request: ExtractRequest; dropped: Map<number, string> } {
    const outputs = cannot.filter((what) => what !== 'actions');
    if (outputs.length > 0) throw invalidRequest(`${leaf} can't return ${outputs.join(' or ')}: use a provider with a local browser, or zyteApi()`);
    const dropped = new Map<number, string>();
    const actions = request.actions ?? [];
    if (cannot.includes('actions')) {
      if (mode === 'error') throw invalidRequest(`${leaf} doesn't run actions: use a provider with a local browser, or zyteApi()`);
      actions.forEach((_, i) => dropped.set(i, `${leaf} doesn't run actions: skipped`));
      warn(`actions skipped: ${leaf} doesn't run them (use a provider with a local browser, or unsupportedActions: 'error' to reject)`);
    } else {
      actions.forEach((action, i) => {
        if (action.action !== 'interaction' || !own.includes(action)) return;
        if (mode === 'error') {
          throw invalidRequest(`the "interaction" script "${action.id}" runs only in a local browser (your handler) and ${leaf} has none: use a provider with one, e.g. zyteProxy() for Zyte's IPs`);
        }
        dropped.set(i, `script "${action.id}" runs only in a local browser (your handler): not sent to ${leaf}`);
        warn(`interaction "${action.id}" not run: your script needs a local browser and ${leaf} has none (zyteProxy() gives Zyte's IPs with xyte's browser)`);
      });
      for (const handed of own.filter((action) => action.action !== 'interaction')) {
        warn(`your "${handed.action}" handler isn't used: the request went to ${leaf}, which runs its own (no provider with a local browser to go to)`);
      }
    }
    if (dropped.size === 0) return { request, dropped };
    return { request: { ...request, actions: actions.filter((_, i) => !dropped.has(i)) }, dropped };
  }

  private get actionHandlers(): ActionHandlers {
    return this.options.actions ?? {};
  }

  private get strictActions(): boolean {
    return this.options.unsupportedActions === 'error';
  }

  /** What the browser does with Zyte's own actions: run their handler, or warn and skip. */
  private actionsFor(warn: (message: string) => void): EngineAttempt['actions'] {
    return {
      handlers: this.actionHandlers,
      onMissing: (action: ZyteOnlyAction) =>
        warn(
          `"${action.action}"${action.action === 'interaction' ? ` (script "${action.id}")` : ''} skipped: no handler outside Zyte (set actions.${action.action}, route the site to zyteApi(), or unsupportedActions: 'error' to reject)`,
        ),
    };
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

    // Zyte's own actions run only where Zyte runs them (zyteApi()); checked per attempt then.
    if (request.sessionContext && this.strictActions && !this.proxy.zyteActions) {
      assertActionHandlers(request.sessionContextParameters?.actions, this.actionHandlers, url);
    }

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
      if (this.strictActions && !this.proxy.zyteActions) assertActionHandlers(request.actions, this.actionHandlers, url);
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
/** The API's results for the actions it got, with the ones left out back in their places. */
function mergeActionResults(
  actions: readonly Action[],
  results: ExtractResponse['actions'],
  dropped: ReadonlyMap<number, string>,
): NonNullable<ExtractResponse['actions']> {
  const answered = [...(results ?? [])];
  return actions.flatMap((action, i) => {
    if (dropped.has(i)) return [{ action: action.action, elapsedTime: 0, status: 'notExecuted' as const, error: dropped.get(i) }];
    const result = answered.shift();
    return result ? [result] : [];
  });
}

/** How a request ended, for its report. */
interface ReportEnd {
  queued: number;
  started: number;
  response?: ExtractResponse;
  failure?: unknown;
  aborted: boolean;
  cache?: RequestReport['cache'];
  /** `rates` are set: report costs. */
  rated?: boolean;
}

function buildReport(request: ExtractRequest, trace: Trace, end: ReportEnd): RequestReport {
  const last = trace.attempts.at(-1);
  const host = (() => {
    try {
      return new URL(request.url).hostname;
    } catch {
      return '';
    }
  })();
  const error =
    end.failure instanceof XyteError
      ? end.failure.toJSON()
      : end.failure !== undefined
        ? { status: 500, type: '/server/internal', title: 'Internal Server Error', detail: describe(end.failure) }
        : undefined;
  return {
    requestId: trace.requestId,
    url: request.url,
    host,
    ...(request.tags && { tags: request.tags }),
    ...(request.jobId != null && { jobId: request.jobId }),
    outcome: end.response ? 'ok' : end.aborted ? 'aborted' : 'error',
    statusCode: end.response?.statusCode,
    error: end.aborted ? undefined : error,
    provider: end.response ? last?.provider : undefined,
    browser: last?.browser ?? false,
    escalated: trace.attempts.some((a) => a.browser) && trace.attempts.some((a) => !a.browser),
    queuedMs: end.started - end.queued,
    ms: Date.now() - end.started,
    attempts: trace.attempts,
    transferBytes: trace.attempts.reduce((sum, a) => sum + (a.transferBytes ?? 0), 0),
    ...(end.rated && { costUsd: trace.attempts.reduce((sum, a) => sum + (a.costUsd ?? 0), 0) }),
    byProvider: usageByProvider(trace.attempts),
    warnings: trace.warnings,
    ...(end.cache && { cache: end.cache }),
  };
}

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
