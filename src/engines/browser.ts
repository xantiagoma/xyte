import type {
  Browser,
  BrowserContext,
  BrowserContextOptions,
  LaunchOptions,
  Locator,
  Page,
  Response as PwResponse,
} from 'playwright';
import { serverError, unsupported, XyteError } from '../errors.ts';
import type { ProxyContext, ProxyEndpoint } from '../proxy.ts';
import type { Action, ActionResult, ActionSelector, CapturedResponse, Cookie, NetworkCaptureFilter } from '../types.ts';
import type { ZyteSchemas } from '../types.ts';

type InteractionLogEntry = ZyteSchemas['InteractionLogEntry'];
import { MAX_BODY_BYTES, matchUrl, sleep, toBase64, userAgent, type MatchType } from '../util.ts';
import { handlerFor, isZyteOnlyAction, type ZyteOnlyAction } from '../actions.ts';
import { isRedirect, type EngineAttempt, type EngineResult } from './http.ts';

/**
 * The part of a Playwright `BrowserType` xyte uses. Typed loosely on purpose: forks (patchright,
 * rebrowser-playwright…) declare their own, nominally different, Browser types.
 */
export interface BrowserTypeLike {
  launch(options?: any): Promise<unknown>;
  connect(wsEndpoint: string, options?: any): Promise<unknown>;
  connectOverCDP(endpointURL: string, options?: any): Promise<unknown>;
}

/** A remote browser to render one request in. */
export interface RemoteBrowser {
  /** `wss://…` (or `http://…` for CDP discovery). */
  endpoint: string;
  /** `cdp` (default) for `connectOverCDP`, `playwright` for a Playwright server (`connect`). */
  protocol?: 'cdp' | 'playwright';
  headers?: Record<string, string>;
  /**
   * Also route the browser through xyte's `proxy`. Default false: remote browser services
   * pick their own exit (set the country in the endpoint).
   */
  useProxy?: boolean;
}

/** What hooks get to see about the request being rendered. */
export interface BrowserHookInfo {
  request: EngineAttempt['request'];
  proxy: ProxyEndpoint | null;
  context: ProxyContext;
}

export interface BrowserOptions {
  /**
   * The Playwright-compatible browser type to launch. Default: `chromium` from `playwright`
   * (an optional peer dependency). Swap in a fork for stealth, e.g.
   * `(await import('patchright')).chromium`, `rebrowser-playwright`, or `playwright-extra`
   * with its stealth plugin.
   */
  browserType?: BrowserTypeLike | (() => BrowserTypeLike | Promise<BrowserTypeLike>);
  /** Options for `browserType.launch()`: `headless`, `channel: 'chrome'`, `args`, `executablePath`… */
  launchOptions?: LaunchOptions;
  /** Full control over the shared browser (overrides `browserType` / `launchOptions`). */
  launch?: () => Promise<unknown>;
  /**
   * Render each request in a remote browser instead: Bright Data Scraping Browser, Browserless,
   * Browserbase… Called per attempt with the country and session, so the endpoint can carry
   * them. The connection is closed after the request.
   */
  connect?: (context: ProxyContext) => string | RemoteBrowser | Promise<string | RemoteBrowser>;
  /**
   * Adjust the context options per request. Receives xyte's defaults (proxy, viewport, user
   * agent, locale…); return the options to use. Patchright, for instance, recommends dropping
   * the custom `userAgent` and `viewport`.
   */
  contextOptions?: (
    defaults: BrowserContextOptions,
    info: BrowserHookInfo,
  ) => BrowserContextOptions | Promise<BrowserContextOptions>;
  /** Runs on every new page before navigation: init scripts, routes, stealth patches. */
  onPage?: (page: Page, info: BrowserHookInfo) => void | Promise<void>;
  /**
   * Resource types to abort, to save proxy bandwidth (residential traffic is billed per GB),
   * e.g. `['image', 'media', 'font']`.
   */
  blockResources?: readonly string[];
  /** Total browser time per request, seconds. Zyte's limit is 60. */
  timeLimit?: number;
  /**
   * After load and the actions, wait up to this many seconds for the network to go quiet, so
   * data the page fetches after `load` lands in `browserHtml` and `networkCapture`, as on Zyte.
   * Default 3; 0 returns right after load.
   */
  settleTime?: number;
}

