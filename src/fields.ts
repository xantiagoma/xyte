/**
 * Which request fields belong to which kind of request. An HTTP request (`httpResponseBody`,
 * `httpResponseHeaders`, extraction from HTTP) and a browser request (`browserHtml`,
 * `screenshot`, extraction from the browser) take different fields; a field of the other kind is
 * a 422 `/request/unprocessable`, as on Zyte. The client validates with these lists and
 * docs/coverage.md is generated from them.
 */

/** Asking for one of these makes the request a browser request. */
export const BROWSER_OUTPUTS = ['browserHtml', 'screenshot'] as const;

/** Only on browser requests. */
export const BROWSER_ONLY = ['actions', 'networkCapture', 'javascript', 'viewport', 'screenshotOptions', 'includeIframes'] as const;

/** Only on HTTP requests. */
export const HTTP_ONLY = ['httpRequestMethod', 'httpRequestBody', 'httpRequestText', 'customHttpRequestHeaders', 'followRedirect'] as const;
