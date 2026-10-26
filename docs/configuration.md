# Configuration reference

Everything configurable, in one place: the `Xyte` options (library), the environment variables
(`xyte serve`, `xyte extract`, and `proxyFromEnv()` / `browserFromEnv()` / `extractorsFromEnv()` in
your own code), the server handler options, and the CLI.

## `new Xyte(options)`

| Option | Default | What it does |
| --- | --- | --- |
| `proxy` | `direct()` | Where requests exit: a preset, `template()`, or a combinator (`rotate`, `route`, `byIpType`). See [providers](providers.md) and [routing](routing.md). |
| `retries` | `3` | Retries after a ban, a proxy failure, a network error or an upstream 429/5xx, each through a fresh session. `0` disables. |
| `timeout` | `60` | Seconds per attempt (not per request). Raise it for `zyteApi()` on slow, hard sites. |
| `concurrency` | unlimited | Requests in flight; extra `extract()` calls queue. Match it to your provider's concurrency limit. |
| `isBan` | `isLikelyBan` | `(page: { url, statusCode, headers, html }) => boolean`: whether a page is a ban (retried, then a 520). `false` returns every page as is. |
| `browser` | Playwright Chromium | `browserType` (patchright…), `launchOptions`, `connect` (remote browser), `contextOptions`, `onPage`, `blockResources`, `timeLimit` (60 s), `settleTime` (3 s), `captcha` (a solver). See [browser](browser.md). |
| `extractors` | `markdown` only | Implementations of Zyte's extraction fields; `llmExtractors()` covers them all with any LLM. See [extraction](extraction.md). |
| `sessions` | `{ size: 8, maxAge: 14400, maxBans: 3 }` | The `sessionContext` pool: sessions per context, seconds before retiring one, bans before retiring one; `store` (Redis) shares it across instances ([shared state](routing.md#shared-state-across-instances-redis)). |
| `transport` | `fetch` (Bun) / undici (Node) | Low-level HTTP sender, for logging or tests. |
| `onRetry` | none | `({ attempt, url, reason }) => void`, called before each retry. |
| `onAttempt` | none | `({ provider, result, ms, statusCode, bytes, url, attempt, browser }) => void` after every attempt; `provider` is the one a combinator picked. See [routing](routing.md#watching-what-happens-onattempt). |
| `cache` | off | `{ ttl, store?, cacheable?, key? }`: answer repeats from a cache. `ttl` in seconds, or per site (`{ 'wolt.com': 600, '*': 3600 }`, 0 = don't cache). Identical requests in flight share one run. Keeps answers below 400 plus 404/410; never caches requests with a `session` / `sessionContext`. `store`: Redis to share it. Reports and `X-Xyte-Cache` say `hit` / `shared` / `miss`. |
| `rateLimits` | off | Per-site pacing: `{ 'yelp.co.uk': '2/s', 'doordash.com': { rate: 30, per: 60, concurrency: 2 }, '*': '10/s' }`. Under `'*'` each site has its own limit; a listed site shares one with its subdomains. Only real attempts wait (not cache hits or pass-overs). Per process. |
| `rates` | none | Your prices per provider (name or prefix): `{ oxylabs: { perGB: 6 }, 'zyte-api': { perRequest: 0.0013 }, scrapingbee: { perSuccess: 0.0005 } }`. Attempts and reports carry `costUsd`; errors and pass-overs cost 0, a ban costs `perRequest` but not `perSuccess`. |
| `onRequest` | none | `(report: RequestReport) => void` once per `extract()`, success or failure: every attempt, totals per provider, outcome. See [observability](observability.md). |
| `actions` | `searchKeyword`: built-in heuristic | Handlers for Zyte's own actions: `searchKeyword` and `setLocation` by host, `interaction` by script id, `'*'` for everything else, `null` for explicitly none. They always run locally. See [actions](actions.md#zytes-own-searchkeyword-setlocation-interaction). |
| `unsupportedActions` | `'warn'` | A Zyte-only action with no handler, on a local-browser provider (proxies, `direct()`, remote browsers): `warn` skips it (`notExecuted`) with a warning; `error` passes over to `zyteApi()` if a combinator has it, else a 400; `zyte` passes over to `zyteApi()` if a combinator has it (the built-in search too), else like `warn`. On an HTML-only API (Scrappey, ScrapingBot), which runs no actions at all: `error` is a 400, the others skip every action. See [actions](actions.md#where-they-run). |
| `browserFallback` | `false` | Retry a banned plain GET in a browser and return its raw response as `httpResponseBody`. See [routing](routing.md#browserfallback-retry-a-banned-page-in-a-browser). |
| `onWarning` | `console.warn`, once per message | `(message, { url }) => void`: requests that run, but not as asked (a `geolocation` the exit can't apply). |

`extract(request, { signal, onWarning, onReport })` takes an `AbortSignal` that cancels every
attempt, and per-call warning and report callbacks. `close()` closes the shared browser the first render launched; `await using xyte = new Xyte(…)`
does it when the block ends ([the client's lifecycle](lifecycle.md), including
where that syntax works).

## Environment variables

Read by the CLI, and by `proxyFromEnv()`, `browserFromEnv()` and `extractorsFromEnv()` (all
default to `process.env`).

### Server

| Variable | Default | |
| --- | --- | --- |
| `PORT` | `8011` (`8080` in the Docker images) | Listening port. |
| `HOST` | `127.0.0.1` (`0.0.0.0` in the images) | Listening interface. |
| `XYTE_WEBHOOK_SECRET`, `XYTE_JOBS_TTL` | none, `86400` | Job webhook signing secret, and how long jobs are kept. |
| `XYTE_PROXY_MODE_PORT` | off | Also serve [proxy mode](proxy-mode.md) on this port (or `--proxy-port`). |
| `XYTE_CA_CERT`, `XYTE_CA_KEY`, `XYTE_CA_DIR` | `~/.xyte` | Proxy mode's CA: PEM or paths; else the one in `XYTE_CA_DIR`, created on first use. |
| `XYTE_API_KEYS` | none | Comma-separated keys clients must send (Basic auth username, as on Zyte). Required off-loopback. |
| `XYTE_ALLOW_ANONYMOUS` | `false` | `true` to listen off-loopback without keys. |
| `XYTE_ALLOW_PRIVATE_TARGETS` | `false` | `true` to let requests target localhost, private IPs, `*.internal`… |
| `XYTE_RETRIES`, `XYTE_TIMEOUT`, `XYTE_CONCURRENCY` | `3`, `60`, unlimited | The `Xyte` options of the same name. |
| `XYTE_CACHE_TTL` | off | `3600`, or `wolt.com=600,*=3600`: the `cache` option (in Redis with `XYTE_REDIS_URL`). |
| `XYTE_RATE_LIMITS` | off | `yelp.co.uk=2/s,doordash.com=30/m,*=10/s`: the `rateLimits` option. |
| `XYTE_RATES` | none | `oxylabs=6/GB,zyte-api=0.0013/request,scrapingbee=0.0005/success` (`+` combines units): the `rates` option. |
| `XYTE_LOG_REQUESTS` | `false` | `true`: each request's report as one JSON line on stdout ([observability](observability.md#request-logs)). |

### Where requests exit

Checked in this order; the first one set wins.

| Variable | Example | |
| --- | --- | --- |
| `XYTE_PROXY_TEMPLATE` | `http://u[-country-{country:lower}]-session-{session}:p@host:port` | Any provider, from its URL format ([template](providers.md#any-other-provider-template)). |
| `XYTE_PROXY_URL` | `http://u:p@host:port,http://u:p@host2:port` | Plain proxies, rotated across attempts. Can't apply `geolocation`. |
| `XYTE_PROVIDER` | `oxylabs` or `oxylabs,zyte-api` | Presets by name, rotated across attempts. Each reads its credentials (`OXYLABS_USERNAME`, `ZYTE_API_KEY`…; the full list is in [providers](providers.md)). |
| `XYTE_PROXY_INSECURE` | `true` | Skip TLS verification for `XYTE_PROXY_URL` / `XYTE_PROXY_TEMPLATE` (proxies that re-sign TLS). |
| `XYTE_ADAPTIVE` | `direct,oxylabs,zyte-api` | Instead of `XYTE_PROVIDER`: [`adaptive()`](routing.md#adaptive-learn-the-cheapest-provider-per-site) over these, cheapest first. |
| `XYTE_ROUTES` | `wolt.com=direct,doordash.com=zyte-api,restaurantguru.com=oxylabs+zyte-api` | A provider per site; everything else uses the above. `+` rotates. See [routing](routing.md#route-a-provider-per-site). |
| `XYTE_BROWSER_PROVIDER` | `oxylabs` | Browser renders go here, HTTP requests to the above ([`byKind()`](routing.md#bykind-http-or-browser)). |
| `XYTE_CIRCUIT_BREAKER` | `5,60` | Every named provider gets a [circuit breaker](routing.md#healthy-a-circuit-breaker): failures, cooldown seconds. |
| `XYTE_BUDGET` | `zyte-api=500/hour,scrapingbee=1000/day` | [Attempt caps](routing.md#budget-cap-what-a-provider-can-spend) per provider (`minute`, `hour`, `day` or seconds). |
| `XYTE_WATCH` | `true` | [Check](routing.md#watch-check-providers-ahead-of-requests) every named provider that has a usage API or status page; `XYTE_WATCH_EVERY` seconds (60). Oxylabs needs `OXYLABS_LIMIT_GB` (and `OXYLABS_API_USERNAME` / `OXYLABS_API_PASSWORD` if the proxy user isn't the account's main one). |
| `XYTE_REDIS_URL` | `redis://…` | [Share](routing.md#shared-state-across-instances-redis) budgets, circuits, checks, `adaptive` scores, the `sessionContext` pool and the cache across instances. |

None set: `direct()`. A provider named in several of these is one instance: its budget and circuit
are shared.

### Browser

| Variable | Default | |
| --- | --- | --- |
| `XYTE_BROWSER` | `playwright` | `patchright`, or any installed Playwright-compatible package exporting `chromium`. |
| `XYTE_BROWSER_CHANNEL` | bundled Chromium | `chrome` for an installed Google Chrome. |
| `XYTE_BROWSER_HEADLESS` | `true` | `false` for headed (needs a display, e.g. xvfb). |
| `XYTE_BROWSER_ARGS` | none | Extra Chromium flags, comma-separated. |
| `XYTE_REMOTE_BROWSER` | none | Hosted browser preset: `brightdata`, `browserless`, `zenrows`, `oxylabs`, `nodemaven` (with its credentials). |
| `XYTE_BROWSER_WS` | none | Any remote browser's CDP endpoint; takes `template()` placeholders. `XYTE_BROWSER_WS_PROTOCOL=playwright` for a Playwright server. |
| `XYTE_BLOCK_RESOURCES` | none | Resource types to abort, e.g. `image,media,font` (saves per-GB proxy traffic). |
| `XYTE_BROWSER_TIME_LIMIT` | `60` | Browser seconds per request. |
| `XYTE_BROWSER_SETTLE` | `3` | Seconds to wait for the network to go quiet after load and actions; `0` to skip. |
| `XYTE_CAPTCHA` | none | `capsolver` (with `CAPSOLVER_API_KEY`) or `2captcha` (`TWOCAPTCHA_API_KEY`): solve captcha widgets in renders ([browser](browser.md#captchas)). |
| `XYTE_BROWSER_FALLBACK` | `false` | `true`: retry a banned plain GET in the browser (`browserFallback`). |

### AI extraction

| Variable | |
| --- | --- |
| `XYTE_LLM_MODEL` | Enables AI extraction (`product`, `article`…) with this model. |
| `XYTE_LLM_BASE_URL` | Any OpenAI-compatible API (default OpenAI): OpenRouter, Groq, Ollama, vLLM… |
| `XYTE_LLM_API_KEY` | Its key. |
| `XYTE_LLM_RESPONSE_FORMAT` | `json_object` for servers without JSON-schema output. |
| `XYTE_LLM_MAX_INPUT_CHARS` | Page text sent to the model, in characters. |

## `createHandler(xyte, options)`

The `/v1/extract` handler behind `xyte serve`, for mounting in your own app ([mounting](mounting.md)).

| Option | Default | |
| --- | --- | --- |
| `apiKeys` | any key accepted | Accepted keys (Basic auth username). |
| `basePath` | any path ending in `/v1/extract` | Where the routes live, e.g. `/zyte`. `GET …/healthz` answers `ok`. |
| `maxBodyBytes` | 10 MB | Largest accepted request body (413 above). |
| `blockPrivateTargets` | `false` (`xyte serve`: `true`) | Reject targets (and job `callbackUrl`s) on loopback, private, link-local and metadata addresses. |
| `stats` | on, in memory | `GET /api/stats` and `/api/v1/stats` ([Stats API](observability.md#a-zyte-compatible-stats-api)); a `StatsRecorder` to share or feed it, `false` to turn it off. |
| `jobs` | on, in memory | Asynchronous jobs ([below](#asynchronous-jobs)): `{ store?, ttl?, webhookSecret?, webhookAttempts? }`, or `false` to turn the routes off. |

### Asynchronous jobs

For renders that outlast an HTTP timeout, or work fed from a queue:

```sh
curl -u key: localhost:8011/v1/jobs -d '{"url":"https://example.com","browserHtml":true,"callbackUrl":"https://you.example/hook"}'
# 202 {"id":"…","status":"queued", …}   Location: /v1/jobs/…
curl -u key: localhost:8011/v1/jobs/…
# {"id":"…","status":"done","response":{…the Zyte response…}, "callback":{"status":"delivered","attempts":1}}
```

- The body is a Zyte request plus an optional `callbackUrl`. `status` goes `queued`, `running`,
  then `done` (with `response`) or `failed` (with the Zyte problem in `error`).
- With `callbackUrl`, the finished job is POSTed there (header `X-Xyte-Job-Id`), retried with
  backoff (`webhookAttempts`, default 3); `callback` on the job says how it went. With
  `webhookSecret` (`XYTE_WEBHOOK_SECRET`), deliveries carry `X-Xyte-Signature: sha256=<hex
  HMAC-SHA256 of the body>`; `verifyWebhook(body, signature, secret)` checks it.
- Jobs are kept `ttl` seconds (a day; `XYTE_JOBS_TTL`), in memory or in Redis with
  `XYTE_REDIS_URL` so any instance answers `GET /v1/jobs/{id}`. A job runs on the instance that
  received it: if that instance stops, the job stays `running`.

Responses are Zyte's. What a request took travels in headers so the body stays identical:
`X-Xyte-Request-Id`, `X-Xyte-Attempts` (`provider:result,…`), `X-Xyte-Transfer-Bytes`, and
`X-Xyte-Warning` when there is one.

## CLI

```sh
xyte serve [--port 8011] [--host 127.0.0.1] [--proxy-port 8012]
xyte ca
xyte extract <url> [--browser] [--country US] [--raw]
xyte extract --json '{"url": "…", "httpResponseBody": true}'
xyte batch <requests.jsonl | urls.txt | -> [--concurrency 16] [--browser] [--country US]
xyte doctor [--providers oxylabs,zyte-api] [--country US] [--url https://ipinfo.io/json]
```

`batch` reads one request per line (a Zyte request as JSON, or just a URL; `#` comments) and prints
one JSON line per result as they finish: `{ index, url, response }` or `{ index, url, error }`.
It exits with 1 if any failed.

`doctor` checks `direct` and every provider the environment configures (or `--providers`): that
its credentials are there, that a request through it works and where it exits (IP, country, ISP,
via ipinfo.io), whether `--country` is applied, and its quota or status where it has a usage API
or status page. It exits with 1 when anything fails, so it also works as a deploy check:

```
provider     status  exit / error                                         time     quota / notes
direct       ok      179.15.5.159 · CO · AS13489 UNE EPM TELECOMUNICACIONES  891 ms  exits from CO, not US: geolocation isn't applied
oxylabs      ok      47.146.129.143 · US · AS5650 Verizon Business          1743 ms
zyte-api     ok      174.140.236.200 · US · AS9009 M247 Europe SRL          1066 ms  status.zyte.com: All Systems Operational
scrapingbee  ok      139.55.174.21 · US · AS7029 Windstream                 3016 ms  scrapingbee 320/1000 credits used
zenrows      FAIL    ZENROWS_API_KEY is required
```

`extract` prints the Zyte response JSON, or with `--raw` just the page (decoded body or browser
HTML). Retries are logged to stderr. `serve` stops cleanly on SIGINT / SIGTERM, closing the
browser.