/** Zyte returns at most 10 captured responses, 5 MiB of bodies in total. */
const MAX_CAPTURES = 10;
const MAX_CAPTURE_BYTES = 5 * 1024 * 1024;

export class BrowserEngine {
  private browser: Promise<Browser> | undefined;

  constructor(private readonly options: BrowserOptions = {}) {}

  private getBrowser(): Promise<Browser> {
    if (!this.browser) {
      const launch = (this.options.launch ?? (() => launchLocal(this.options))) as () => Promise<Browser>;
      const launching = launch().then(
        (browser) => {
          // A crashed or remotely closed browser is relaunched on the next request.
          browser.on('disconnected', () => {
            if (this.browser === launching) this.browser = undefined;
          });
          return browser;
        },
        (error) => {
          this.browser = undefined;
          // Launching is local: a failure is a setup problem, not something a retry fixes.
          if (error instanceof XyteError) throw error;
          throw serverError(`could not start the browser: ${String(error?.message ?? error).split('\n')[0]}`, error);
        },
      );
      this.browser = launching;
    }
    return this.browser;
  }

  async close(): Promise<void> {
    const browser = this.browser;
    this.browser = undefined;
    if (browser) await (await browser).close().catch(() => {});
  }

  async run(attempt: EngineAttempt): Promise<EngineResult> {
    const { request } = attempt;
    const timeLimitMs = (this.options.timeLimit ?? 60) * 1000;
    const deadline = Date.now() + timeLimitMs;
    const remaining = () => Math.max(0, deadline - Date.now());

    attempt.signal.throwIfAborted();
    const remote = this.options.connect ? await this.connectRemote(attempt) : undefined;
    let context: BrowserContext | undefined;
    // Registered before any slow step, so a caller hanging up mid-launch still tears down.
    const abort = () => {
      void context?.close().catch(() => {});
      void remote?.browser.close().catch(() => {});
    };
    attempt.signal.addEventListener('abort', abort, { once: true });

    try {
      const proxy = remote && !remote.useProxy ? null : attempt.proxy;
      const info: BrowserHookInfo = { request, proxy, context: attempt.context };
      const browser = remote?.browser ?? (await this.getBrowser());
      attempt.signal.throwIfAborted();

      const defaults = contextOptions(attempt, proxy);
      const options = this.options.contextOptions ? await this.options.contextOptions(defaults, info) : defaults;
      context = await browser.newContext(options);
      attempt.signal.throwIfAborted();
      // Every request the page makes, as transferred (bodies encoded), for transferBytes.
      const sizes: Promise<number>[] = [];
      context.on('requestfinished', (req) => {
        sizes.push(
          req.sizes().then(
            (s) => s.requestHeadersSize + s.requestBodySize + s.responseHeadersSize + Math.max(0, s.responseBodySize),
            () => 0,
          ),
        );
      });

      // The attempt's jar: requestCookies, or the session's cookies (client- or server-managed).
      const cookies = attempt.jar.entries().map(({ cookie, hostOnly }) => toPlaywrightCookie(cookie, hostOnly));
      if (cookies.length) await context.addCookies(cookies);
      if (this.options.blockResources?.length) {
        const blocked = new Set(this.options.blockResources);
        await context.route('**/*', (route) =>
          blocked.has(route.request().resourceType()) ? route.abort() : route.fallback(),
        );
      }

      const page = await context.newPage();
      await this.options.onPage?.(page, info);
      const captures = captureNetwork(page, request.networkCapture);
      // Main-document responses: the last one is the page's real answer, after a JavaScript
      // challenge or a client-side redirect replaced the first.
      const documents: PwResponse[] = [];
      page.on('response', (res) => {
        try {
          if (res.request().isNavigationRequest() && res.frame() === page.mainFrame()) documents.push(res);
        } catch {
          // A service worker's response has no frame.
        }
      });

      const actions = [...(request.actions ?? [])];
      // A leading waitForNavigation configures the initial navigation (Zyte semantics).
      const first = actions[0];
      const initialNav = first?.action === 'waitForNavigation' ? actions.shift() : undefined;
      const results: ActionResult[] = [];

      let mainResponse: PwResponse | null = null;
      const navStart = Date.now();
      try {
        mainResponse = await page.goto(request.url, {
          referer: request.requestHeaders?.referer,
          waitUntil: waitUntil(initialNav && 'waitUntil' in initialNav ? initialNav.waitUntil : undefined),
          timeout: Math.min(remaining(), seconds(initialNav && 'timeout' in initialNav ? initialNav.timeout : undefined, 30)),
        });
        if (initialNav) results.push(result(initialNav, navStart, 'success'));
      } catch (error) {
        // With a leading waitForNavigation, a failed first navigation is an action error, not a
        // request error; otherwise it is a download error for the client to classify and retry.
        if (!initialNav) throw error;
        results.push(result(initialNav, navStart, 'returned', error));
      }

      let stopped = results.some((r) => r.status === 'returned');
      for (const action of actions) {
        if (stopped || remaining() === 0) {
          results.push({ action: action.action, elapsedTime: 0, status: 'notExecuted' });
          continue;
        }
        const start = Date.now();
        // Zyte's own actions run through the handlers configured for them; without one, skipped.
        const handler = isZyteOnlyAction(action) ? handlerFor(action, attempt.actions?.handlers ?? {}, new URL(page.url())) : undefined;
        if (isZyteOnlyAction(action) && !handler) {
          attempt.actions?.onMissing(action);
          results.push({ action: action.action, elapsedTime: 0, status: 'notExecuted', error: 'no handler for this action outside Zyte: skipped' });
          continue;
        }
        // A handler's log() lines come back as the action's interactionLogs, as Zyte returns its scripts' console.log.
        const logs: InteractionLogEntry[] = [];
        const log = (message: string, level: InteractionLogEntry['level'] = 'info') => {
          logs.push({ time: new Date().toISOString(), level, message: String(message) });
        };
        const withLogs = (r: ActionResult) => (logs.length > 0 ? { ...r, interactionLogs: logs } : r);
        try {
          const run = handler
            ? handler(page, action as ZyteOnlyAction, { url: new URL(page.url()), timeout: Math.min(remaining(), 30_000), log })
            : runAction(page, action, remaining);
          await withTimeout(run, remaining());
          results.push(withLogs(result(action, start, 'success')));
        } catch (error) {
          const onError = action.onError ?? 'return';
          results.push(withLogs(result(action, start, onError === 'continue' ? 'continued' : 'returned', error)));
          if (onError === 'return') stopped = true;
        }
      }

      const settleMs = Math.min(remaining(), (this.options.settleTime ?? 3) * 1000);
      if (settleMs > 0) await page.waitForLoadState('networkidle', { timeout: settleMs }).catch(() => {});

      if (request.includeIframes) await embedIframes(page);
      const html = truncate(await page.content());
      const final = documents.findLast((res) => !isRedirect(res.status())) ?? mainResponse;
      const response: EngineResult['response'] = {
        url: page.url(),
        statusCode: final?.status() ?? 200,
      };
      if (request.browserHtml) response.browserHtml = html;
      // browserFallback: an HTTP request rendered in a browser answers with the raw document.
      if (request.httpResponseBody) {
        const raw = await final?.body().catch(() => undefined);
        response.httpResponseBody = toBase64(raw ?? new TextEncoder().encode(html));
      }
      if (request.screenshot) {
        const { format = 'jpeg', fullPage = false } = request.screenshotOptions ?? {};
        response.screenshot = toBase64(await page.screenshot({ type: format, fullPage }));
      }
      if (request.actions?.length) response.actions = results;
      if (request.networkCapture?.length) response.networkCapture = await captures();

      const headers = final ? await final.headersArray() : [];
      if (request.httpResponseHeaders) response.httpResponseHeaders = headers;

      const transferBytes = (await Promise.all(sizes)).reduce((sum, size) => sum + size, 0);
      return { response, statusCode: response.statusCode ?? 200, headers, html, transferBytes };
    } finally {
      attempt.signal.removeEventListener('abort', abort);
      if (context) {
        for (const cookie of await context.cookies().catch(() => [])) {
          attempt.jar.set(fromPlaywrightCookie(cookie), !cookie.domain?.startsWith('.'));
        }
        await context.close().catch(() => {});
      }
      await remote?.browser.close().catch(() => {});
    }
  }

