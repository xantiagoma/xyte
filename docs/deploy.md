# Deploying xyte

xyte deploys as a small web service that serves Zyte's HTTP API. Your scrapers call it the way
they call Zyte; only the base URL and the key change.

```
your scrapers ──POST /v1/extract──▶ xyte (Cloud Run, Fly, Render…) ──▶ proxy provider ──▶ site
                (Zyte JSON, Basic auth)   validate · retry · render
```

## The service contract

| | |
| --- | --- |
| Start command | `xyte serve` (the images run `node dist/cli.mjs serve`) |
| Port | `$PORT`, default 8080 in the images (8011 outside them). `HOST=0.0.0.0` is set in the images. |
| Health check | `GET /healthz` → `200 ok` |
| Auth | `XYTE_API_KEYS=key1,key2`; callers send `Authorization: Basic base64(key + ":")`, as with Zyte. **Required** when listening off-loopback (the images listen on `0.0.0.0`); `XYTE_ALLOW_ANONYMOUS=true` opts out. |
| Safety | Targets on localhost, private/link-local IPs (incl. `169.254.169.254`) and `*.internal` are rejected (`XYTE_ALLOW_PRIVATE_TARGETS=true` to allow). Request bodies are capped at 10 MB. |
| Proxy | `XYTE_PROVIDER` + credentials, `XYTE_PROXY_URL` or `XYTE_PROXY_TEMPLATE` ([providers](providers.md)); `XYTE_ROUTES` for a provider per site ([routing](routing.md)). All variables: [configuration](configuration.md) |
| Browser | `XYTE_BROWSER`, `XYTE_BROWSER_WS`, `XYTE_BLOCK_RESOURCES`… ([browser](browser.md)) |
| Tuning | `XYTE_CONCURRENCY`, `XYTE_RETRIES` (3), `XYTE_TIMEOUT` (60 s per attempt) |
| Shutdown | `SIGTERM` closes the server and the browser |
| Jobs | `POST /v1/jobs` runs in the background after answering 202: on Cloud Run, deploy with `--no-cpu-throttling` (CPU always allocated), or the job stalls until the next request. `XYTE_REDIS_URL` keeps jobs visible to every instance |
| Proxy mode | `--proxy-port` / `XYTE_PROXY_MODE_PORT` needs a raw TCP port (not Cloud Run / App Platform front ends); `XYTE_CA_CERT` / `XYTE_CA_KEY` as secrets so every instance presents the same CA ([proxy mode](proxy-mode.md)) |
| Pre-flight | `xyte doctor` (same image and env) checks every configured provider's credentials, exit and quota; exits 1 on a failure |

In your scraper code:

```diff
- fetch('https://api.zyte.com/v1/extract', { headers: { Authorization: 'Basic ' + btoa(ZYTE_API_KEY + ':') }, … })
+ fetch('https://xyte-abc123.a.run.app/v1/extract', { headers: { Authorization: 'Basic ' + btoa(XYTE_KEY + ':') }, … })
```

The host's IP mostly doesn't matter, because sites see the proxy's IP. The exception is
`direct()` (no proxy): sites then see your cloud's datacenter IP, which hard targets block.

## Images

Each release publishes both images to GitHub's registry, for `linux/amd64` and `linux/arm64`:

| Image | Tags | |
| --- | --- | --- |
| `ghcr.io/xantiagoma/xyte` | `0.1.3`, `0.1`, `latest` | full: HTTP + browser, ~2.5 GB |
| `ghcr.io/xantiagoma/xyte` | `0.1.3-slim`, `0.1-slim`, `slim` | HTTP only, ~250 MB |

```sh
docker run -p 8080:8080 -e XYTE_API_KEYS=dev \
  -e XYTE_PROVIDER=oxylabs -e OXYLABS_USERNAME=… -e OXYLABS_PASSWORD=… ghcr.io/xantiagoma/xyte:0.1.3

curl -u dev: localhost:8080/v1/extract -d '{"url":"https://example.com","httpResponseBody":true}'
```

Pin a version in production: `latest` moves with every release. To build them yourself:
`docker build -t xyte .` (full) and `docker build -t xyte:slim --target slim .`.

Every setting is an env var, so the images need no other config: the whole list is in
[configuration](configuration.md). The images carry the optional dependencies those settings need:
`undici` (proxies on Node) and `ioredis` (`XYTE_REDIS_URL`) in both; in the full image, Playwright
and Patchright on the same Chromium (`XYTE_BROWSER=patchright`). The other stealth browsers
(`rebrowser`, `camoufox`, `cloakbrowser`) have their own installs: extend the image for them, e.g.
`FROM ghcr.io/xantiagoma/xyte:0.1.3` then `RUN npm install rebrowser-playwright`.

