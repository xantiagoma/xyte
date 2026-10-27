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

```sh
docker build -t xyte .                       # full: HTTP + browser (Playwright Chromium), ~2.5 GB
docker build -t xyte:slim --target slim .    # HTTP only, ~250 MB

docker run -p 8080:8080 -e XYTE_API_KEYS=dev \
  -e XYTE_PROVIDER=oxylabs -e OXYLABS_USERNAME=… -e OXYLABS_PASSWORD=… xyte

curl -u dev: localhost:8080/v1/extract -d '{"url":"https://example.com","httpResponseBody":true}'
```

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

[`deploy/modal_app.py`](../deploy/modal_app.py) builds the repo's Dockerfile and runs
`xyte serve` behind `@modal.web_server`. It works, but Modal is Python-first: you pay
image-build time on changes and per-container memory. Prefer Cloud Run unless you're already on
Modal.

```sh
modal secret create xyte OXYLABS_USERNAME=… OXYLABS_PASSWORD=… XYTE_API_KEYS=…
modal deploy deploy/modal_app.py
```

Several apps from the same file, each with its own provider and secret, are set by env at deploy
time:

```sh
modal secret create xyte-decodo DECODO_USERNAME=… DECODO_PASSWORD=… XYTE_API_KEYS=…
XYTE_MODAL_APP=xyte-decodo XYTE_PROVIDER=decodo modal deploy deploy/modal_app.py

modal secret create xyte-oxylabs OXYLABS_USERNAME=… OXYLABS_PASSWORD=… XYTE_API_KEYS=…
XYTE_MODAL_APP=xyte-oxylabs XYTE_PROVIDER=oxylabs XYTE_MODAL_MIN_CONTAINERS=1 modal deploy deploy/modal_app.py
```

| Variable | Default | |
| --- | --- | --- |
| `XYTE_MODAL_APP` | `xyte` | The app's name, and so its URL (`https://<workspace>--<app>-serve.modal.run`) |
| `XYTE_PROVIDER` | `oxylabs` | What `xyte serve` uses ([configuration](configuration.md)); anything else (`XYTE_ROUTES`, `XYTE_CIRCUIT_BREAKER`…) goes in the secret |
| `XYTE_MODAL_SECRET` | the app's name | The Modal secret with the provider's credentials and `XYTE_API_KEYS` |
| `XYTE_MODAL_MIN_CONTAINERS` | `0` | Containers kept warm: `1` avoids the cold start (tens of seconds for the browser image), billed while idle |
| `XYTE_MODAL_CONCURRENCY` | `8` | Requests per container (`@modal.concurrent` and `XYTE_CONCURRENCY`) |

The values are baked into the image as well, because Modal imports the file again inside the
container. From another service, each app is one provider:
`xyteApi({ endpoint: 'https://<workspace>--xyte-decodo-serve.modal.run/v1/extract', apiKey, name: 'xyte-decodo' })`
([providers](providers.md#another-xyte-server-as-a-provider)).

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