  private async connectRemote(attempt: EngineAttempt): Promise<RemoteBrowser & { browser: Browser }> {
    const target = await this.options.connect!(attempt.context);
    const remote: RemoteBrowser = typeof target === 'string' ? { endpoint: target } : target;
    const browserType = await resolveBrowserType(this.options);
    const connectOptions = { headers: remote.headers, timeout: 30_000 };
    // A remote connection failing is a download problem (retried), unlike a local launch.
    const browser = (
      remote.protocol === 'playwright'
        ? await browserType.connect(remote.endpoint, connectOptions)
        : await browserType.connectOverCDP(remote.endpoint, connectOptions)
    ) as Browser;
    return { ...remote, browser };
  }
}

async function resolveBrowserType(options: BrowserOptions): Promise<BrowserTypeLike> {
  if (options.browserType) {
    return typeof options.browserType === 'function' ? options.browserType() : options.browserType;
  }
  try {
    return (await import('playwright')).chromium;
  } catch (error) {
    throw serverError(
      'browser requests (browserHtml, screenshot, actions, networkCapture) need "playwright" ' +
        '(npm i playwright && npx playwright install chromium), or pass `browser.browserType`',
      error,
    );
  }
}

async function launchLocal(options: BrowserOptions): Promise<Browser> {
  const browserType = await resolveBrowserType(options);
  return (await browserType.launch({ headless: true, ...options.launchOptions })) as Browser;
}