- **full**: built on `mcr.microsoft.com/playwright`, so Chromium and its system libraries match
  the `playwright` version (`PLAYWRIGHT_VERSION` build arg). Runs as the non-root `pwuser`.
- **slim**: `node:22-slim`. `browserHtml`, `screenshot`, `actions` and `networkCapture` get an
  immediate 500 explaining that Playwright is missing; they are not retried.
- Both images run on Node. Bun is used only to build `dist/`.

### Sizing

| Workload | Memory | CPU | Concurrency per instance |
| --- | --- | --- | --- |
| HTTP only (slim) | 256–512 MB | 0.5–1 | 50+ |
| Browser (full) | 2 GB | 2 | ~8 (one context, ~150 MB, per request) |

Set the platform's per-instance concurrency to the same value as `XYTE_CONCURRENCY`. The platform
then scales out instead of queueing inside one instance. One Chromium is shared per instance, and
each request gets its own context (cookies, proxy, viewport).

Browser requests cost bandwidth. With residential proxies billed per GB, set
`XYTE_BLOCK_RESOURCES=image,media,font` unless you need them.

## Google Cloud Run

[`deploy/cloudrun.sh`](../deploy/cloudrun.sh) runs `gcloud run deploy --source .`, which builds
the Dockerfile with Cloud Build, and uses Secret Manager for credentials:

```sh
printf %s "$OXYLABS_PASSWORD" | gcloud secrets create oxylabs-password --data-file=-
printf %s "$(openssl rand -hex 24)" | gcloud secrets create xyte-api-keys --data-file=-
PROJECT=my-project OXYLABS_USERNAME=acme ./deploy/cloudrun.sh
```

Settings that matter for Chromium:

- `--execution-environment gen2`: a real `/dev/shm`, so Chromium doesn't crash on big pages.
- `--memory 2Gi --cpu 2 --concurrency 8`.
- `--timeout 300`: the request timeout (Cloud Run allows up to 3600). A scrape with retries can
  take more than a minute.
- Env values containing commas (`XYTE_PROVIDER=oxylabs,zenrows`) need gcloud's `^@^` delimiter
  syntax. The script uses it.
- Scale to zero is fine. A cold start launches Chromium on the first browser request (~1–2 s).

## Fly.io

[`deploy/fly.toml`](../deploy/fly.toml): `fly launch --copy-config --no-deploy`, then
`fly secrets set OXYLABS_USERNAME=… OXYLABS_PASSWORD=… XYTE_API_KEYS=…` and `fly deploy`. Machines
auto-stop when idle. The `concurrency` block uses the same per-instance limit as above.

## Render

[`deploy/render.yaml`](../deploy/render.yaml) is a Blueprint for a Docker web service with
`/healthz`. Secrets (`sync: false`) are entered in the dashboard.

## DigitalOcean App Platform

[`deploy/do-app.yaml`](../deploy/do-app.yaml): `doctl apps create --spec deploy/do-app.yaml`.
It builds from the GitHub repo, so the repo must be accessible to App Platform. Replace the
`change-me` secrets in the dashboard.

## Railway, Koyeb, Northflank, Coolify, Dokploy…

Anything that builds a Dockerfile and sets `$PORT` works with no extra config. Set the env vars
and point the health check at `/healthz`.

## Modal

[`deploy/modal_app.py`](../deploy/modal_app.py) runs the published image
(`ghcr.io/xantiagoma/xyte:<version>`, with the browser) behind `@modal.web_server`. Each container
takes up to `XYTE_MODAL_CONCURRENCY` requests, and the app scales with traffic. Each GitHub release
attaches a copy of the file pinned to that version's image, so a deployment from any repo needs
only that one file:

```sh
curl -LO https://github.com/xantiagoma/xyte/releases/download/v0.1.3/modal_app.py
modal secret create xyte OXYLABS_USERNAME=… OXYLABS_PASSWORD=… XYTE_API_KEYS=…
modal deploy modal_app.py
```

`XYTE_IMAGE` picks another image (`ghcr.io/xantiagoma/xyte:0.1.3-slim` for an HTTP-only fleet, or
your own built `FROM` it). `XYTE_MODAL_BUILD=1` builds the repo's Dockerfile instead (from the
repo root).

