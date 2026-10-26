# Changelog


## v0.1.0

The first release.

### 🚀 Enhancements

- **Zyte API compatible:** `POST /v1/extract` with Zyte's request and response JSON and its error types (`/download/website-ban`, `/request/unprocessable`…): `httpResponseBody`, `browserHtml`, `screenshot`, `actions`, `networkCapture`, `geolocation`, sessions, cookies, custom headers, markdown. See [docs/coverage.md](docs/coverage.md).
- **Any proxy:** presets for Oxylabs, Bright Data, Decodo, IPRoyal, ZenRows, ScrapingBee, ScraperAPI and 30+ more, any `http://user:pass@host:port`, `direct()`, or Zyte itself.
- **Combining providers:** `rotate`, `route`, `adaptive`, `byKind`, `byCountry`, `weighted`, `healthy`, `budget`, `watch`, with shared state in Redis.
- **Browser rendering:** Playwright, patchright and other forks, remote browsers (Browserless, Bright Data…), stealth presets, captcha solvers, Zyte-only actions through handlers.
- **AI extraction:** `product`, `article`, `customAttributes`… in Zyte's schemas, through any LLM.
- **Server:** `xyte serve`, mountable in Hono, Express, Fastify, Next.js, node:http; async jobs with webhooks, a Zyte-compatible Stats API, proxy mode; Docker images.
- **Operations:** cache, rate limits, costs, per-request reports, `extractMany`, `xyte doctor`.
- Runs on Node.js ≥ 22 and Bun.