function contextOptions(attempt: EngineAttempt, proxy: ProxyEndpoint | null): BrowserContextOptions {
  const { request } = attempt;
  const mobile = request.device === 'mobile';
  return {
    proxy: proxy ? playwrightProxy(proxy) : undefined,
    ignoreHTTPSErrors: proxy?.insecure === true,
    extraHTTPHeaders: proxy?.headers,
    javaScriptEnabled: request.javascript !== false,
    // `evaluate` sources run through eval in the page; CSP must not block them.
    bypassCSP: true,
    viewport: request.viewport
      ? { width: request.viewport.width ?? 1920, height: request.viewport.height ?? 1080 }
      : mobile
        ? { width: 412, height: 915 }
        : { width: 1920, height: 1080 },
    userAgent: userAgent(request.device),
    isMobile: mobile,
    hasTouch: mobile,
    locale: 'en-US',
  };
}

function playwrightProxy(proxy: ProxyEndpoint): NonNullable<BrowserContextOptions['proxy']> {
  const url = new URL(proxy.url);
  return {
    server: `${url.protocol}//${url.host}`,
    username: url.username ? decodeURIComponent(url.username) : undefined,
    password: url.password ? decodeURIComponent(url.password) : undefined,
  };
}

type PlaywrightCookie = Parameters<import('playwright').BrowserContext['addCookies']>[0][number];

function toPlaywrightCookie(cookie: Cookie, hostOnly: boolean): PlaywrightCookie {
  const domain = cookie.domain.replace(/^\./, '');
  // Playwright: a URL scopes the cookie to that host only; a dotted domain covers subdomains.
  const scope = hostOnly
    ? { url: `${cookie.secure ? 'https' : 'http'}://${domain}${cookie.path ?? '/'}` }
    : { domain: `.${domain}`, path: cookie.path ?? '/' };
  return {
    name: cookie.name,
    value: cookie.value,
    ...scope,
    expires: cookie.expires ?? -1,
    httpOnly: cookie.httpOnly ?? false,
    secure: cookie.secure ?? false,
    sameSite: cookie.sameSite === 'Strict' ? 'Strict' : cookie.sameSite === 'None' ? 'None' : 'Lax',
  };
}

function fromPlaywrightCookie(cookie: PlaywrightCookie): Cookie {
  return {
    name: cookie.name,
    value: cookie.value,
    domain: cookie.domain ?? '',
    path: cookie.path,
    expires: cookie.expires != null && cookie.expires > 0 ? Math.floor(cookie.expires) : undefined,
    httpOnly: cookie.httpOnly,
    secure: cookie.secure,
    sameSite: cookie.sameSite,
  };
}

