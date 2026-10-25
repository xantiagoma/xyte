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
| `browser` | Playwright Chromium | `browserType` (patchright…), `launchOptions`, `connect` (remote browser), `contextOptions`, `onPage`, `blockResources`, `timeLimit` (60 s), `settleTime` (3 s). See [browser](browser.md). |
| `extractors` | `markdown` only | Implementations of Zyte's extraction fields; `llmExtractors()` covers them all with any LLM. See [extraction](extraction.md). |
| `sessions` | `{ size: 8, maxAge: 14400, maxBans: 3 }` | The `sessionContext` pool: sessions per context, seconds before retiring one, bans before retiring one. |
| `transport` | `fetch` (Bun) / undici (Node) | Low-level HTTP sender, for logging or tests. |
| `onRetry` | none | `({ attempt, url, reason }) => void`, called before each retry. |
| `onWarning` | `console.warn`, once per message | `(message, { url }) => void`: requests that run, but not as asked (a `geolocation` the exit can't apply). |

`extract(request, { signal, onWarning })` takes an `AbortSignal` that cancels every attempt, and a
per-call warning callback. `close()` (or `await using xyte = new Xyte(…)`) closes the shared browser.

## Environment variables

Read by the CLI, and by `proxyFromEnv()`, `browserFromEnv()` and `extractorsFromEnv()` (all
default to `process.env`).

### Server

| Variable | Default | |
| --- | --- | --- |
| `PORT` | `8011` (`8080` in the Docker images) | Listening port. |
| `HOST` | `127.0.0.1` (`0.0.0.0` in the images) | Listening interface. |
| `XYTE_API_KEYS` | none | Comma-separated keys clients must send (Basic auth username, as on Zyte). Required off-loopback. |
| `XYTE_ALLOW_ANONYMOUS` | `false` | `true` to listen off-loopback without keys. |
| `XYTE_ALLOW_PRIVATE_TARGETS` | `false` | `true` to let requests target localhost, private IPs, `*.internal`… |
| `XYTE_RETRIES`, `XYTE_TIMEOUT`, `XYTE_CONCURRENCY` | `3`, `60`, unlimited | The `Xyte` options of the same name. |

### Where requests exit

Checked in this order; the first one set wins.

| Variable | Example | |
| --- | --- | --- |
| `XYTE_PROXY_TEMPLATE` | `http://u[-country-{country:lower}]-session-{session}:p@host:port` | Any provider, from its URL format ([template](providers.md#any-other-provider-template)). |
| `XYTE_PROXY_URL` | `http://u:p@host:port,http://u:p@host2:port` | Plain proxies, rotated across attempts. Can't apply `geolocation`. |
| `XYTE_PROVIDER` | `oxylabs` or `oxylabs,zyte-api` | Presets by name, rotated across attempts. Each reads its credentials (`OXYLABS_USERNAME`, `ZYTE_API_KEY`…; the full list is in [providers](providers.md)). |
| `XYTE_PROXY_INSECURE` | `true` | Skip TLS verification for `XYTE_PROXY_URL` / `XYTE_PROXY_TEMPLATE` (proxies that re-sign TLS). |
| `XYTE_ROUTES` | `wolt.com=direct,doordash.com=zyte-api,restaurantguru.com=oxylabs+zyte-api` | A provider per site; everything else uses the above. `+` rotates. See [routing](routing.md#route-a-provider-per-site). |

None set: `direct()`.

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
| `blockPrivateTargets` | `false` (`xyte serve`: `true`) | Reject targets on loopback, private, link-local and metadata addresses. |

Responses are Zyte's. Warnings travel in an `X-Xyte-Warning` header so the body stays identical.

## CLI

```sh
xyte serve [--port 8011] [--host 127.0.0.1]
xyte extract <url> [--browser] [--country US] [--raw]
xyte extract --json '{"url": "…", "httpResponseBody": true}'
```

`extract` prints the Zyte response JSON, or with `--raw` just the page (decoded body or browser
HTML). Retries are logged to stderr. `serve` stops cleanly on SIGINT / SIGTERM, closing the
browser.
