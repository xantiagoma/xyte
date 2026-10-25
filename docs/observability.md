# Observability

xyte is a small scraping orchestrator: one request can go through a route, a rotation, a circuit
breaker, a budget, a ban and a retry before it comes back. All of that is reported, without
touching the response, which stays Zyte's:

| Where | What | For |
| --- | --- | --- |
| [`onRequest(report)`](#onrequest-one-report-per-request) | one `RequestReport` per `extract()`, success or failure | logs, analytics, dashboards |
| [`onAttempt(info)`](#onattempt-one-event-per-attempt) | one event per attempt, as it happens | live metrics, alerting |
| [`X-Xyte-*` headers](#server-headers) | a compact summary on every server response | callers of a deployed `xyte serve` |
| [`XYTE_LOG_REQUESTS=true`](#request-logs) | the report as one JSON line on stdout | Cloud Logging → BigQuery, Datadog, Loki… |
| [`scripts/bench.ts`](#benchmarks) | the same requests through each provider | choosing providers before going live |

## `onRequest`: one report per request

```ts
const xyte = new Xyte({
  proxy: route({ 'doordash.com': rotate([oxylabs(…), zyteApi(…)]) }, oxylabs(…)),
  onRequest: (report) => analytics.insert('scrapes', report),
});
// Or per call:
await xyte.extract(request, { onReport: (report) => console.log(report.attempts) });
```

A report for a DoorDash page the proxy got banned on, then Zyte served (illustrative values):

```json
{
  "requestId": "d4c980f5f5cf44d4b781e03964374ca8",
  "url": "https://www.doordash.com/store/123/",
  "host": "www.doordash.com",
  "outcome": "ok",
  "statusCode": 200,
  "provider": "zyte-api",
  "browser": false,
  "escalated": false,
  "queuedMs": 0,
  "ms": 6210,
  "attempts": [
    { "attempt": 0, "provider": "oxylabs-residential", "path": ["rotate(oxylabs-residential,zyte-api)", "oxylabs-residential"],
      "result": "ban", "statusCode": 403, "ms": 2140, "bytes": 5310, "transferBytes": 3120, "browser": false },
    { "attempt": 1, "provider": "zyte-api", "path": ["rotate(oxylabs-residential,zyte-api)", "zyte-api"],
      "result": "ok", "statusCode": 200, "ms": 3480, "bytes": 412044, "browser": false }
  ],
  "transferBytes": 3120,
  "byProvider": {
    "oxylabs-residential": { "attempts": 1, "ok": 0, "ban": 1, "error": 0, "aborted": 0, "transferBytes": 3120, "ms": 2140 },
    "zyte-api": { "attempts": 1, "ok": 1, "ban": 0, "error": 0, "aborted": 0, "transferBytes": 0, "ms": 3480 }
  },
  "warnings": []
}
```

| Field | |
| --- | --- |
| `outcome` | `ok` (a response came back, the target's own 4xx/5xx included), `error` (an `XyteError`: `error` has its status and type), `aborted` (cancelled) |
| `provider` | the provider that served the response: the leaf a combinator picked, not `rotate(…)` |
| `attempts[]` | every attempt in order: `provider`, `path` (each combinator's choice, outermost first), `result` (`ok`, `ban`, `error`, `aborted`: no verdict on the provider, e.g. a [pass-over](actions.md#pass-overs), whose `reason` says why), `reason`, `statusCode`, `ms`, `bytes` (the page), `transferBytes` (the wire), `browser` |
| `byProvider` | attempts, results, bytes and time summed per provider: what each one cost this request |
| `escalated` | `browserFallback` moved it from HTTP to a browser |
| `queuedMs` / `ms` | waiting for a `concurrency` slot, then working |
| `warnings` | e.g. a `geolocation` the exit couldn't apply |

`usageByProvider(attempts)` sums any list of attempts the same way, e.g. across a batch.

## `onAttempt`: one event per attempt

The same objects as `report.attempts`, delivered as each attempt ends: for counters and
histograms that should move while a slow request is still retrying.

```ts
onAttempt: ({ provider, result, ms, transferBytes, url }) => {
  metrics.increment('xyte.attempt', { provider, result, host: new URL(url).hostname });
  metrics.histogram('xyte.attempt.ms', ms, { provider });
  metrics.increment('xyte.attempt.bytes', transferBytes ?? 0, { provider });
},
```

## What the byte counts mean

`transferBytes` is what crossed the wire for an attempt, both ways: headers, bodies as
transferred (compressed), redirect hops and, in a browser, every sub-request (scripts, images,
XHR). It's what per-GB proxies bill, minus TLS and tunnel overhead.

| Case | Accuracy (checked against a byte-counting relay and real sites) |
| --- | --- |
| HTTP, body with `Content-Length` | within ~5% |
| HTTP, compressed body streamed without `Content-Length` (most dynamic pages) | estimated by compressing the body again the same way: within ~3% on Wikipedia and Yelp, ~15% low on a site that compresses lightly |
| Browser | within ~5% on a 200 KB page, plus ~1 KB per proxy connection for Chromium's auth handshake |
| `zyteApi()` and other API providers | not counted (they bill per request; see `attempts`) |

`bytes` is the size of the page that came back (decoded), for comparison.

## Server headers

Every `xyte serve` / `createHandler()` response, errors included, carries:

```
X-Xyte-Request-Id: d4c980f5f5cf44d4b781e03964374ca8
X-Xyte-Attempts: oxylabs-residential:ban,zyte-api:ok
X-Xyte-Transfer-Bytes: 3120
X-Xyte-Warning: geolocation "DE" not applied: …   (when there is one)
```

Zyte clients ignore them; the JSON body is unchanged.

## Request logs

`XYTE_LOG_REQUESTS=true xyte serve` prints each report as one JSON line, tagged
`"xyte": "request"`. On Cloud Run, Fly or Render that lands in the platform's logs; from there:

- **Google Cloud:** a Cloud Logging sink to BigQuery (filter `jsonPayload.xyte="request"`).
- **Datadog, Grafana Loki, Better Stack…:** their log agents parse JSON lines as is.

Then the questions that matter are queries. In BigQuery, for instance:

```sql
-- Which provider works on which site, and what it moves per page that came back.
SELECT
  host,
  attempt.provider,
  COUNT(*) AS attempts,
  COUNTIF(attempt.result = 'ok') / COUNT(*) AS success_rate,
  COUNTIF(attempt.result = 'ban') / COUNT(*) AS ban_rate,
  APPROX_QUANTILES(attempt.ms, 100)[OFFSET(50)] AS p50_ms,
  SUM(attempt.transferBytes) / NULLIF(COUNTIF(attempt.result = 'ok'), 0) / 1e6 AS mb_per_page
FROM xyte.requests, UNNEST(attempts) AS attempt
WHERE timestamp > TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL 7 DAY)
GROUP BY host, attempt.provider
ORDER BY host, success_rate DESC;
```

```sql
-- What it costs, with your own rates: per-GB for proxies, per request for APIs.
SELECT
  attempt.provider,
  SUM(attempt.transferBytes) / 1e9 * 6.0 AS proxy_usd,     -- your $/GB
  COUNTIF(attempt.provider = 'zyte-api') * 0.0013 AS api_usd -- your $/request
FROM xyte.requests, UNNEST(attempts) AS attempt
GROUP BY attempt.provider;
```

Prices differ by plan and volume, so xyte reports usage (attempts, bytes) and leaves the rates to
you.

## Benchmarks

Before production traffic exists, `scripts/bench.ts` runs a list of real requests through each
provider and reports, per site and provider: how often the real page came back (a regex per case,
so a captcha served with a 200 counts as a failure), the median latency, and the usage per 1,000
real pages, retries included:

```
(illustrative numbers)
| Case                | Provider            | Real page | Median ms | Attempts / 1k pages | MB / 1k pages |
| restaurantguru page | oxylabs-residential | 3/3       | 2777      | 1000                | 62            |
| doordash (browser)  | oxylabs-residential | 1/2       | 39654     | 2000                | 9800          |
```

```sh
bun scripts/bench.ts cases.json --providers zyte-api,direct,oxylabs --repeat 3 --out results.json
```

## Provider state ahead of requests

What `onRequest` reports after the fact, [`watch()`](routing.md#watch-check-providers-ahead-of-requests)
learns before: providers' usage APIs (credits left) and status pages, so an exhausted or down
provider is skipped before a request is spent on it. With a [shared store](routing.md#shared-state-across-instances-redis),
every instance sees the same budgets, circuits and checks.