/** Starts capturing matching responses; call the result to collect them. */
function captureNetwork(page: Page, filters: readonly NetworkCaptureFilter[] | undefined) {
  if (!filters?.length) return async () => [] as CapturedResponse[];

  const pending: Promise<CapturedResponse | undefined>[] = [];
  page.on('response', (res) => {
    if (pending.length >= MAX_CAPTURES) return;
    const filter = filters.find((f) => matchesFilter(f, res));
    if (!filter) return;
    pending.push(
      (async () => {
        const captured: CapturedResponse = {
          url: res.url(),
          statusCode: res.status(),
          headers: (await res.allHeaders().catch(() => ({}))) as CapturedResponse['headers'],
          filter,
        };
        if (filter.httpResponseBody) {
          const body = await res.body().catch(() => undefined);
          if (body) captured.httpResponseBody = toBase64(body);
        }
        return captured;
      })(),
    );
  });

  return async () => {
    const all = (await Promise.all(pending)).filter((c): c is CapturedResponse => c != null);
    let total = 0;
    return all.filter((c) => {
      total += c.httpResponseBody ? (c.httpResponseBody.length * 3) / 4 : 0;
      return total <= MAX_CAPTURE_BYTES;
    });
  };
}

function matchesFilter(filter: NetworkCaptureFilter, res: PwResponse): boolean {
  if (filter.filterType === 'resourceType') {
    return res.request().resourceType() === filter.resourceType;
  }
  return filter.value != null && matchUrl(res.url(), filter.value, filter.matchType as MatchType | undefined);
}

function locate(page: Page, selector: ActionSelector): Locator {
  return page.locator(selector.type === 'xpath' ? `xpath=${selector.value}` : selector.value).first();
}

async function runAction(page: Page, action: Action, remaining: () => number): Promise<void> {
  const timeout = (value: number | undefined, fallback = 5) => Math.min(remaining(), seconds(value, fallback));

  switch (action.action) {
    case 'click': {
      const navTimeout = action.waitForNavigationTimeout ?? 0;
      const nav = navTimeout > 0 ? page.waitForEvent('framenavigated', { timeout: navTimeout * 1000 }).catch(() => null) : null;
      await locate(page, action.selector).click({
        button: action.button,
        delay: (action.delay ?? 0) * 1000,
        timeout: timeout(undefined),
      });
      if (nav && (await nav)) await page.waitForLoadState('load', { timeout: timeout(undefined, 30) });
      return;
    }
    case 'doubleClick':
      return locate(page, action.selector).dblclick({ timeout: timeout(undefined) });
    case 'hover':
      return locate(page, action.selector).hover({ timeout: timeout(undefined) });
    case 'hide':
      await page
        .locator(action.selector.type === 'xpath' ? `xpath=${action.selector.value}` : action.selector.value)
        .evaluateAll((elements) => {
          for (const element of elements) (element as HTMLElement).style.setProperty('visibility', 'hidden', 'important');
        });
      return;
    case 'evaluate':
      return evaluateInPage(page, action.source);
    case 'goto':
      await page.goto(action.url, {
        waitUntil: waitUntil(action.options?.waitUntil),
        timeout: timeout(action.options?.timeout, 30),
      });
      return;
    case 'reload':
      await page.reload({ waitUntil: waitUntil(action.options?.waitUntil), timeout: timeout(action.options?.timeout, 30) });
      return;
    case 'keyPress':
      return page.keyboard.press(action.key);
    case 'type': {
      const target = locate(page, action.selector);
      await target.click({ timeout: timeout(undefined) });
      return target.pressSequentially(action.text, { delay: (action.delay ?? 0) * 1000 });
    }
    case 'select':
      await locate(page, action.selector).selectOption(action.values, { timeout: timeout(undefined) });
      return;
    case 'scrollTo':
      if (action.selector) return locate(page, action.selector).scrollIntoViewIfNeeded({ timeout: timeout(undefined) });
      await page.evaluate(([top, left]) => window.scrollTo({ top, left }), [action.top ?? 0, action.left ?? 0] as const);
      return;
    case 'scrollBottom':
      return scrollBottom(page, action, remaining);
    case 'waitForNavigation':
      await page.waitForEvent('framenavigated', { timeout: timeout(action.timeout, 31) });
      await page.waitForLoadState(waitUntil(action.waitUntil), { timeout: timeout(action.timeout, 31) });
      return;
    case 'waitForRequest':
      await page.waitForRequest((req) => matchUrl(req.url(), action.urlPattern, action.urlMatchingOptions), {
        timeout: timeout(action.timeout),
      });
      return;
    case 'waitForResponse':
      await page.waitForResponse((res) => matchUrl(res.url(), action.urlPattern, action.urlMatchingOptions), {
        timeout: timeout(action.timeout),
      });
      return;
    case 'waitForSelector':
      await locate(page, action.selector).waitFor({ state: action.selector.state ?? 'visible', timeout: timeout(action.timeout) });
      return;
    case 'waitForTimeout': {
      const ms = seconds(action.timeout, 5);
      if (ms > remaining()) throw new Error('waitForTimeout exceeds the remaining browser time');
      return page.waitForTimeout(ms);
    }
    default:
      throw new Error(`unsupported action "${(action as Action).action}"`);
  }
}

