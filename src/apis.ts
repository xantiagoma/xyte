/**
 * Scraping services without a proxy port, as `ProxyProvider`s that resolve to an `ApiEndpoint`:
 * they take the whole Zyte request and answer in Zyte's shape, so they mix with proxies in
 * `rotate()`.
 */
import { XyteError } from './errors.ts';
import type { ApiEndpoint, ApiResult, ProxyProvider } from './proxy.ts';
import type { ExtractRequest, ExtractResponse } from './types.ts';
import { decodeBody, fromBase64 } from './util.ts';

/** A failure worth another attempt (on the next provider, with `rotate()`). */
class ApiError extends Error {
  override name = 'ApiError';
}

const basic = (user: string, pass: string) => `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}`;

/** Fills the output fields the request asked for from a page's HTML. */
function htmlResult(request: ExtractRequest, page: { url: string; statusCode: number; html: string; headers?: ApiResult['headers'] }): ApiResult {
  const response: ExtractResponse = { url: page.url, statusCode: page.statusCode };
  if (request.httpResponseBody) response.httpResponseBody = Buffer.from(page.html).toString('base64');
  if (request.browserHtml) response.browserHtml = page.html;
  if (request.httpResponseHeaders && page.headers) response.httpResponseHeaders = page.headers;
  return { response, statusCode: page.statusCode, html: page.html, headers: page.headers };
}

/**
 * Zyte API itself (https://docs.zyte.com/zyte-api/usage/reference.html): the request is forwarded
 * unchanged, so every Zyte feature works, AI extraction included. Use it as the last resort:
 * `rotate([nodeMaven(…), zyteApi({ apiKey })])`.
 */
export function zyteApi(options: { apiKey: string; endpoint?: string; fetch?: typeof fetch }): ProxyProvider<ApiEndpoint> {
  const endpoint = options.endpoint ?? 'https://api.zyte.com/v1/extract';
  const doFetch = options.fetch ?? fetch;
  return {
    name: 'zyte-api',
    extracts: true,
    resolve: () => ({
      async api(request, { signal }) {
        const res = await doFetch(endpoint, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: basic(options.apiKey, '') },
          body: JSON.stringify(request),
          signal,
        });
        const body = (await res.json().catch(() => ({}))) as ExtractResponse & { type?: string; title?: string; detail?: string };
        if (res.ok) {
          const html = body.browserHtml ?? (body.httpResponseBody ? decodeBody(body.httpResponseBody) : undefined);
          return { response: body, statusCode: body.statusCode ?? 200, html, trusted: true };
        }
        // Rate limits, bans and server errors: retry (or move on to the next provider).
        if (res.status === 429 || res.status >= 500) throw new ApiError(`Zyte API ${res.status} ${body.type ?? ''}`.trim());
        // Request and account errors are final: pass Zyte's problem through.
        throw new XyteError({
          status: res.status,
          type: body.type ?? '/request/invalid',
          title: body.title ?? 'Zyte API error',
          detail: body.detail,
        });
      },
    }),
  };
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
  const doFetch = options.fetch ?? fetch;
  return {
    name: 'scrappey',
    resolve: () => ({
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
  const doFetch = options.fetch ?? fetch;
  return {
    name: 'scrapingbot',
    resolve: () => ({
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
