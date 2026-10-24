# xyte

**The [Zyte API](https://docs.zyte.com/zyte-api/usage/index.html) `POST /v1/extract`, on any proxy.**

Same request JSON, same response JSON, same error codes as `https://api.zyte.com/v1/extract`.
The difference is where traffic exits: Oxylabs, Bright Data, Decodo (Smartproxy), IPRoyal,
ZenRows, ScrapingBee, ScraperAPI, any `http://user:pass@host:port`, or no proxy at all. You keep
Zyte's conveniences: geolocation, sticky sessions, cookies, ban retries, browser rendering with
actions and network capture.

Use it as a library, or run it as a local server and point existing Zyte code at it by changing
only the base URL.

Runs on **Node.js ≥ 20** and **Bun**.

```sh
npm i xyte
# browser requests (browserHtml, screenshot, actions, networkCapture):
npm i playwright && npx playwright install chromium
# proxies on Node.js (Bun has proxy support built into fetch):
npm i undici
```

## Library

```ts
import { Xyte, oxylabs, decodeBody } from 'xyte';

const xyte = new Xyte({
  proxy: oxylabs({ username: process.env.OXYLABS_USERNAME!, password: process.env.OXYLABS_PASSWORD! }),
});

// Raw HTTP (cheap, fast)
const page = await xyte.extract({ url: 'https://example.com', httpResponseBody: true, geolocation: 'US' });
page.statusCode; // 200; a target 404 is a successful response with statusCode 404, as on Zyte
decodeBody(page.httpResponseBody!); // the HTML

// Rendered in a browser, with Zyte actions
const rendered = await xyte.extract({
  url: 'https://example.com/app',
  browserHtml: true,
  actions: [
    { action: 'waitForSelector', selector: { type: 'css', value: '#results' }, timeout: 10 },
    { action: 'scrollBottom' },
  ],
  networkCapture: [{ filterType: 'url', matchType: 'contains', value: '/api/', httpResponseBody: true }],
});

await xyte.close(); // closes the shared browser
```

`extract()` resolves with the Zyte 200 body, or rejects with an `XyteError` that has Zyte's
`status` (400, 421, 520…) and problem `type` (`/download/temporary-error`, …).

## Drop-in server

```sh
XYTE_PROVIDER=oxylabs OXYLABS_USERNAME=… OXYLABS_PASSWORD=… npx xyte serve --port 8011
```

```diff
- const res = await fetch('https://api.zyte.com/v1/extract', {
+ const res = await fetch('http://localhost:8011/v1/extract', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Basic ' + btoa(apiKey + ':') },
    body: JSON.stringify({ url, httpResponseBody: true }),
  });
```

Set `XYTE_API_KEYS=key1,key2` to require a key (sent the way Zyte expects it: basic-auth username).
To mount it in your own server, `createHandler(xyte)` returns a Web `(Request) => Response` handler
for Bun.serve, Deno, Hono or Workers. `serve(handler)` runs it on Bun or `node:http`.

CLI one-offs:

```sh
npx xyte extract https://example.com --raw              # HTTP, prints the body
npx xyte extract https://example.com --browser --country GB
npx xyte extract --json '{"url":"https://example.com","browserHtml":true}'
```

## Providers

| Preset | Exit | Geolocation / session encoded as |
| --- | --- | --- |
| `direct()` (default) | this machine | none |
| `proxyUrl(url \| urls[])` | any proxy; several rotate across retries | none |
| `oxylabs({ username, password, type? })` | `pr.oxylabs.io:7777` / `dc.oxylabs.io:8000` | `customer-U-cc-US-sessid-…-sesstime-10` |
| `brightData({ customerId, zone, password })` | `brd.superproxy.io:33335` | `brd-customer-…-zone-…-country-us-session-…` |
| `decodo({ username, password })` (alias `smartproxy`) | `gate.decodo.com:7000` | `user-U-country-us-session-…-sessionduration-10` |
| `iproyal({ username, password })` | `geo.iproyal.com:12321` | password `P_country-us_session-…_lifetime-10m` |
| `zenrows({ apiKey })` | ZenRows API proxy mode | `premium_proxy=true&proxy_country=us&session_id=…` |
| `scrapingBee({ apiKey })` | ScrapingBee proxy mode | `premium_proxy=True&country_code=us&session_id=…` |
| `scraperApi({ apiKey })` | ScraperAPI proxy mode | `scraperapi.country_code=us.session_number=…` |
| `custom(name, ctx => url)` | anything you build | you decide |

Combinators:

- `rotate([a, b])`: attempt 1 uses `a`, the retry uses `b`. If one provider is down (for example
  rejecting every login with a 407), you lose one attempt instead of the whole request.
- `byIpType({ datacenter, residential })`: chooses by the request's `ipType`.

From env (what the CLI uses): `proxyFromEnv()` reads `XYTE_PROXY_URL=…[,…]` or
`XYTE_PROVIDER=oxylabs[,zenrows…]` plus that provider's credentials (`OXYLABS_USERNAME`,
`ZENROWS_API_KEY`, …; see `src/env.ts`).

