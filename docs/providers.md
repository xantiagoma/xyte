# Providers

A provider turns what a Zyte request asks for (`geolocation`, `ipType`, `session.id`) into a
proxy for one attempt. Every preset follows the same rules:

- **Country**: the request's `geolocation`, in the provider's format (`-country-us`, `_c_US`,
  `cr.us`…). No `geolocation` means the country part is left out.
- **Session**: one sticky session per attempt, so redirects and browser sub-requests share an
  exit, and a retry gets a new IP. With `session: { id }` on the request, the same exit is kept
  across requests (as long as the provider honours it).
- **Credentials**: in code, or from env vars via `XYTE_PROVIDER=<name>` (see the table).

```ts
import { Xyte, nodeMaven, rotate, zenrows } from '@xtandard/xyte';

new Xyte({
  proxy: rotate([nodeMaven({ username, password }), zenrows({ apiKey })]),
});
```

To mix providers (a fallback on retries, a provider per site, datacenter vs residential), see
[combining providers](routing.md).

**Confidence**: 🟢 run against a live account (`XYTE_LIVE_PROVIDER=<name> bun run test:live`).
✅ format taken from the provider's own docs. 🟡 from partial or third-party sources: check it
against your dashboard on the first request. The unit tests check the exact credentials each
preset produces.

