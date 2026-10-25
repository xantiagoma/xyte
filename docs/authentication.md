# Authenticated pages

As on Zyte, credentials travel in the request, depending on what the site uses. Everything here
works the same against `zyteApi()` and the other providers.

## A session cookie (most websites)

Send it in `requestCookies`, not as a `Cookie` header: Zyte drops a `Cookie` header from
`customHttpRequestHeaders` without an error, and so does xyte.

```json
{
  "url": "https://shop.example/account/orders",
  "httpResponseBody": true,
  "requestCookies": [{ "name": "sessionid", "value": "…", "domain": "shop.example" }],
  "responseCookies": true
}
```

`requestCookies` work for HTTP and browser requests alike. `responseCookies: true` returns the
cookies as they are after the request (a refreshed session, a new CSRF token), to send next time.

## A token in a header (APIs)

`customHttpRequestHeaders`, e.g. `Authorization: Bearer …` or `X-Api-Key: …`, on HTTP requests:

```json
{
  "url": "https://api.example/v1/me",
  "httpResponseBody": true,
  "customHttpRequestHeaders": [{ "name": "Authorization", "value": "Bearer …" }]
}
```

Browser requests don't take custom headers on Zyte (`browserHtml` with `customHttpRequestHeaders`
is a 422, checked against api.zyte.com; only `requestHeaders.referer` is allowed), nor on xyte. An
`Authorization` header isn't forwarded when a redirect leads to another origin, as `fetch` does.

In the library (not over the HTTP API), a browser request can still carry headers through a hook,
outside Zyte's contract:

```ts
new Xyte({
  browser: { onPage: (page) => page.setExtraHTTPHeaders({ authorization: `Bearer ${token}` }) },
});
```

## Logging in first

- **Once, then reuse the cookies:** a browser request whose `actions` fill the login form
  (`type`, `click`, `waitForNavigation`), with `responseCookies: true`; later requests send those
  cookies in `requestCookies`.
- **`session.id`:** requests with the same id leave from the same sticky IP (where the provider
  supports it), and xyte keeps that session's cookies between them, in memory per process. Log
  in on the first request; the next ones are logged in.
- **`sessionContext` + `sessionContextParameters.actions`:** a pool of sessions where the login
  actions run once per new session and its cookies seed it, as on Zyte. Sessions are retired after
  4 hours or 3 bans, and a new one logs in again.

## Where the credentials go

Cookies and tokens are sent through whatever provider the attempt uses:

| Provider | Who can see them |
| --- | --- |
| Residential / datacenter proxies, over `https://` | nobody in between: the proxy only tunnels encrypted traffic (`CONNECT`) |
| Scraping APIs in proxy mode (ZenRows, ScrapingBee, ScraperAPI…) | the API: it re-signs TLS (that's why those presets set `insecure`), so it reads requests in clear |
| `zyteApi()`, `scrappey()`, `scrapingBot()` | the service: the whole request, credentials included, is sent to it |
| `direct()` | nobody in between |

For accounts that matter, keep authenticated sites on a plain proxy or `direct()`, e.g. with
`route({ 'shop.example': residential }, …)` ([routing](routing.md)).