The scraping-API presets (ZenRows, ScrapingBee, ScraperAPI) re-sign TLS, so they set `insecure`
automatically. They bill per request, so in a browser every sub-request of the page is billed.
Use them with `httpResponseBody`.

## How Zyte behaviour maps

| Zyte | xyte |
| --- | --- |
| `geolocation` | provider's country parameter |
| `ipType` | `byIpType()` |
| `session.id` | provider sticky session (same exit IP) plus a cookie jar kept across requests |
| no `session` | fresh exit per attempt: redirects and browser sub-requests share it, retries change it |
| ban handling | 403/429/503 or known challenge pages (Cloudflare, DataDome, PerimeterX, Imperva, Akamai) are retried with backoff on a new exit, then fail as **520** `/download/temporary-error`. Override with `isBan`. |
| target 4xx/5xx | **200** with `statusCode` set |
| unknown domain | **421** `/website/domain-unreachable` |
| invalid combos (`browserHtml` + `httpResponseBody`, `Cookie` in custom headers, browser-only fields on HTTP…) | **400** `/request/invalid` |

## Supported fields

**HTTP:** `httpResponseBody`, `httpResponseHeaders`, `httpRequestMethod`, `httpRequestBody`,
`httpRequestText`, `customHttpRequestHeaders`, `requestHeaders.referer`, `followRedirect`,
`device`, `requestCookies`, `responseCookies`, `cookieManagement`, `session`, `geolocation`,
`ipType`, `echoData`, `jobId`.

**Browser** (Playwright): `browserHtml`, `screenshot` + `screenshotOptions`, `javascript`,
`viewport`, `networkCapture` (url / resourceType filters, at most 10 captures and 5 MiB),
the 60 s browser time budget, and the actions `click`, `doubleClick`, `hover`, `hide`, `evaluate`,
`goto`, `reload`, `keyPress`, `type`, `select`, `scrollTo`, `scrollBottom`, `waitForNavigation`,
`waitForRequest`, `waitForResponse`, `waitForSelector`, `waitForTimeout` (with `onError`). To use a
remote browser: `new Xyte({ browser: { launch: () => chromium.connectOverCDP(ws) } })`.

**Extraction** (`product`, `article`, `pageContent`, `markdown`, `serp`, `customAttributes`…):
pluggable. Register an `extractors.<field>` function, for example an LLM call. Without one, the
request is rejected with a 400.

```ts
new Xyte({ extractors: { product: async ({ html, url }) => myLlmExtract(html, url) } });
```

**Not supported yet:** Zyte-specific actions (`searchKeyword`, `setLocation`, `interaction`),
`sessionContext`, `includeIframes`, built-in AI extraction, Zyte's Stats API.

## Development

```sh
bun install
bun test             # unit + integration (local target site, local proxy, real Chromium)
bun run test:node    # build, then run the dist on Node.js
bun run typecheck
bun run build        # tsdown → dist/
bun run gen:types    # regenerate src/zyte.gen.ts from spec/zyte-openapi.json
```

`spec/zyte-openapi.json` is Zyte's OpenAPI document, taken from the
[API reference](https://docs.zyte.com/zyte-api/usage/reference.html). One upstream typo is
patched: `ProductNavigation.required` was nested under `properties`.