Several apps from the same file, each with its own provider and secret, are set by env at deploy
time:

```sh
modal secret create xyte-decodo DECODO_USERNAME=… DECODO_PASSWORD=… XYTE_API_KEYS=…
XYTE_MODAL_APP=xyte-decodo XYTE_PROVIDER=decodo modal deploy modal_app.py

modal secret create xyte-oxylabs OXYLABS_USERNAME=… OXYLABS_PASSWORD=… XYTE_API_KEYS=…
XYTE_MODAL_APP=xyte-oxylabs XYTE_PROVIDER=oxylabs XYTE_MODAL_MIN_CONTAINERS=1 modal deploy modal_app.py
```

| Variable | Default | Modal setting | |
| --- | --- | --- | --- |
| `XYTE_IMAGE` | `ghcr.io/xantiagoma/xyte:<the file's version>` | `Image.from_registry` | The image. In the repo's copy the version is `latest` |
| `XYTE_MODAL_APP` | `xyte` | `modal.App(name)` | The app's name, and so its URL: `https://<workspace>--<app>-serve.modal.run` |
| `XYTE_PROVIDER` | `oxylabs` | | What `xyte serve` uses ([configuration](configuration.md)). Anything else (`XYTE_ROUTES`, `XYTE_CIRCUIT_BREAKER`, `XYTE_REDIS_URL`…) goes in the secret |
| `XYTE_MODAL_SECRET` | the app's name | `secrets` | The provider's credentials and `XYTE_API_KEYS` |
| `XYTE_MODAL_MIN_CONTAINERS` | `0` | `min_containers` | Containers kept warm while idle. `1` removes the cold start, billed around the clock |
| `XYTE_MODAL_MAX_CONTAINERS` | `10` | `max_containers` | The cap on spend, and on concurrency at the provider |
| `XYTE_MODAL_BUFFER_CONTAINERS` | `0` | `buffer_containers` | Idle containers kept ready *while traffic flows*, so a burst doesn't wait for a cold start |
| `XYTE_MODAL_SCALEDOWN` | `300` | `scaledown_window` | Seconds an idle container lives (Modal allows 2–1200; its default is 60). Longer: fewer cold starts, more idle billing |
| `XYTE_MODAL_CONCURRENCY` | `8` | `@modal.concurrent(max_inputs)`, `XYTE_CONCURRENCY` | Requests one container takes at most |
| `XYTE_MODAL_TARGET_INPUTS` | ¾ of the above | `@modal.concurrent(target_inputs)` | What the autoscaler aims for: a new container starts at this load, and the gap to `max_inputs` is burst room while it boots |
| `XYTE_MODAL_MEMORY`, `XYTE_MODAL_CPU` | `2048`, `2` | `memory`, `cpu` | Per container |
| `XYTE_MODAL_REGION` | any | `region` | `us`, `eu`, `ap`… near the proxy's gateway or your callers. Modal bills 1.15× for a broad region, 1.75× for a narrow one |
| `XYTE_TIMEOUT`, `XYTE_RETRIES` | `30`, `3` | | Per attempt and retries. Set them here, at deploy time, not in the secret |

The values are baked into the image as well, because Modal imports the file again inside the
container.

**Sizing.**

- **Requests take long, not much CPU.** A scrape mostly waits on the network, so one container
  takes several at once. Chromium sets the limit: about 8 renders on 2 CPUs and 2 GiB. For
  HTTP-only traffic, `XYTE_MODAL_CONCURRENCY=32` (or more) is fine.
- **Max containers × concurrency is the fleet's peak.** Keep it within what the proxy plan allows
  in parallel, and what you're willing to pay for.
- **Cold starts** are tens of seconds: the browser image is large, and Chromium starts on the first
  render. Against them:
  - `XYTE_MODAL_MIN_CONTAINERS=1` while it matters (business hours, a crawl);
  - `XYTE_MODAL_BUFFER_CONTAINERS` for bursty traffic;
  - a long `XYTE_MODAL_SCALEDOWN` for traffic that is regular but sparse.

  `Function.autoscaler.update(min_containers=…)` changes them without a redeploy, from a scheduled
  job for instance. A redeploy puts the file's values back.
- **150 seconds per web request** is Modal's limit. Past it Modal answers 303, redirecting to a URL
  that waits for the result. Keep `XYTE_TIMEOUT` × (`XYTE_RETRIES` + 1) under it (30 × 4 = 120 by
  default; deploying warns otherwise). On the calling side, `xyteApi()` waits up to 150 s per
  attempt.