Checked live on 2026-10-24: `oxylabs` residential (full suite 20/20, browser included; `geolocation` exits on residential ISPs), `scrapingbee` (HTTP suite 16/16, `geolocation` exits on residential
ISPs), `zyte-api` (AI extraction), `zyte` (proxy mode, `geolocation`). ScrapingBee notes: the
preset sets `forward_headers_pure` so custom headers and cookies reach the site, reads its
`Resolved-Url` header for the final URL after redirects, hides its `Spb-*` headers, and retries its
own unbilled 5xx answers (unresolvable domain, target 5xx), which end as a `520`. If one is off for your plan, use [`template()`](#any-other-provider-template) with the
format from your dashboard, and please open an issue.

## Residential and datacenter networks

| Preset | `XYTE_PROVIDER` · env | Gateway | Credentials produced | |
| --- | --- | --- | --- | --- |
| `oxylabs({ username, password, type? })` | `oxylabs` · `OXYLABS_USERNAME/PASSWORD` | `pr.oxylabs.io:7777`, `dc.oxylabs.io:8000` | `customer-U-cc-US-sessid-…-sesstime-10` |🟢 |
| `brightData({ customerId, zone, password })` | `brightdata` · `BRIGHTDATA_CUSTOMER_ID/ZONE/PASSWORD` | `brd.superproxy.io:33335` | `brd-customer-…-zone-…-country-us-session-…` | ✅ |
| `decodo({ username, password })` (`smartproxy`) | `decodo` | `gate.decodo.com:7000` | `user-U-country-us-session-…-sessionduration-10` | ✅ |
| `iproyal({ username, password })` | `iproyal` | `geo.iproyal.com:12321` | password `P_country-us_session-…_lifetime-10m` | ✅ |
| `nodeMaven({ username, password, type?, filter? })` | `nodemaven` | `gate.nodemaven.com:8080` | `U-country-us-sid-…-ttl-10m` | ✅ |
| `soax({ packageId, packageKey })` | `soax` · `SOAX_PACKAGE_ID/KEY` | `proxy.soax.com:5000` | `package-ID-country-us-sessionid-…-sessionlength-600` | ✅ |
| `netNut({ username, password })` | `netnut` | `gw.netnut.net:5959` | `U-res-us-sid-123456789` | 🟡 |
| `webshare({ username, password, sticky? })` | `webshare` | `p.webshare.io:80` | `U-us-1234` (or `U-us-rotate`) | ✅ |
| `rayobyte({ username, password })` | `rayobyte` | `us-east.gw.rayobyte.com:8000` | password `P-country-US-session-…-duration-10` | ✅ |
| `packetStream({ username, password })` | `packetstream` | `proxy.packetstream.io:31112` | password `KEY_country-US_session-…` | ✅ |
| `evomi({ username, password })` | `evomi` | `rp.evomi.com:1000` | password `P_country-US_session-…_lifetime-30` | ✅ |
| `dataImpulse({ username, password })` | `dataimpulse` | `gw.dataimpulse.com:823` | `LOGIN__cr.us;sessid.…` | ✅ |
| `massive({ username, password })` | `massive` | `network.joinmassive.com:65534` | `U-country-US-session-…-sessionttl-15` | ✅ |
| `proxySeller({ username, password })` | `proxyseller` | `res.proxy-seller.com:10000` | `U_c_US_s_…_ttl_15m` | ✅ |
| `anyIp({ username, password })` | `anyip` | `portal.anyip.io:1080` | `user_ID,country_US,session_…,sesstime_10` | 🟡 host |
| `thordata({ username, password })` | `thordata` | `t.pr.thordata.net:9999` | `td-customer-U-country-us-sessid-…-sesstime-10` | ✅ |
| `abcProxy({ username, password })` | `abcproxy` | `proxy.abcproxy.com:4950` | `U-zone-abc-region-us-session-…-sessTime-10` | 🟡 |
| `proxyEmpire({ username, password })` | `proxyempire` | `v2.proxyempire.io:5000` | `U-country-us-sid-…` | 🟡 |
| `rapidProxy({ username, password })` | `rapidproxy` | `eu.rapidproxy.io:5001` | `U-residential-US-session-12345678-stime-10` | 🟡 |
| `swiftProxy({ username, password })` | `swiftproxy` | `us.swiftproxy.net:7878` | `U_custom_zone_US` (sticky only via dashboard) | 🟡 |
| `proxy922({ username, password, host, port })` | — | per account | `U-region-FR-sessid-…-sessTime-10` | 🟡 |
| `lunaProxy({ username, password, host, port })` | — | per account | `user-U-region-us-sessid-…-sesstime-10` | 🟡 |

Every user+password preset also reads `NAME_HOST` and `NAME_PORT`, e.g. `EVOMI_HOST`, to switch
gateways (regional hosts, SOCKS ports, an ISP or mobile pool).

## Scraping APIs in proxy mode

They solve anti-bot on their side and bill per request. They re-sign TLS, so they're marked
`insecure` automatically. Use them with `httpResponseBody`: in a browser, every sub-request of
the page is a billed request. A good pattern is a residential network first and a scraping API
as the retry fallback: `rotate([nodeMaven(…), zenrows(…)])`.

| Preset | `XYTE_PROVIDER` · env | Endpoint | Parameters go in | |
| --- | --- | --- | --- | --- |
| `zenrows({ apiKey })` | `zenrows` · `ZENROWS_API_KEY` | `api.zenrows.com:8001` | password | ✅ |
| `scrapingBee({ apiKey })` | `scrapingbee` | `proxy.scrapingbee.com:8886` | password | 🟢 |
| `scraperApi({ apiKey })` | `scraperapi` | `proxy-server.scraperapi.com:8001` | username | ✅ |
| `crawlbase({ token })` | `crawlbase` · `CRAWLBASE_TOKEN` | `smartproxy.crawlbase.com:8012` | `CrawlbaseAPI-*` headers | ✅ |
| `scrapeDo({ token })` | `scrapedo` · `SCRAPEDO_TOKEN` | `proxy.scrape.do:8080` | password | ✅ |
| `scrapingAnt({ apiKey })` | `scrapingant` | `proxy.scrapingant.com:8080` | username | 🟡 country |
| `scrapeOps({ apiKey })` | `scrapeops` | `proxy.scrapeops.io:5353` | username | 🟡 |
| `scrapfly({ apiKey })` | `scrapfly` | `proxy.scrapfly.io:7777` | username | 🟡 |
| `oxylabsUnblocker({ username, password })` | `oxylabs-unblocker` | `unblock.oxylabs.io:60000` | `x-oxylabs-*` headers | ✅ |
| `brightData({ … zone: 'your-unlocker-zone' })` | `brightdata` | `brd.superproxy.io:33335` | username (Web Unlocker is a zone) | ✅ |
| `zyteProxy({ apiKey })` | `zyte` · `ZYTE_API_KEY` | `api.zyte.com:8011` | `Zyte-*` headers | 🟢 |

`zyteProxy` lets Zyte itself be one provider among others, for example the last resort in
`rotate([residential, zyteProxy({ apiKey })])`.

Header-based parameters (Crawlbase, Oxylabs, Zyte) travel as `ProxyEndpoint.headers`. xyte adds
them to every request, including browser sub-requests.

## Remote browsers

For `browser.connect` ([browser.md](browser.md#remote-browsers)): hosted Chromium over CDP that
handles its own proxying. Select one with `XYTE_REMOTE_BROWSER=<name>`.

| Preset | `XYTE_REMOTE_BROWSER` · env | Endpoint | |
| --- | --- | --- | --- |
| `brightDataBrowser({ customerId, zone, password })` | `brightdata` · `BRIGHTDATA_CUSTOMER_ID`, `BRIGHTDATA_BROWSER_ZONE/PASSWORD` | `wss://brd-customer-…-country-us:P@brd.superproxy.io:9222` | ✅ |
| `browserless({ token, region? })` | `browserless` · `BROWSERLESS_TOKEN`, `BROWSERLESS_REGION` | `wss://production-sfo.browserless.io?token=…&proxy=residential&proxyCountry=us` | ✅ |
| `zenrowsBrowser({ apiKey })` | `zenrows` · `ZENROWS_API_KEY` | `wss://browser.zenrows.com?apikey=…&proxy_country=us` | ✅ |
| `oxylabsBrowser({ username, password })` | `oxylabs` · `OXYLABS_BROWSER_USERNAME/PASSWORD` | `wss://U:P@ubc.oxylabs.io?p_cc=US` | 🟡 |
| `nodeMavenBrowser({ username, password })` | `nodemaven` | `wss://U-country-us-sid-…:P@browser.nodemaven.com:8080` | 🟡 |

**Browserbase, Hyperbrowser and Steel** create a session over REST first, then return a
WebSocket URL. `connect` can be async, so they work as a few lines of your own code:

```ts
connect: async ({ country }) => {
  const res = await fetch('https://api.browserbase.com/v1/sessions', {
    method: 'POST',
    headers: { 'X-BB-API-Key': key, 'content-type': 'application/json' },
    body: JSON.stringify({ projectId, proxies: country ? [{ type: 'browserbase', geolocation: { country } }] : true }),
  });
  return (await res.json()).connectUrl;
},
```

## Any other provider: `template()`

Write the provider's format once:

```ts
import { template } from '@xtandard/xyte';

template('http://{env:INFATICA_USER}[_c_{country}]_s_{session}_ttl_30m:{env:INFATICA_PASS}@pool.infatica.io:10000');
```

| Placeholder | Value |
| --- | --- |
| `{country}`, `{country:lower}` | ISO-2 from `geolocation` |
| `{session}`, `{session:8}` | alphanumeric sticky token (default length 12) |
| `{session:number}`, `{session:number:99999}` | numeric session id below a max |
| `{ipType}`, `{attempt}` | from the request / retry count |
| `{env:NAME}` | an environment variable |
| `[ … ]` | optional: dropped if a placeholder inside has no value |

Values are URL-encoded and literal text is not. With no code: `XYTE_PROXY_TEMPLATE='…'` (and
`XYTE_PROXY_INSECURE=true` for MITM proxies).

Formats for providers without a preset (🟡, check your dashboard):

| Provider | Template |
| --- | --- |
| Infatica | `http://U[_c_{country}]_s_{session}_ttl_30m:P@pool.infatica.io:10000` |
| Geonode | `http://U[-country-{country:lower}]-session-{session:8}-lifetime-10:P@proxy.geonode.io:10000` |
| PyProxy | `http://U[-country-{country:lower}]:P@gw.pyproxy.com:1111` |
| Live Proxies | `http://U[-country-{country:lower}]-session-{session}:P@b2b.liveproxies.io:7383` |
| Proxy-Cheap, Froxy, ProxyLane | Copy the endpoint from the dashboard: `proxyUrl('http://…')` (ProxyLane: "Keep the same IP" in the dashboard) |

## API-only services

Some services have no proxy port: they take a URL and return the page. These adapters resolve to
an `ApiEndpoint`: they get the whole Zyte request and answer in Zyte's shape. Retries, ban
detection, extractors and `rotate()` work as with proxies, so the two kinds can be mixed:
`rotate([nodeMaven(…), scrappey(…), zyteApi(…)])`.

| Adapter | `XYTE_PROVIDER` · env | Notes | |
| --- | --- | --- | --- |
| `zyteApi({ apiKey, endpoint?, name? })` | `zyte-api` · `ZYTE_API_KEY` | Forwards the request to Zyte unchanged, so **every** Zyte feature works (AI extraction, actions, sessions). Zyte's bans and problems pass through. Bans aren't re-checked locally. `endpoint` takes any Zyte-compatible `/v1/extract`. | 🟢 |
| `xyteApi({ endpoint, apiKey, name? })` | – | Another `xyte serve` (say, a deployment with its own proxy), as `zyteApi()` does it, plus its report: see [below](#another-xyte-server-as-a-provider) | 🟢 |
| `scrappey({ apiKey })` | `scrappey` · `SCRAPPEY_API_KEY` | `requestType` browser/request from the request, `proxyCountry`, cookies, headers, POST bodies | 🟡 response fields |
| `scrapingBot({ username, apiKey, options? })` | `scrapingbot` · `SCRAPINGBOT_USERNAME/API_KEY` | Raw HTML API; the target status isn't reported (assumed 200) | 🟡 option names |

Scrappey and ScrapingBot return a page's HTML: they don't run actions, take screenshots or capture
network responses, and their endpoints say so (`ApiEndpoint.unsupported`). Inside a combinator, a
request that needs those passes them over for a provider that can (no request, no retry used up).
Alone, actions are skipped (`notExecuted` with the reason, plus a warning) or rejected with
`unsupportedActions: 'error'`, and a `screenshot` or `networkCapture` is a 400. An `ApiEndpoint`
you write can declare the same: `unsupported: (request) => request.screenshot ? ['screenshot'] : []`.
Which provider runs which actions: [actions](actions.md#which-providers-run-them).

**Account problems.** A 401 or 403 from `zyteApi()` or `xyteApi()` (Zyte's `/auth/not-valid`,
`/auth/key-not-found`, `/auth/account-suspended`: a bad key, an account out of balance) is the
provider's failure, not the request's. Inside a combinator the request moves on to the next
provider and that one isn't tried again for it; the attempt is an `error`, so `healthy()` opens
the circuit (at once, for these), and `budget()` and `adaptive()` count it. Alone, the problem
comes back as Zyte sent it (`retryable: false`), after a single call. A 400 or 422 is still the
request's: it comes back as is, combinator or not.

### Another xyte server as a provider

```ts
import { rotate, xyteApi, zyteApi } from '@xtandard/xyte';

const proxy = rotate([
  zyteApi({ apiKey: process.env.ZYTE_API_KEY! }),
  xyteApi({ endpoint: 'https://you--xyte-oxylabs-serve.modal.run/v1/extract', apiKey: process.env.XYTE_KEY!, name: 'xyte-oxylabs' }),
  xyteApi({ endpoint: 'https://you--xyte-decodo-serve.modal.run/v1/extract', apiKey: process.env.XYTE_KEY!, name: 'xyte-decodo' }),
]);
```

`xyteApi()` is `zyteApi()` with a required `endpoint` that also reads the remote server's
[report headers](observability.md#server-headers). Each local attempt gets `upstream`: the remote
attempts (`[{ provider: 'oxylabs-residential', result: 'ban' }, { provider: 'oxylabs-residential',
result: 'ok' }]`) and its request id. Its `transferBytes` are the remote ones, so a per-GB
[rate](routing.md#costs) on `xyte-oxylabs` prices it. `zyteApi({ endpoint })` would work too,
without the detail. An attempt on it waits up to `timeout` seconds (default 150, rather than the
client's `timeout`), since the remote retries on its side. The client needs no browser: the
remote renders. The whole pattern, with Modal and Cloud Run fleets, is in
[deploying](deploy.md#a-thin-client-and-a-remote-fleet).

**Names.** Every `zyteApi()` is called `zyte-api` unless you pass `name`; give each endpoint its
own, so each has its own line in reports, `rates`, circuits, budgets and `adaptive()`. For any
other provider, `named('oxylabs-us', oxylabs({ … }))` does the same.

`zyteApi()` vs `zyteProxy()`: the API adapter has full fidelity, AI extraction included. Proxy mode
only carries HTTP and browser HTML, but goes through xyte's own engines and extractors.

Write your own by returning `{ api: async (request, { context, signal }) => ({ response,
statusCode, html }) }` from a provider's `resolve`; see `src/apis.ts`.

## Writing a provider

```ts
import type { ProxyProvider } from '@xtandard/xyte';

const mine: ProxyProvider = {
  name: 'mine',
  resolve: ({ country, sessionId, attempt, ipType, browser, url }) => ({
    url: `http://user-${country ?? 'any'}-${sessionId.slice(0, 8)}:pass@gw.example.com:8000`,
    insecure: false, // true if the proxy re-signs TLS
    headers: {}, // per-request headers for header-driven APIs
  }),
};
```

`resolve` may be async: fetch a proxy from a pool API, skip a provider that's out of credit, or
return `null` to go direct. It can also return an `ApiEndpoint` (see above).

Two optional methods let a provider take part in the [combinators](routing.md):

```ts
const pooled: ProxyProvider = {
  name: 'pool',
  resolve: (context) => ({ url: pool.next() }),
  // False while it shouldn't be used: rotate(), route(), weighted() and adaptive() skip it.
  available: (context) => pool.size > 0,
  // How each attempt it served went: 'ok' | 'ban' | 'error' | 'aborted', with ms, statusCode, bytes.
  report: (context, outcome) => {
    if (outcome.result === 'ban') pool.retire(context.sessionId);
  },
};
```

Endpoints can also set `appliesCountry: false` (the exit ignores `geolocation`, so requests get a
warning), and scraping APIs in proxy mode `inspect` (read the final URL or the API's own errors
from its response headers) and `hiddenHeaders` (drop its bookkeeping headers from
`httpResponseHeaders`); see `scrapingBee()` in `src/proxy.ts`.
