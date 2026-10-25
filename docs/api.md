# API reference

Everything `xyte` exports, grouped by what it's for. Each entry says what it is in a line; the
linked pages have the details and examples. Types are TypeScript-only (`import type`).

```ts
import { Xyte, oxylabs, decodeBody } from 'xyte';
```

A test (`test/api-docs.test.ts`) fails when something is exported but missing here.

## Client

| Export | |
| --- | --- |
| `Xyte` | The client. `new Xyte(options?)`; [options](configuration.md#new-xyteoptions). |
| `xyte.extract(request, options?)` | One Zyte request (`ExtractRequest`) → the Zyte 200 body (`ExtractResponse`), or rejects with an `XyteError`. `options`: `{ signal, onWarning, onReport }`. |
| `xyte.extractMany(requests, options?)` | Many requests from any iterable or async iterable; an async iterator of `BatchResult`s as they finish. `options`: `{ concurrency, signal }`. |
| `xyte.extractAll(requests, options?)` | `extractMany()` collected in input order. |
| `xyte.close()` | Closes the shared browser. Also `await using xyte = new Xyte(…)`. |
| `createXyte(options?)` | Shorthand for `new Xyte(options)`. |
| `XyteOptions` | The client's options. |
| `ExtractOptions` | Per-call options of `extract()`: `signal`, `onWarning`, `onReport`. |
| `BatchResult` | One `extractMany()` result: `{ index, request, response }` or `{ index, request, error }`. |
| `decodeBody(base64)` | An `httpResponseBody` (or a captured body) decoded as UTF-8 text. Bodies are base64, as on Zyte. |

## Requests, responses and errors

| Export | |
| --- | --- |
| `ExtractRequest` | Zyte's request body (generated from Zyte's OpenAPI spec), as xyte accepts it. |
| `ExtractResponse` | Zyte's 200 response body. |
| `ExtractionField` | `product`, `article`, … `markdown`, `serp`, `customAttributes`: the extraction outputs. |
| `EXTRACTION_FIELDS` | The same, as a list. |
| `Action`, `ActionName`, `ActionResult`, `ActionSelector` | Zyte's [actions](actions.md) and their results. |
| `Cookie`, `HttpHeader`, `CapturedResponse`, `NetworkCaptureFilter`, `CountryCode` | Zyte's request/response pieces. |
| `Problem` | Zyte's error body, as in the spec. |
| `ZyteSchemas` | Every schema of Zyte's spec, by name. |
| `XyteError` | What `extract()` rejects with: `status`, `type`, `title`, `detail`, `retryable`, `toJSON()` (the Zyte problem body). [Errors](../README.md#errors-and-retries). |
| `XyteProblem` | The problem body `XyteError.toJSON()` returns. |
| `UpstreamProblem` | Thrown by an `ApiEndpoint` for a retryable upstream answer (a Zyte 520): retried, and returned as is if it's the last. |
| `isLikelyBan(page)` | The default ban check (403/429/503 or a challenge page); replace with `isBan`. |
| `BanCheck` | What `isBan` receives: `{ url, statusCode, headers, html }`. |

## Providers

[Providers](providers.md) has every preset with its credentials format.

| Export | |
| --- | --- |
| `direct()` | No proxy. |
| `proxyUrl(url \| urls)` | Any proxy by URL; several rotate across attempts. |
| `template(format)` | Any provider from its URL format with placeholders (`{country}`, `{session}`…). |
| `custom(name, resolve)` | Your own: return a proxy URL, a `ProxyEndpoint`, or `null` for direct. |
| `proxyEndpointUrl({ host, port, username, password })` | Builds a proxy URL with encoded credentials. |
| `oxylabs`, `brightData`, `decodo` (`smartproxy`), `iproyal`, `nodeMaven`, `soax`, `netNut`, `webshare`, `rayobyte`, `packetStream`, `evomi`, `dataImpulse`, `massive`, `proxySeller`, `anyIp`, `thordata`, `abcProxy`, `proxy922`, `lunaProxy`, `proxyEmpire`, `rapidProxy`, `swiftProxy` | Residential and datacenter networks. |
| `zenrows`, `scrapingBee`, `scraperApi`, `crawlbase`, `scrapeDo`, `scrapingAnt`, `scrapeOps`, `scrapfly`, `oxylabsUnblocker`, `zyteProxy` | Scraping APIs in proxy mode. |
| `zyteApi`, `scrappey`, `scrapingBot` | API-only services (`ApiEndpoint`): Zyte API itself, and HTML-only APIs. |
| `brightDataBrowser`, `browserless`, `zenrowsBrowser`, `oxylabsBrowser`, `nodeMavenBrowser` | Hosted browsers, for `browser.connect`. |
| `PROVIDER_NAMES` | The names `XYTE_PROVIDER` accepts. |
| `ProxyProvider` | A provider: `name`, `resolve(context)`, and optionally `available`, `report`, `extracts`, `zyteActions`. [Writing a provider](providers.md#writing-a-provider). |
| `ProxyEndpoint` | What a proxy provider resolves to: `url`, `insecure`, `headers`, `inspect`, `hiddenHeaders`, `appliesCountry`. |
| `ApiEndpoint`, `ApiResult` | What an API provider resolves to: `api(request)` and, optionally, `unsupported(request)`. |
| `ProxyContext` | What `resolve()` gets: URL, country, ipType, session id, attempt, browser, requestId, path. |
| `EndpointOf<P>` | The endpoint type a provider resolves to. |
| `AttemptOutcome` | How an attempt went, as `report()` gets it. |

## Combining providers

[Routing](routing.md) explains each.

| Export | |
| --- | --- |
| `rotate(providers)` | By attempt: a fallback after a ban or an outage. |
| `route(byHost, fallback)` | By the target's host. |
| `adaptive(providers, options?)` | Learns per site the cheapest provider that works; `.scores()`. |
| `byKind({ http, browser })`, `byCountry(byCountry, fallback)`, `byIpType({ datacenter, residential })` | By request kind, `geolocation`, `ipType`. |
| `weighted([[provider, weight], …])` | Splits traffic. |
| `healthy(provider, options?)` | Circuit breaker. |
| `budget(provider, { max, per })` | Caps attempts per window. |
| `watch(provider, { check })` | Usage API / status page checks ahead of requests; `.status()`, `.refresh()`. |
| `AdaptiveOptions`, `AdaptiveProvider`, `HealthyOptions`, `BudgetOptions`, `WatchOptions`, `WatchedProvider` | Their options and returned types. |

## Provider checks

For `watch()` ([routing](routing.md#watch-check-providers-ahead-of-requests)).

| Export | |
| --- | --- |
| `scrapingBeeUsage`, `zenrowsUsage`, `scraperApiUsage`, `oxylabsUsage` | Quota left, from each provider's usage API. |
| `statusPage(url)` | Any Statuspage status page. |
| `STATUS_PAGES` | Status pages of the providers that have one. |
| `ProviderCheck`, `CheckResult` | A check and its answer: `{ available, detail?, remaining? }`. |

## Shared state

| Export | |
| --- | --- |
| `StateStore` | What budgets, circuits, checks, `adaptive`, sessions, the cache, jobs and stats keep state in. |
| `memoryStore(options?)` | In this process (`maxEntries` caps it). |
| `redisStore(send)` | In Redis, through any client's raw command function. |
| `redisStoreFromUrl(url)` | In Redis at a URL, with Bun's client, `ioredis` or `redis`. |
| `resilient(store)` | Falls back to memory when the store fails. |
| `RedisSend` | The raw command function `redisStore` takes. |

## Actions

[Actions](actions.md).

| Export | |
| --- | --- |
| `ActionHandlers` | The `actions` option: handlers for `searchKeyword`, `setLocation`, `interaction`. |
| `ActionHandler`, `ActionHandlerContext`, `ActionEntry`, `PerSite`, `ById` | A handler, what it gets (`url`, `timeout`, `log`), and the tables by site or id. |
| `SearchKeywordAction`, `SetLocationAction`, `InteractionAction`, `ZyteOnlyAction` | Zyte's own actions. |
| `searchBox` | The built-in `searchKeyword` heuristic. |
| `isZyteOnlyAction(action)` | Whether an action is one of Zyte's own three. |

## Browser

[Browser](browser.md).

| Export | |
| --- | --- |
| `patchright()`, `rebrowser()`, `camoufox(options?)`, `cloakBrowser(options?)` | Stealth browser presets for `browser`. |
| `STEALTH_BROWSERS` | The presets by `XYTE_BROWSER` name. |
| `capsolver({ apiKey })`, `twoCaptcha({ apiKey })` | Captcha solvers for `browser.captcha`. |
| `createTaskSolver(options)` | A solver for any service with the `createTask` / `getTaskResult` API. |
| `CaptchaSolver`, `CaptchaTask`, `CaptchaKind`, `CaptchaOutcome` | A solver, what it solves, and the outcome in attempt reports. |

## Extraction

[Extraction](extraction.md).

| Export | |
| --- | --- |
| `Extractor` | `({ url, html, request, options }) => value`: one extraction field's implementation. |
| `llmExtractors(options)` | Extractors for every AI field through an LLM, with Zyte's output schemas. |
| `openAICompatible(options)` | A `Complete` for any OpenAI-compatible API. |
| `Complete`, `CompletionRequest`, `Completion`, `LlmExtractorOptions` | The model call `llmExtractors` makes, and its options. |
| `parseJson(output)` | Parses a model's answer, tolerating code fences and text around the JSON. |
| `htmlToMarkdown(html, options?)` | The built-in `markdown` converter. |
| `MarkdownOptions` | Its options: `url`, `scope`. |
| `OUTPUT_SCHEMAS`, `OutputSchemaField` | Zyte's JSON Schemas for each AI field. |

## Reports, costs, cache and pacing

[Observability](observability.md), [configuration](configuration.md).

| Export | |
| --- | --- |
| `RequestReport` | What one `extract()` took (`onRequest`, `onReport`). |
| `AttemptInfo` | One attempt (`onAttempt`, `report.attempts`). |
| `ProviderUsage`, `usageByProvider(attempts)` | Attempts, bytes, time and cost per provider. |
| `Rate`, `Rates`, `rateFor(rates, provider)`, `attemptCost(rate, attempt)` | Your prices, and what an attempt cost at them. |
| `CacheOptions`, `requestKey(request)` | The `cache` option, and its default key. |
| `RateLimits`, `SiteLimit`, `parseLimit(value)` | The `rateLimits` option, and its `'2/s'` format. |

## Server

[Deploy](deploy.md), [mounting](mounting.md), [configuration](configuration.md#createhandlerxyte-options).

| Export | |
| --- | --- |
| `createHandler(xyte, options?)` | A Web-standard handler for `POST /v1/extract`, `/v1/jobs`, `/api/stats`, `/healthz`. |
| `HandlerOptions`, `FetchHandler` | Its options, and its type. |
| `toNodeHandler(handler, options?)` | The handler for `node:http`, Express, Fastify. |
| `serve(handler, options?)` | Listens with `Bun.serve` or `node:http`; `{ url, stop }`. |
| `isPrivateTarget(url)` | Whether a URL points at loopback, private or metadata addresses. |
| `Jobs`, `Job`, `JobsOptions`, `verifyWebhook(body, signature, secret)` | [Asynchronous jobs](configuration.md#asynchronous-jobs) and their webhook signature. |
| `StatsRecorder`, `StatsOptions`, `StatsQuery`, `StatsResponse`, `StatsQueryError` | [The Stats API](observability.md#a-zyte-compatible-stats-api). |
| `serveProxyMode(xyte, options?)`, `attachProxyMode(server, xyte, options?)`, `ProxyModeOptions` | [Proxy mode](proxy-mode.md). |
| `proxiedRequest(url, method, headers, body)` | The Zyte request a proxy-mode request stands for. |
| `createCertificateAuthority()`, `issueCertificate(ca, host)`, `CertificateAuthority` | Proxy mode's CA and per-site certificates. |

## Configuration from the environment

What the CLI uses; each reads `process.env` by default. [Configuration](configuration.md#environment-variables).

| Export | |
| --- | --- |
| `proxyFromEnv` | `XYTE_PROVIDER`, `XYTE_PROXY_URL`, `XYTE_ROUTES`, `XYTE_ADAPTIVE`… → a provider. |
| `browserFromEnv` | `XYTE_BROWSER*`, `XYTE_CAPTCHA`… → `browser` options. |
| `extractorsFromEnv` | `XYTE_LLM_*` → extractors. |
| `cacheFromEnv`, `rateLimitsFromEnv`, `ratesFromEnv`, `sessionsFromEnv` | `XYTE_CACHE_TTL`, `XYTE_RATE_LIMITS`, `XYTE_RATES`, the `sessionContext` pool. |
| `jobsFromEnv`, `statsFromEnv`, `caFromEnv` | Server jobs, stats, and proxy mode's CA. |

## Tools

| Export | |
| --- | --- |
| `doctor(options?)`, `formatDoctor(results)`, `DoctorOptions`, `DoctorResult` | `xyte doctor`: each provider's credentials, exit and quota. |