- **State across containers.** Each container has its own circuits, budgets, cache, sessions and
  async jobs. Set `XYTE_REDIS_URL` in the secret to share them
  ([routing](routing.md#shared-state-across-instances-redis)).
- **Auth** is xyte's own (`XYTE_API_KEYS`). Modal's `requires_proxy_auth` would add a second
  layer that Zyte clients can't send.
- **Memory snapshots** don't apply. The server runs as a subprocess, and Chromium starts per
  container.

From another service, each app is one provider: `xyteApi({ endpoint:
'https://<workspace>--xyte-decodo-serve.modal.run/v1/extract', apiKey, name: 'xyte-decodo' })`.
See below.

## A thin client and a remote fleet

The scraping service doesn't have to render anything itself. It installs `@xtandard/xyte` alone,
with no Playwright, no Chromium, and no proxy credentials, and sends every request to xyte servers
running elsewhere. Those servers do the heavy lifting: the browser, the proxy, the retries.

```
your service ── xyte (no browser) ──┬─ zyteApi ─▶ Zyte API                     ──▶ site
               fallback · healthy   ├─ xyteApi ─▶ xyte on Modal     ── oxylabs ──▶ site
               reports · costs      └─ xyteApi ─▶ xyte on Cloud Run ── decodo  ──▶ site
```

```ts
import { fallback, healthy, Xyte, xyteApi, zyteApi } from '@xtandard/xyte';

const key = process.env.XYTE_FLEET_KEY!;
const xyte = new Xyte({
  // Zyte gets the first 3 attempts while it works; the fleets the rest, or all of them while
  // Zyte's circuit is open (an outage, a suspended account).
  proxy: fallback(healthy(zyteApi({ apiKey: process.env.ZYTE_API_KEY! })), [
    healthy(xyteApi({ endpoint: 'https://you--xyte-oxylabs-serve.modal.run/v1/extract', apiKey: key, name: 'xyte-oxylabs' })),
    healthy(xyteApi({ endpoint: 'https://xyte-decodo-abc123.a.run.app/v1/extract', apiKey: key, name: 'xyte-decodo' })),
  ]),
  rates: { 'xyte-oxylabs': { perGB: 4 }, 'xyte-decodo': { perGB: 3.5 }, 'zyte-api': { perRequest: 0.0013 } },
});
const page = await xyte.extract({ url: 'https://example.com', browserHtml: true });
```

- **Any platform.** A fleet is anything that runs `xyte serve`: Modal, Cloud Run, Fly, a VM. The
  client only sees a URL and a key.
- **Nothing to render locally.** API providers take the whole request: `browserHtml`, `screenshot`,
  `actions` and `networkCapture` run on the remote, so the client's image stays small and
  Playwright isn't needed. What runs locally stays local: your [action handlers](actions.md),
  which pass over APIs, and the LLM [extractors](extraction.md), if you configure them here.
- **Failover.** An outage, a 5xx, or a 401/403 from a fleet or from Zyte (a bad key, a suspended
  account) moves the request on to the next provider. `healthy()` takes a failing one out for a
  while.
- **One report.** Each local attempt carries the remote's own attempts (`upstream`) and bytes. The
  caller sees `xyte-oxylabs → oxylabs-residential:ban, oxylabs-residential:ok`, and `rates` per
  fleet price it ([observability](observability.md)).
- **Timeouts.** A remote attempt waits up to 150 s (`xyteApi({ timeout })`), since the remote
  retries on its side. Keep the remote's `XYTE_TIMEOUT` × attempts under that, and the client's
  `retries` low: moving on to the next fleet beats asking the same one again.

## Serverless functions (Vercel, Netlify, Lambda, Cloudflare Workers)

These can only run HTTP requests: there's no Chromium, and Cloudflare Workers can't dial
arbitrary proxies. To render on them, use `browser.connect` with a hosted browser
([browser](browser.md#remote-browsers)). A Next.js route handler is in
[`examples/nextjs-route.ts`](../examples/nextjs-route.ts) and needs the Node.js runtime, not Edge.

## Mounting inside an existing service

See [mounting.md](mounting.md): Hono, Express, Fastify, Bun.serve, Next.js, plain `node:http`.

## Status

The two images were built and exercised locally: HTTP, browser, auth, health check, and the
slim image's browser error. The platform files follow each platform's documented format but have
not been deployed from this repo yet.