/**
 * `includeIframes`: write each frame's document into its `<iframe>` element as text. HTML
 * serializes iframe text unescaped, so the frame's markup appears inline in browserHtml. Innermost
 * frames first, so nested iframes nest.
 */
async function embedIframes(page: Page): Promise<void> {
  const depth = (frame: ReturnType<Page['mainFrame']>) => {
    let d = 0;
    for (let f = frame.parentFrame(); f; f = f.parentFrame()) d++;
    return d;
  };
  const frames = page.frames().filter((f) => f !== page.mainFrame()).sort((a, b) => depth(b) - depth(a));
  for (const frame of frames) {
    try {
      const html = await frame.content();
      const element = await frame.frameElement();
      await element.evaluate((el, content) => {
        el.textContent = content;
      }, html);
    } catch {
      // Detached or cross-process frame that went away: leave it empty, as without the option.
    }
  }
}

const EVAL_ERROR_ATTRIBUTE = 'data-xyte-evaluate-error';

/**
 * Zyte runs `evaluate` sources as a page script (main world, page globals visible) without
 * awaiting the promises they create. A `<script>` tag does exactly that, also under Playwright
 * forks such as patchright whose `page.evaluate` runs in an isolated world. Errors come back
 * through a DOM attribute, which both worlds share.
 */
async function evaluateInPage(page: Page, source: string): Promise<void> {
  // The tag removes itself so browserHtml shows the page, not xyte's plumbing.
  const wrapped = `try { (0, eval)(${JSON.stringify(source)}); } catch (error) {
    document.documentElement.setAttribute(${JSON.stringify(EVAL_ERROR_ATTRIBUTE)}, String(error && error.message || error));
  } finally { document.currentScript && document.currentScript.remove(); }`;
  await page.addScriptTag({ content: wrapped });
  const root = page.locator('html');
  const error = await root.getAttribute(EVAL_ERROR_ATTRIBUTE);
  if (error != null) {
    await root.evaluate((el, name) => el.removeAttribute(name), EVAL_ERROR_ATTRIBUTE);
    throw new Error(error);
  }
}

async function scrollBottom(
  page: Page,
  action: Extract<Action, { action: 'scrollBottom' }>,
  remaining: () => number,
): Promise<void> {
  const deadline = Date.now() + Math.min(remaining(), seconds(action.timeout, 15));
  const scrollDelay = seconds(action.maxScrollDelay, 5);
  const maxCount = action.maxScrollCount ?? Number.POSITIVE_INFINITY;
  const maxHeight = action.maxPageHeight ?? Number.POSITIVE_INFINITY;
  const height = () => page.evaluate(() => document.documentElement.scrollHeight);

  let last = await height();
  for (let count = 0; count < maxCount && last < maxHeight && Date.now() < deadline; count++) {
    await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
    const until = Math.min(deadline, Date.now() + scrollDelay);
    let next = last;
    while (Date.now() < until && next === last) {
      await sleep(100);
      next = await height();
    }
    if (next === last) return;
    last = next;
  }
}

function result(action: Action, start: number, status: ActionResult['status'], error?: unknown): ActionResult {
  const r: ActionResult = { action: action.action, elapsedTime: (Date.now() - start) / 1000, status };
  if (error != null) r.error = error instanceof Error ? error.message.split('\n')[0] : String(error);
  return r;
}

type WaitUntil = 'load' | 'networkidle0' | 'domcontentloaded' | undefined;

function waitUntil(value: WaitUntil): 'load' | 'networkidle' | 'domcontentloaded' {
  return value === 'networkidle0' ? 'networkidle' : (value ?? 'load');
}

/** Zyte expresses timeouts in seconds; Playwright in milliseconds. */
function seconds(value: number | undefined, fallback: number): number {
  return (value ?? fallback) * 1000;
}

function truncate(html: string): string {
  return html.length > MAX_BODY_BYTES ? html.slice(0, MAX_BODY_BYTES) : html;
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('browser time limit reached')), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}
