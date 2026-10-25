# Combining providers

No single provider is the cheapest *and* gets through everywhere. xyte lets one client mix them:
a different exit per site, a fallback when one gets banned, datacenter vs residential per request.
Your calling code doesn't change; only the `proxy` option (or `XYTE_PROVIDER` / `XYTE_ROUTES`) does.

| Combinator | Picks the provider by | Typical use |
| --- | --- | --- |
| [`rotate([a, b, …])`](#rotate-fall-back-on-retries) | the attempt number | fall back to another provider after a ban or an outage |
| [`route({ host: p }, fallback)`](#route-a-provider-per-site) | the target's host | the cheapest exit that works on each site |
| [`byIpType({ datacenter, residential })`](#byiptype-datacenter-or-residential) | the request's `ipType` | cheap datacenter IPs unless a request asks for residential |
| [`custom(name, ctx => …)`](providers.md#writing-a-provider) | anything in the context | your own rules |

They nest: a `route` can send a site to a `rotate`, which can include `zyteApi()`.

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

What isn't retried: a target's own 4xx/5xx other than the ban statuses (returned in `statusCode`,
as on Zyte), invalid requests (400/422), and configuration errors (500).

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
