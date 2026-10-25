# Combining providers

No single provider is the cheapest *and* gets through everywhere. xyte lets one client mix them:
a different exit per site, a fallback when one gets banned, datacenter vs residential per request.
Your calling code doesn't change; only the `proxy` option (or `XYTE_PROVIDER` / `XYTE_ROUTES`) does.

| Combinator | Picks the provider by | Typical use |
| --- | --- | --- |
| [`rotate([a, b, …])`](#rotate-fall-back-on-retries) | the attempt number | fall back to another provider after a ban or an outage |
| [`route({ host: p }, fallback)`](#route-a-provider-per-site) | the target's host | the cheapest exit that works on each site |
| [`adaptive([cheap, …, expensive])`](#adaptive-learn-the-cheapest-provider-per-site) | what worked on the site lately | `route()` without maintaining it: learns per site, follows changes |
| [`byKind({ http, browser })`](#bykind-http-or-browser) | HTTP request or browser render | per-request APIs for HTTP, per-GB proxies for renders |
| [`byCountry({ US: p }, fallback)`](#bycountry-by-geolocation) | the request's `geolocation` | the network that's best (or cheapest) in each country |
| [`byIpType({ datacenter, residential })`](#byiptype-datacenter-or-residential) | the request's `ipType` | cheap datacenter IPs unless a request asks for residential |
| [`weighted([[a, 9], [b, 1]])`](#weighted-split-traffic) | a weighted draw per request | trying a new provider on a share of traffic |
| [`custom(name, ctx => …)`](providers.md#writing-a-provider) | anything in the context | your own rules |

And two wrappers that guard a provider wherever it's used:

| Wrapper | Does | Typical use |
| --- | --- | --- |
| [`healthy(p, { failures, cooldown })`](#healthy-a-circuit-breaker) | takes `p` out for a while after repeated proxy failures | an outage costs no attempts, not one per request |
| [`budget(p, { max, per })`](#budget-cap-what-a-provider-can-spend) | caps the attempts `p` gets per time window | a Zyte fallback that can't run up the bill |
| [`watch(p, { check })`](#watch-check-providers-ahead-of-requests) | asks `p`'s usage API or status page, in the background | skip a provider whose credits ran out, or that's down, before an attempt is spent on it |

With a [shared store](#shared-state-across-instances-redis) (Redis), every instance of a
deployment sees the same budgets, open circuits and checks.

They all nest: a `route` can send a site to a `rotate` of a `healthy` proxy and a `budget`ed
`zyteApi()`. [`onAttempt`](#watching-what-happens-onattempt) shows which provider served each
attempt and how it went; [observability](observability.md) has the per-request reports.

## How attempts work

Every request gets up to `retries + 1` attempts (default `retries: 3`, so 4 attempts). An attempt
is retried when the page is a ban (403, 429, 503, or a known challenge page: Cloudflare, DataDome,
PerimeterX, Imperva, Akamai), when the proxy fails (407, connection errors, timeouts), or when an
upstream API answers 429/5xx. Retries wait with exponential backoff (about 0.5 s, 1 s, 2 s…, at
most 8 s).

Each attempt asks the provider for an exit with a context: the target URL, the country
(`geolocation`), the `ipType`, a session id, and the attempt number (0, 1, 2…).

- **Without `session`**, every attempt gets a fresh session id, so a retry leaves from a new IP.
  Redirects and the browser's sub-requests within one attempt share the attempt's IP.
- **With `session.id`**, every attempt reuses that id, so the provider keeps the same sticky IP
  and xyte keeps the session's cookies. A retry of a banned pinned session goes out on the same
  IP; if you see repeated 520s, start a new session id, as you would on Zyte.
- **With `sessionContext`**, sessions come from a pool; a banned one is skipped for the rest of
  the request and retired after 3 bans.

Some attempts are **passed over** instead: the provider a combinator picked can't serve the
request (an HTML-only API asked for actions, your action handler on `zyteApi()`, an action headed
for Zyte), so the next provider gets the turn without a request, a backoff or a used-up retry.
[Actions](actions.md#pass-overs) has the rules.

What isn't retried: a target's own 4xx/5xx other than the ban statuses (returned in `statusCode`,
as on Zyte), invalid requests (400/422), and configuration errors (500).

After each attempt the client tells the provider how it went (`ok`, `ban`, `error`, or `aborted`
when the attempt says nothing about the provider), and combinators pass that on to the child
they chose. That's what `adaptive`, `healthy` and `budget` learn from; your own providers can
implement `report()` and `available()` too ([writing a provider](providers.md#writing-a-provider)).

### `browserFallback`: retry a banned page in a browser

`new Xyte({ browserFallback: true })` (env `XYTE_BROWSER_FALLBACK=true`): when a plain HTTP request
(a GET with no body) is banned, the remaining attempts render it in a browser, which runs
JavaScript challenges, and return the page's raw HTTP response as `httpResponseBody`, the same
shape as before. That is what Zyte does when it decides a site needs a browser. It gets past
challenges that only check for JavaScript; it doesn't help when the site blocks the IP itself
(Restaurant Guru and yelp.com block a home IP even in a stealth browser): that takes another exit.
The browser attempts tell providers `browser: true`, so `byKind()` sends them to its browser
provider.

## `rotate()`: fall back on retries

```ts
rotate([oxylabs({ username, password }), zyteApi({ apiKey })]);
```

Attempt *n* uses provider *n mod length*. With the default 3 retries and two providers, the
attempts go a, b, a, b. Typical uses:

- **Cheap first, Zyte as the safety net.** Most requests succeed on the residential proxy; only
  the ones it gets banned on reach Zyte, so Zyte bills only those.
- **Two networks for availability.** If one is down (every login rejected with a 407, a
  gateway outage), you lose one attempt instead of the request.

`rotate([a, a, b])` weights it: two attempts on `a` before trying `b`. For more attempts in total,
raise `retries`.

From env: `XYTE_PROVIDER=oxylabs,zyte-api`.

## `route()`: a provider per site

```ts
const residential = oxylabs({ username, password });
const zyte = zyteApi({ apiKey });

route(
  {
    'wolt.com': direct(),                    // its API answers anyone: free
    'yelp.co.uk': direct(),
    'restaurantguru.com': rotate([residential, zyte]),
    'doordash.com': zyte,                    // only Zyte's browser gets through
  },
  residential, // every other site
);
```

A key matches the host and its subdomains (`doordash.com` matches `www.doordash.com` and
`api.doordash.com`); the longest key wins, so `api.doordash.com` can have its own entry. All
attempts of a request stay on its route; put a `rotate()` inside the route for a fallback.

From env, with `XYTE_PROVIDER` as the fallback and `+` for a rotation:

```sh
XYTE_PROVIDER=oxylabs
XYTE_ROUTES=wolt.com=direct,yelp.co.uk=direct,restaurantguru.com=oxylabs+zyte-api,doordash.com=zyte-api
```

To find out which exit works for which site, measure it: `bun scripts/bench.ts cases.json
--providers zyte-api,direct,oxylabs` runs the same requests through each and reports how often
each gets the real page (a regex per case, so a captcha served with a 200 counts as a failure),
the median latency and the page size.

`direct()` from your laptop is not `direct()` from a cloud host. At home or in an office it exits
from a residential-looking IP; on Cloud Run or Fly it exits from a datacenter IP, which more sites
block. Benchmark from where you deploy.

## `adaptive()`: learn the cheapest provider per site

```ts
const smart = adaptive([direct(), oxylabs({ username, password }), zyteApi({ apiKey })]);
new Xyte({ proxy: smart });
smart.scores(); // { 'wolt.com': { direct: 1 }, 'doordash.com': { direct: 0.41, 'oxylabs-residential': 0.33, 'zyte-api': 1 } }
```

`route()` that maintains itself. List providers cheapest first. For each site (the host without
`www.`), every provider has a success score that starts at 1 and follows outcomes: an `ok` moves
it up, a ban or an error moves it down (`learningRate`, default 0.2, so about four failures in a
row take a fresh score below the threshold). Each request starts at the first provider whose score
on that site is at least `minSuccess` (default 0.5); a retry moves to the next one up. A share of
requests (`explore`, default 5%) starts at a cheaper provider again, so when a site stops blocking
it, traffic moves back down.

What it costs: until it has learned a site, requests try the cheap providers first and spend
attempts on bans (raise `retries` so the expensive end is still reachable). Scores live in
memory, per process: each instance learns on its own, and a restart starts over.

From env: `XYTE_ADAPTIVE=direct,oxylabs,zyte-api` (instead of `XYTE_PROVIDER`).

## `byKind()`: HTTP or browser

```ts
byKind({ http: scrapingBee({ apiKey }), browser: oxylabs({ username, password }) });
```

Scraping APIs bill every request, and a browser render makes dozens (scripts, images, XHR);
residential proxies bill per GB. This sends plain HTTP requests to one and renders to the other.
From env: `XYTE_BROWSER_PROVIDER=oxylabs` (renders), with `XYTE_PROVIDER` for HTTP.

## `byCountry()`: by geolocation

```ts
byCountry({ US: oxylabs({ username, password }), FI: direct() }, decodo({ username, password }));
```

Picks by the request's `geolocation` (ISO 3166-1 alpha-2, case-insensitive); requests without one,
or for other countries, use the fallback.

## `weighted()`: split traffic

```ts
weighted([[oxylabs({ username, password }), 9], [decodo({ username, password }), 1]]);
```

Each request draws once (from its id, so all its attempts agree); a retry moves on to the next
provider in the list. With `onAttempt` feeding your metrics, it's an A/B test of providers on real
traffic.

## `healthy()`: a circuit breaker

```ts
rotate([healthy(oxylabs({ username, password }), { failures: 5, cooldown: 60 }), zyteApi({ apiKey })]);
```

After `failures` consecutive proxy or network errors (rejected logins, an unreachable gateway,
timeouts), the provider is unavailable for `cooldown` seconds and `rotate()`, `route()`,
`weighted()` and `adaptive()` go straight past it. Without it, a provider that is down costs one
attempt per request. After the cooldown, one attempt is let through: success closes the circuit,
a failure reopens it. Bans don't count (the provider works; the site blocked an IP). Used alone,
an open circuit doesn't block anything, since there's nothing to fall back to. `onChange(open)`
reports transitions.

From env: `XYTE_CIRCUIT_BREAKER=5,60` wraps every provider named in `XYTE_PROVIDER`,
`XYTE_ROUTES`, `XYTE_ADAPTIVE` and `XYTE_BROWSER_PROVIDER`.

## `budget()`: cap what a provider can spend

```ts
rotate([residential, budget(zyteApi({ apiKey }), { max: 500, per: 'hour' })]);
```

At most `max` attempts per window (`per`: seconds, or `'minute'`, `'hour'`, `'day'`; windows are
fixed, starting on the clock), counted when an attempt goes out; attempts that failed at the
network level are given back. Once spent, combinators skip it. Used alone (or when every provider
of a `rotate` is spent), requests fail with **429** `/limits/over-user-limit`, which
`error.retryable` marks for a later retry. Per process, unless you pass a shared `store`.

From env: `XYTE_BUDGET=zyte-api=500/hour,scrapingbee=1000/day`. A provider named in several env
variables is one instance, so its budget is shared.

## `watch()`: check providers ahead of requests

```ts
import { rotate, scrapingBee, scrapingBeeUsage, statusPage, watch, zyteApi } from 'xyte';

const bee = watch(scrapingBee({ apiKey }), { check: scrapingBeeUsage({ apiKey, minRemaining: 500 }), every: 60 });
const zyte = watch(zyteApi({ apiKey: zyteKey }), { check: statusPage('https://status.zyte.com') });
await bee.refresh(); // optional: know before the first request
bee.status(); // { available: true, remaining: 680, detail: 'scrapingbee 320/1000 credits used' }

new Xyte({ proxy: rotate([bee, zyte]) });
```

`watch()` runs its checks every `every` seconds (default 60) in the background, never on the
request path, and reports the provider unavailable while any check says so; `rotate()`, `route()`,
`weighted()` and `adaptive()` then go straight to the others. Until the first check answers, the
provider counts as available; a check that fails (the usage API itself is down) keeps the last
answer and calls `onError`. `onChange(result)` hears about every switch.

Built-in checks:

| Check | Asks | Unavailable when | Checked live |
| --- | --- | --- | --- |
| `scrapingBeeUsage({ apiKey, minRemaining? })` | `app.scrapingbee.com/api/v1/usage` | credits left ≤ `minRemaining` | ✅ |
| `zenrowsUsage({ apiKey, maxPercent? })` | `api.zenrows.com/v1/subscriptions/self/details` | subscription inactive, usage ≥ `maxPercent`, or the key's caps spent | docs |
| `scraperApiUsage({ apiKey })` | `api.scraperapi.com/account` | `requestCount` reaches `requestLimit` | docs |
| `oxylabsUsage({ username, password, limitGB, maxPercent? })` | `residential-api.oxylabs.io/v2` (login, then `client-stats`) | this month's GB reach `maxPercent` of `limitGB` (the API reports usage, not your limit) | docs; needs the account's *main* proxy user |
| `statusPage(url, { downOn? })` | any Statuspage page (`/api/v2/status.json`): Zyte, IPRoyal, Webshare… | its indicator is `major` or `critical` | ✅ (Zyte) |

A check is just `(signal) => Promise<{ available, detail?, remaining? }>`, so anything else (an
internal quota service, a Redis key your billing job writes) fits too. Pass several in an array:
all must pass.

From env: `XYTE_WATCH=true` watches every named provider that has a built-in check (ScrapingBee,
ZenRows, ScraperAPI, Zyte, IPRoyal, Webshare; Oxylabs with `OXYLABS_LIMIT_GB`, and
`OXYLABS_API_USERNAME` / `OXYLABS_API_PASSWORD` if the proxy user isn't the main one), every
`XYTE_WATCH_EVERY` seconds, logging switches to stderr.

## Shared state across instances (Redis)

`budget()`, `healthy()` and `watch()` keep their state in the process by default: with several
instances (Cloud Run scales out), each has its own budget and its own circuits. Pass a shared
`StateStore` and they share it:

```ts
import { budget, healthy, redisStore, redisStoreFromUrl, watch } from 'xyte';

const store = redisStoreFromUrl(process.env.REDIS_URL!); // Bun's client, else ioredis or redis if installed
// or with your own client: redisStore((cmd) => redis.call(cmd[0]!, ...cmd.slice(1)))

budget(zyte, { max: 500, per: 'hour', store });          // one budget for the whole deployment
healthy(oxylabs(…), { failures: 5, cooldown: 60, store }); // a circuit one instance opens is open for all
watch(bee, { check, store });                              // one instance checks, the others reuse its answer
```

| Wrapper | Key | Shared |
| --- | --- | --- |
| `budget` | `xyte:budget:<name>:<window>` | the count per window (INCRBY, expiring with the window) |
| `healthy` | `xyte:circuit:<name>` | an open circuit, for its cooldown (each instance still counts its own failures) |
| `watch` | `xyte:watch:<name>` | the last check result, for `every` seconds |

`<name>` is the provider's name unless you pass `key`. Nothing waits on Redis except a budget's
increment when an attempt goes out (one round trip); circuits and checks are read in the
background. If Redis is down, they fall back to process memory and say so once (`resilient()`),
so requests never fail because of the store.

From env: `XYTE_REDIS_URL=redis://…` shares the state of everything built from `XYTE_BUDGET`,
`XYTE_CIRCUIT_BREAKER` and `XYTE_WATCH`.

## Watching what happens: `onAttempt`

```ts
new Xyte({
  proxy,
  onAttempt: ({ provider, result, ms, bytes, url, attempt, browser }) =>
    metrics.increment('scrape.attempt', { provider, result, host: new URL(url).hostname }),
});
```

Called after every attempt with the provider that served it (the leaf a combinator picked, e.g.
`oxylabs-residential`, not `rotate(…)`), the result, latency, status and page size. Success rates
per provider and site, and what each provider costs you, come from there.

## `byIpType()`: datacenter or residential

```ts
byIpType({
  datacenter: oxylabs({ username, password, type: 'datacenter' }),
  residential: oxylabs({ username, password }),
});
```

Uses the request's `ipType` (`"datacenter"` or `"residential"`, as in Zyte's API). Without one, it
uses `datacenter` if configured (pass `default: 'residential'` to change that).

## AI extraction with mixed providers

`product`, `article` and the other AI fields are answered by `zyteApi()` itself, or by a local
extractor ([extraction](extraction.md)). When a combinator mixes Zyte with providers that can't
extract, a request whose attempt lands on a provider without an extractor gets a 400. Configure
`extractors` too, or route the sites you extract from to `zyteApi()`.

## Costs

| Provider kind | Billed by | Browser requests |
| --- | --- | --- |
| `direct()` | nothing | free |
| Residential / datacenter proxies (Oxylabs, Decodo, IPRoyal…) | GB transferred | every sub-request's bytes: set `browser.blockResources` (`XYTE_BLOCK_RESOURCES=image,media,font`) |
| Scraping APIs in proxy mode (ScrapingBee, ZenRows, ScraperAPI…) | request (premium/JS multipliers) | every sub-request is a billed request: use them for `httpResponseBody` |
| `zyteApi()` | request, by site difficulty and features | one request |

Retries are billed by providers that bill failures; xyte retries only bans, proxy failures and
upstream 429/5xx.
