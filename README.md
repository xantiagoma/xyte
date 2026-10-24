# xyte

**The [Zyte API](https://docs.zyte.com/zyte-api/usage/index.html) `POST /v1/extract`, on any proxy.**

Same request JSON, same response JSON, same error codes as `https://api.zyte.com/v1/extract`.
The difference is where traffic exits: Oxylabs, Bright Data, Decodo (Smartproxy), IPRoyal,
ZenRows, ScrapingBee, ScraperAPI, any `http://user:pass@host:port`, or no proxy at all. You keep
Zyte's conveniences: geolocation, sticky sessions, cookies, ban retries, browser rendering with
actions and network capture.

Use it as a library, or run it as a local server and point existing Zyte code at it by changing
only the base URL.

Runs on **Node.js ≥ 22** and **Bun**.

**Docs:** [Zyte API coverage](docs/coverage.md) · [providers](docs/providers.md) ·
[browser & stealth](docs/browser.md) · [deploying](docs/deploy.md) · [mounting in your app](docs/mounting.md) ·
[migrating from Zyte](docs/migrating-from-zyte.md) · [examples](examples/)

```sh
npm i xyte
# browser requests (browserHtml, screenshot, actions, networkCapture):
npm i playwright && npx playwright install chromium
# proxies on Node.js (Bun has proxy support built into fetch); undici 8 needs Node 22.19+:
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
Docker images (full with Chromium, or slim HTTP-only) and Cloud Run / Fly / Render / App Platform /
Modal configs: [docs/deploy.md](docs/deploy.md). To serve it from your own app, use
`createHandler(xyte)` (Hono, Bun.serve, Next.js…) or `toNodeHandler(…)` (Express, Fastify): see
[docs/mounting.md](docs/mounting.md).

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
| `template('http://u[-country-{country:lower}]-session-{session}:p@host:port')` | **any provider**, from its URL format | placeholders + optional `[parts]` |
| `custom(name, ctx => url)` | anything you build | you decide |

…and NodeMaven, SOAX, NetNut, Webshare, Rayobyte, PacketStream, Evomi, DataImpulse, Massive,
Proxy-Seller, Thordata, Anyip, ABCProxy, ProxyEmpire, RapidProxy, Swiftproxy, 922 S5, LunaProxy,
plus Crawlbase, Scrape.do, ScrapingAnt, ScrapeOps, Scrapfly, Oxylabs Web Unblocker and Zyte's own
proxy mode, and hosted browsers (Bright Data Scraping Browser, Browserless, ZenRows, Oxylabs,
NodeMaven). Full catalog with formats and confidence levels: [docs/providers.md](docs/providers.md).

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

**Browser** (Playwright, or [patchright and other forks](docs/browser.md), or a [remote browser](docs/browser.md#remote-browsers)): `browserHtml`, `screenshot` + `screenshotOptions`, `javascript`,
`viewport`, `networkCapture` (url / resourceType filters, at most 10 captures and 5 MiB),
the 60 s browser time budget, and the actions `click`, `doubleClick`, `hover`, `hide`, `evaluate`,
`goto`, `reload`, `keyPress`, `type`, `select`, `scrollTo`, `scrollBottom`, `waitForNavigation`,
`waitForRequest`, `waitForResponse`, `waitForSelector`, `waitForTimeout` (with `onError`).

**Markdown**: built in and non-AI like Zyte's, with `mainContent` / `fullPage` scopes.

**AI extraction** (`product`, `article`, `pageContent`, `serp`, `customAttributes`…):
pluggable. Register an `extractors.<field>` function, for example an LLM call. Without one, the
request is rejected with a 400.

```ts
new Xyte({ extractors: { product: async ({ html, url }) => myLlmExtract(html, url) } });
```

**Sessions**: `session.id` (client-managed: sticky exit + cookie jar) and `sessionContext` +
`sessionContextParameters` (server-managed pool initialized by actions, retired after 4 h or 3 bans).

**Not supported yet:** Zyte-specific actions (`searchKeyword`, `setLocation`, `interaction`),
built-in AI extraction, Zyte's proxy mode and Stats API.
Field-by-field status: [docs/coverage.md](docs/coverage.md).

## Development

```sh
bun install
bun test             # unit + integration (local target site, local proxy, real Chromium + patchright)
bun run test:node    # build, then run the dist on Node.js
bun run typecheck
bun run build        # tsdown → dist/
bun run gen:types    # regenerate src/zyte.gen.ts from spec/zyte-openapi.json (and the coverage doc)
bun run docs:coverage  # regenerate docs/coverage.md from scripts/coverage.ts
```

`spec/zyte-openapi.json` is Zyte's OpenAPI document, taken from the
[API reference](https://docs.zyte.com/zyte-api/usage/reference.html). One upstream typo is
patched: `ProductNavigation.required` was nested under `properties`.
