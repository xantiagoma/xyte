/**
 * Scraping services without a proxy port, as `ProxyProvider`s that resolve to an `ApiEndpoint`:
 * they take the whole Zyte request and answer in Zyte's shape, so they mix with proxies in
 * `rotate()`.
 */
import { UpstreamProblem, XyteError, type UpstreamInfo } from './errors.ts';
import type { ApiEndpoint, ApiResult, ProxyProvider } from './proxy.ts';
import type { ExtractRequest, ExtractResponse } from './types.ts';
import { decodeBody, fromBase64 } from './util.ts';

/** A failure worth another attempt (on the next provider, with `rotate()`). */
class ApiError extends Error {
  override name = 'ApiError';
}

const basic = (user: string, pass: string) => `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}`;

/** What a page-HTML API can't do: run actions, take screenshots, capture network responses. */
const htmlOnly = (request: ExtractRequest): string[] => [
  ...(request.actions?.length ? ['actions'] : []),
  ...(request.screenshot ? ['screenshot'] : []),
  ...(request.networkCapture?.length ? ['networkCapture'] : []),
];

/** Fills the output fields the request asked for from a page's HTML. */
function htmlResult(request: ExtractRequest, page: { url: string; statusCode: number; html: string; headers?: ApiResult['headers'] }): ApiResult {
  const response: ExtractResponse = { url: page.url, statusCode: page.statusCode };
  if (request.httpResponseBody) response.httpResponseBody = Buffer.from(page.html).toString('base64');
  if (request.browserHtml) response.browserHtml = page.html;
  if (request.httpResponseHeaders && page.headers) response.httpResponseHeaders = page.headers;
  return { response, statusCode: page.statusCode, html: page.html, headers: page.headers };
}

/** Options for `zyteApi()` and `xyteApi()`. */
export interface ZyteApiOptions {
  apiKey: string;
  /** Default `https://api.zyte.com/v1/extract`; any Zyte-compatible `/v1/extract` works. */
  endpoint?: string;
  /**
   * The provider's name in reports, `rates`, circuits and budgets. Default `zyte-api`. Set one per
   * endpoint when a combinator has several, so each keeps its own numbers.
   */
  name?: string;
  /**
   * Seconds an attempt on this endpoint may take, instead of the client's `timeout`. `xyteApi()`
   * defaults to 150 (the remote server retries on its side, and 150 s is Modal's web limit).
   */
  timeout?: number;
  /** Resolved at call time: a stub put on `globalThis.fetch` later is used too. */
  fetch?: typeof fetch;
}

/** Account problems (bad key, suspended account): no request will go through until they're fixed. */
const isAccountProblem = (status: number, type: string | undefined) => status === 401 || status === 403 || type?.startsWith('/auth/') === true;

/** Another xyte server's report, from its response headers (`X-Xyte-Attempts`…). */
function upstreamOf(headers: Headers): UpstreamInfo | undefined {
  const attempts = headers.get('x-xyte-attempts');
  if (attempts == null) return undefined;
  const bytes = Number(headers.get('x-xyte-transfer-bytes'));
  return {
    attempts: attempts
      .split(',')
      .filter(Boolean)
      .map((entry) => {
        const at = entry.lastIndexOf(':');
        return at === -1 ? { provider: entry, result: 'unknown' } : { provider: entry.slice(0, at), result: entry.slice(at + 1) };
      }),
    ...(Number.isFinite(bytes) && headers.has('x-xyte-transfer-bytes') && { transferBytes: bytes }),
    ...(headers.get('x-xyte-request-id') && { requestId: headers.get('x-xyte-request-id')! }),
  };
}

function zyteCompatible(options: ZyteApiOptions, defaults: { name: string; endpoint?: string; upstream: boolean; timeout?: number }): ProxyProvider<ApiEndpoint> {
  const endpoint = options.endpoint ?? defaults.endpoint;
  if (!endpoint) throw new Error(`${defaults.name}: an endpoint is required`);
  return {
    name: options.name ?? defaults.name,
    extracts: true,
    zyteActions: true,
    resolve: () => ({
      timeout: options.timeout ?? defaults.timeout,
      async api(request, { signal }) {
        const res = await (options.fetch ?? fetch)(endpoint, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: basic(options.apiKey, '') },
          body: JSON.stringify(request),
          signal,
        });
        const body = (await res.json().catch(() => ({}))) as ExtractResponse & { type?: string; title?: string; detail?: string };
        const upstream = defaults.upstream ? upstreamOf(res.headers) : undefined;
        if (res.ok) {
          const html = body.browserHtml ?? (body.httpResponseBody ? decodeBody(body.httpResponseBody) : undefined);
          return { response: body, statusCode: body.statusCode ?? 200, html, trusted: true, ...(upstream && { upstream }) };
        }
        const problem = {
          status: res.status,
          type: body.type ?? (res.status === 401 ? '/auth/not-valid' : '/download/temporary-error'),
          title: body.title ?? 'Zyte API error',
          detail: body.detail,
        };
        // Account problems are the provider's, not the request's: inside a combinator the next
        // provider gets the request. Rate limits, bans and server errors: retry (or move on).
        const fatal = isAccountProblem(res.status, body.type);
        if (fatal || res.status === 429 || res.status >= 500) throw new UpstreamProblem(problem, { fatal, upstream });
        // Request errors (400, 422…) are final: pass Zyte's problem through.
        throw new XyteError({ ...problem, type: body.type ?? '/request/invalid' });
      },
    }),
  };
}

