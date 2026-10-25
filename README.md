# xyte

**The [Zyte API](https://docs.zyte.com/zyte-api/usage/index.html) `POST /v1/extract`, on any proxy.**

Same request JSON, same response JSON, same error codes as `https://api.zyte.com/v1/extract`.
The difference is where traffic exits: Oxylabs, Bright Data, Decodo, IPRoyal, ZenRows,
ScrapingBee, ScraperAPI, 30+ other presets, any `http://user:pass@host:port`, no proxy at all, or
Zyte itself. You keep Zyte's conveniences: geolocation, sticky sessions, cookies, ban detection
and retries, browser rendering with actions and network capture, markdown, and (with an LLM) AI
extraction in Zyte's schemas.

Runs on **Node.js ≥ 22** and **Bun**.

Three ways to use it:

- **[Library](#library)**: `new Xyte({ proxy }).extract(request)` in your code.
- **[Drop-in server](#drop-in-server)**: `xyte serve`, then point existing Zyte code at it by
  changing only the base URL.
- **[In front of Zyte](#mixing-providers-zyte-included)**: keep Zyte for the sites that need it,
  send the rest through cheaper exits, with one client.

**Docs:** [coverage of the Zyte API](docs/coverage.md) · [providers](docs/providers.md) ·
[combining providers](docs/routing.md) · [observability](docs/observability.md) · [configuration](docs/configuration.md) ·
[browser & stealth](docs/browser.md) · [AI extraction](docs/extraction.md) ·
[deploying](docs/deploy.md) · [mounting in your app](docs/mounting.md) ·
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

Requests and responses are typed from Zyte's OpenAPI spec. All options (`retries`, `timeout`,
`concurrency`, `isBan`, `onRetry`…) are in [configuration](docs/configuration.md).

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

Set `XYTE_API_KEYS=key1,key2` to require a key (sent the way Zyte expects it: basic-auth
username). Docker images (full with Chromium, or slim HTTP-only) and Cloud Run / Fly / Render /
App Platform / Modal configs: [deploy](docs/deploy.md). To serve it from your own app:
`createHandler(xyte)` (Hono, Bun.serve, Next.js…) or `toNodeHandler(…)` (Express, Fastify), see
[mounting](docs/mounting.md).

CLI one-offs:

```sh
npx xyte extract https://example.com --raw              # HTTP, prints the body
npx xyte extract https://example.com --browser --country GB
npx xyte extract --json '{"url":"https://example.com","browserHtml":true}'
```

## Providers

| Preset | Exit | Geolocation / session encoded as |
| --- | --- | --- |
| `direct()` (default) | this machine | none (`geolocation` can't apply: you get a warning) |
| `proxyUrl(url \| urls[])` | any proxy; several rotate across retries | none |
| `oxylabs({ username, password, type? })` | `pr.oxylabs.io:7777` / `dc.oxylabs.io:8000` | `customer-U-cc-US-sessid-…-sesstime-10` |
| `brightData({ customerId, zone, password })` | `brd.superproxy.io:33335` | `brd-customer-…-zone-…-country-us-session-…` |
| `decodo({ username, password })` (alias `smartproxy`) | `gate.decodo.com:7000` | `user-U-country-us-session-…-sessionduration-10` |
| `iproyal({ username, password })` | `geo.iproyal.com:12321` | password `P_country-us_session-…_lifetime-10m` |
| `zenrows({ apiKey })` | ZenRows API proxy mode | `premium_proxy=true&proxy_country=us&session_id=…` |
| `scrapingBee({ apiKey })` | ScrapingBee proxy mode | `premium_proxy=True&country_code=us&session_id=…` |
| `scraperApi({ apiKey })` | ScraperAPI proxy mode | `scraperapi.country_code=us.session_number=…` |
| `zyteApi({ apiKey })` | Zyte API itself | the request, forwarded unchanged |
| `template('http://u[-country-{country:lower}]-session-{session}:p@host:port')` | **any provider**, from its URL format | placeholders + optional `[parts]` |
| `custom(name, ctx => url)` | anything you build | you decide |

…and NodeMaven, SOAX, NetNut, Webshare, Rayobyte, PacketStream, Evomi, DataImpulse, Massive,
Proxy-Seller, Thordata, Anyip, ABCProxy, ProxyEmpire, RapidProxy, Swiftproxy, 922 S5, LunaProxy,
plus Crawlbase, Scrape.do, ScrapingAnt, ScrapeOps, Scrapfly, Oxylabs Web Unblocker and Zyte's
proxy mode, hosted browsers (Bright Data Scraping Browser, Browserless, ZenRows, Oxylabs,
NodeMaven), and API-only services (Scrappey, ScrapingBot). The full catalog, with credential
formats, env names and which ones were checked against a live account: [providers](docs/providers.md).

From env (what the CLI uses): `XYTE_PROVIDER=oxylabs` plus `OXYLABS_USERNAME` /
`OXYLABS_PASSWORD`, `XYTE_PROXY_URL=http://u:p@host:port`, or `XYTE_PROXY_TEMPLATE=…`.

The scraping-API presets (ZenRows, ScrapingBee, ScraperAPI) re-sign TLS, so they set `insecure`
automatically. They bill per request, so in a browser every sub-request of the page is billed.
Use them with `httpResponseBody`.

## Mixing providers, Zyte included

No single provider is the cheapest *and* gets through everywhere. Three combinators mix them
behind one client ([details and recipes](docs/routing.md)):

```ts
import { direct, oxylabs, rotate, route, Xyte, zyteApi } from 'xyte';

const residential = oxylabs({ username, password });
const zyte = zyteApi({ apiKey: process.env.ZYTE_API_KEY! });

const xyte = new Xyte({
  proxy: route(
    {
      'wolt.com': direct(),                               // answers anyone: free
      'restaurantguru.com': rotate([residential, zyte]),  // Zyte only after a ban
      'doordash.com': zyte,                               // only Zyte gets through
    },
    residential, // every other site
  ),
});
```

- **`rotate([a, b])`** picks by attempt: the first try uses `a`, the retry `b`, then `a` again.
  A fallback after a ban, or when a provider is down. Env: `XYTE_PROVIDER=oxylabs,zyte-api`.
- **`route({ host: provider }, fallback)`** picks by the target's host (subdomains included).
  Env: `XYTE_ROUTES=wolt.com=direct,doordash.com=zyte-api,restaurantguru.com=oxylabs+zyte-api`.
- **`adaptive([direct(), residential, zyte])`** learns it instead: per site, the cheapest
  provider that has been working, moving up after bans and back down when they stop.
  Env: `XYTE_ADAPTIVE=direct,oxylabs,zyte-api`.
- **`byKind({ http, browser })`**, **`byCountry({ US: p }, fallback)`**,
  **`byIpType({ datacenter, residential })`** pick by request kind, `geolocation`, `ipType`;
  **`weighted([[a, 9], [b, 1]])`** splits traffic.
- **`healthy(p)`** is a circuit breaker (a provider that keeps failing is skipped for a while
  instead of costing an attempt per request), **`budget(p, { max: 500, per: 'hour' })`** caps what
  a provider (say, the Zyte fallback) can spend.

- **`watch(p, { check })`** asks a provider's usage API or status page ahead of requests
  (ScrapingBee, ZenRows, ScraperAPI, Oxylabs, any Statuspage), so one that ran out of credits or is
  down is skipped before an attempt is spent on it. Env: `XYTE_WATCH=true`.

With `XYTE_REDIS_URL` (or a `store`), budgets, open circuits and checks are shared by every
instance. `browserFallback: true` retries a banned plain GET in a browser (JavaScript challenges),
returning the raw response as Zyte does.

### Seeing what it did

Every request can tell you what it took, without changing the Zyte response:

```ts
new Xyte({ proxy, onRequest: (report) => analytics.insert('scrapes', report) });
// report: outcome, provider that served it, every attempt (provider, route, result, ms,
// bytes on the wire), totals per provider, whether it escalated to a browser.
```

`xyte serve` adds `X-Xyte-Attempts: oxylabs-residential:ban,zyte-api:ok` and
`X-Xyte-Transfer-Bytes` to its responses, and `XYTE_LOG_REQUESTS=true` logs each report as a
JSON line, ready for BigQuery or Datadog. Success rates and MB per provider and site, and what
they cost at your rates: [observability](docs/observability.md).

**Zyte as a provider.** `zyteApi({ apiKey })` forwards the request to Zyte unchanged, so every
Zyte feature works, AI extraction included, and Zyte's answers (and errors) come back as Zyte
sent them. Even with only Zyte behind it, you get the library: typed requests, `XyteError`s,
retries, a concurrency limit, and the option to move sites to cheaper exits later without
touching calling code. `zyteProxy({ apiKey })` uses Zyte's proxy mode instead: xyte fetches and
renders, exiting through Zyte's IPs (no AI extraction). Env: `XYTE_PROVIDER=zyte-api` or `zyte`,
with `ZYTE_API_KEY`.

To find out which exit works for which site, measure it: `bun scripts/bench.ts cases.json
--providers zyte-api,direct,oxylabs` reports, per site and provider, how often the real page came
back (a captcha served with a 200 counts as a failure), the median latency and the page size.

## Errors and retries

`extract()` resolves with the Zyte 200 body, or rejects with an `XyteError` carrying Zyte's
`status`, `type`, `title` and `detail` (`error.toJSON()` is the problem body the server sends).

| Status | `type` | When | Retried by xyte |
| --- | --- | --- | --- |
| 400 | `/request/invalid` | malformed request (bad `url`, header syntax), a field xyte doesn't support, an AI field without an extractor | no |
| 400 | `/request/invalid-json` | the body isn't JSON (server) | no |
| 401 | `/auth/key-not-found` | wrong or missing key (server with `XYTE_API_KEYS`) | no |
| 421 | `/website/domain-unreachable` | the domain doesn't resolve (`direct()` only; through a proxy it's a 520) | no |
| 422 | `/request/unprocessable` | incompatible parameters (`browserHtml` + `httpResponseBody`, actions on an HTTP request…), or nothing requested | no |
| 500 | `/server/internal` | xyte misconfigured (a provider that can't build its URL, Playwright not installed) | no |
| 520 | `/download/website-ban` | every attempt was a ban | yes, then returned |
| 520 | `/download/temporary-error` | every attempt failed at the proxy or network level | yes, then returned |

A target's own 4xx/5xx is not an error: it's a 200 with `statusCode` set, as on Zyte. Bans are
403, 429, 503, or a known challenge page (Cloudflare, DataDome, PerimeterX, Imperva, Akamai);
override with `isBan`. Each retry goes through a fresh session (a new IP), with exponential
backoff; `onRetry` reports them. With `zyteApi()`, Zyte's own last problem is returned as Zyte
gave it. `error.retryable` says whether retrying later makes sense, as with Zyte's own clients
(true for 429, 500, 503 and 520, except xyte's own misconfiguration 500s).

## How Zyte behaviour maps

| Zyte | xyte |
| --- | --- |
| `geolocation` | the provider's country parameter; where the exit can't apply it (`direct()`, a plain proxy URL), the request runs with an `X-Xyte-Warning` header / `onWarning` |
| `ipType` | `byIpType()` |
| `session.id` | provider sticky session (same exit IP) plus a cookie jar kept across requests |
| no `session` | fresh exit per attempt: redirects and browser sub-requests share it, retries change it |
| `sessionContext` | a pool of sessions per context, initialized by `sessionContextParameters.actions`, retired after 4 h or 3 bans |
| bans | retried on a new exit, then **520** `/download/website-ban` |
| target 4xx/5xx | **200** with `statusCode` set |
| a `Cookie` custom header | dropped, as Zyte does (use `requestCookies`) |
| browser rendering | waits for the network to settle after load, so XHR data lands in `browserHtml` and `networkCapture` |

Checked side by side against api.zyte.com with `bun run test:live`: see
[migrating from Zyte](docs/migrating-from-zyte.md#checking-a-deployment).

## Supported fields

**HTTP:** `httpResponseBody`, `httpResponseHeaders`, `httpRequestMethod`, `httpRequestBody`,
`httpRequestText`, `customHttpRequestHeaders`, `requestHeaders.referer`, `followRedirect`,
`device`, `requestCookies`, `responseCookies`, `cookieManagement`, `session`, `geolocation`,
`ipType`, `echoData`, `jobId`.

**Browser** (Playwright, or [patchright and other forks](docs/browser.md), or a [remote browser](docs/browser.md#remote-browsers)):
`browserHtml`, `screenshot` + `screenshotOptions`, `javascript`, `viewport`, `includeIframes`,
`networkCapture` (url / resourceType filters, at most 10 captures and 5 MiB), the 60 s browser
time budget, and the actions `click`, `doubleClick`, `hover`, `hide`, `evaluate`, `goto`,
`reload`, `keyPress`, `type`, `select`, `scrollTo`, `scrollBottom`, `waitForNavigation`,
`waitForRequest`, `waitForResponse`, `waitForSelector`, `waitForTimeout` (with `onError`).

**Markdown**: built in and non-AI like Zyte's, with `mainContent` / `fullPage` scopes.

**AI extraction** (`product`, `article`, `jobPosting`, `serp`, `customAttributes`…): answered by
`zyteApi()`, or through any LLM using Zyte's own output schemas, so responses keep Zyte's shape
([extraction](docs/extraction.md)):

```ts
new Xyte({ extractors: llmExtractors({ complete: openAICompatible({ baseURL, apiKey, model }) }) });
```

Without either, those fields get a 400.

**Sessions**: `session.id` (client-managed: sticky exit + cookie jar) and `sessionContext` +
`sessionContextParameters` (server-managed pool).

**Not supported:** the Zyte-specific actions `searchKeyword`, `setLocation` and `interaction`
(400), and serving Zyte's other APIs: xyte's server answers `POST /v1/extract` only, not Zyte's
proxy-mode port or the Stats API (xyte can still *use* Zyte's proxy mode as a provider:
`zyteProxy()`). Field-by-field status: [coverage](docs/coverage.md).

## Development

```sh
bun install
bun test             # unit + integration (local target site, local proxy, real Chromium + patchright)
bun run test:node    # build, then run the dist on Node.js
bun run test:live    # real public sites through a local `xyte serve` (network required)
bun run typecheck
bun run build        # tsdown → dist/
bun run gen:types    # regenerate src/zyte.gen.ts from spec/zyte-openapi.json (and the coverage doc)
bun run docs:coverage  # regenerate docs/coverage.md from scripts/coverage.ts
bun scripts/bench.ts cases.json --providers zyte-api,direct,oxylabs   # compare providers on your sites
```

`test:live` takes `XYTE_LIVE_URL` (a deployed xyte, or `https://api.zyte.com/v1/extract` to run
the same checks against Zyte), `XYTE_LIVE_PROVIDER` and `XYTE_LIVE_HTTP_ONLY=true`; credentials
come from `.env`.

`spec/zyte-openapi.json` is Zyte's OpenAPI document, taken from the
[API reference](https://docs.zyte.com/zyte-api/usage/reference.html). One upstream typo is
patched: `ProductNavigation.required` was nested under `properties`.