/**
 * Zyte API itself (https://docs.zyte.com/zyte-api/usage/reference.html): the request is forwarded
 * unchanged, so every Zyte feature works, AI extraction included. Use it as the last resort:
 * `rotate([nodeMaven(…), zyteApi({ apiKey })])`. A bad key or a suspended account (401, 403)
 * moves a combinator on to its next provider; alone, it is the answer, with no retries.
 */
export function zyteApi(options: ZyteApiOptions): ProxyProvider<ApiEndpoint> {
  return zyteCompatible(options, { name: 'zyte-api', endpoint: 'https://api.zyte.com/v1/extract', upstream: false });
}

/**
 * Another xyte server (`xyte serve`, e.g. a deployment with its own proxy): `zyteApi()` with a
 * required `endpoint` that also reads its `X-Xyte-Attempts` / `X-Xyte-Transfer-Bytes` headers, so
 * the local attempt carries the remote ones (`upstream`) and the bytes they moved. Default name
 * `xyte`; give each deployment its own: `xyteApi({ endpoint, apiKey, name: 'xyte-oxylabs' })`.
 * An attempt waits up to `timeout` seconds (default 150): keep the remote's retries × timeout
 * under it. The client needs no browser: the remote renders.
 */
export function xyteApi(options: ZyteApiOptions & { endpoint: string }): ProxyProvider<ApiEndpoint> {
  return zyteCompatible(options, { name: 'xyte', upstream: true, timeout: 150 });
}

/** "US" → "UnitedStates" (Scrappey's country format). */
function compactCountryName(code: string): string {
  try {
    return (new Intl.DisplayNames(['en'], { type: 'region' }).of(code) ?? code).replace(/[^A-Za-z]/g, '');
  } catch {
    return code;
  }
}

/**
 * Scrappey (https://docs.scrappey.com): `POST publisher.scrappey.com/api/v1?key=…`. Browser
 * requests use `requestType: "browser"`, HTTP ones `"request"`. Verify the response fields on
 * your account (they're mapped from `solution.response` / `statusCode` / `currentUrl`).
 */
export function scrappey(options: { apiKey: string; fetch?: typeof fetch; params?: Record<string, unknown> }): ProxyProvider<ApiEndpoint> {
  const doFetch = (...args: Parameters<typeof fetch>): Promise<Response> => (options.fetch ?? fetch)(...args);
  return {
    name: 'scrappey',
    resolve: () => ({
      unsupported: htmlOnly,
      async api(request, { context, signal }) {
        const method = request.httpRequestMethod ?? 'GET';
        const body: Record<string, unknown> = {
          cmd: method === 'GET' ? 'request.get' : `request.${method.toLowerCase()}`,
          url: request.url,
          requestType: context.browser ? 'browser' : 'request',
          ...options.params,
        };
        if (context.country) body.proxyCountry = compactCountryName(context.country);
        if (request.customHttpRequestHeaders?.length) {
          body.customHeaders = Object.fromEntries(request.customHttpRequestHeaders.map((h) => [h.name, h.value]));
        }
        if (request.requestCookies?.length) body.cookies = request.requestCookies.map((c) => `${c.name}=${c.value}`).join('; ');
        if (request.httpRequestText != null) body.postData = request.httpRequestText;
        else if (request.httpRequestBody != null) body.postData = new TextDecoder().decode(fromBase64(request.httpRequestBody));

        const res = await doFetch(`https://publisher.scrappey.com/api/v1?key=${encodeURIComponent(options.apiKey)}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
          signal,
        });
        const json = (await res.json().catch(() => ({}))) as {
          data?: string;
          error?: string;
          solution?: {
            response?: string;
            statusCode?: number;
            currentUrl?: string;
            responseHeaders?: Record<string, string>;
          };
        };
        const solution = json.solution;
        if (!res.ok || json.data === 'error' || solution?.response == null) {
          throw new ApiError(`Scrappey ${res.status}: ${json.error ?? 'no solution'}`);
        }
        return htmlResult(request, {
          url: solution.currentUrl ?? request.url,
          statusCode: solution.statusCode ?? 200,
          html: solution.response,
          headers: solution.responseHeaders
            ? Object.entries(solution.responseHeaders).map(([name, value]) => ({ name, value: String(value) }))
            : undefined,
        });
      },
    }),
  };
}

/**
 * ScrapingBot raw HTML API (https://www.scraping-bot.io/web-scraping-documentation/):
 * `POST api.scraping-bot.io/scrape/raw-html`, basic auth `username:apiKey`, answers the page's
 * HTML. Its options (`useChrome`, `premiumProxy`, `proxyCountry`…) are passed through `options`;
 * verify the names in your dashboard. The target's status code is not reported (assumed 200).
 */
export function scrapingBot(options: {
  username: string;
  apiKey: string;
  options?: Record<string, unknown>;
  fetch?: typeof fetch;
}): ProxyProvider<ApiEndpoint> {
  const doFetch = (...args: Parameters<typeof fetch>): Promise<Response> => (options.fetch ?? fetch)(...args);
  return {
    name: 'scrapingbot',
    resolve: () => ({
      unsupported: htmlOnly,
      async api(request, { context, signal }) {
        const botOptions: Record<string, unknown> = { ...options.options };
        if (context.browser) botOptions.useChrome ??= true;
        if (context.country) botOptions.proxyCountry ??= context.country;
        const res = await doFetch('https://api.scraping-bot.io/scrape/raw-html', {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: basic(options.username, options.apiKey) },
          body: JSON.stringify({ url: request.url, options: botOptions }),
          signal,
        });
        const html = await res.text();
        if (!res.ok) throw new ApiError(`ScrapingBot ${res.status}: ${html.slice(0, 120)}`);
        return htmlResult(request, { url: request.url, statusCode: 200, html });
      },
    }),
  };
}
