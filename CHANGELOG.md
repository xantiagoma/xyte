# Changelog


## v0.1.4

[compare changes](https://github.com/xantiagoma/xyte/compare/v0.1.3...v0.1.4)

Docs and branding only: the README and the npm page show the new `@xtandard/xyte` lockups (SVG),
and the docs site uses the generated vector brand kit and lists the rest of the xtandard ecosystem.
No library, server, CLI or Docker image behavior changed.

### Migration

None: no code, config, storage or package-content change. The only removal is outside the
package: the docs site no longer serves the PNG logos (`logo.png`, `logo-128.png`, `logo-256.png`,
`symbol.png`, `favicon.png`). If you hot-linked one, use the SVGs next to them
(`lockup-horizontal-{light,dark}.svg`, `symbol-{light,dark}.svg`, `favicon.svg`); see
[docs/BRAND.md](https://github.com/xantiagoma/xyte/blob/main/docs/BRAND.md).

### 🩹 Fixes

- **brand:** Stacked lockups as the docs hero, no tile on any page; centre the horizontal lockups ([#6](https://github.com/xantiagoma/xyte/pull/6))

### 📖 Documentation

- The xtandard ecosystem ([#1](https://github.com/xantiagoma/xyte/pull/1))
- **ecosystem:** Link the flags and webhooks docs sites ([#2](https://github.com/xantiagoma/xyte/pull/2))
- **brand:** Generated vector brand kit in the xtandard family style ([#3](https://github.com/xantiagoma/xyte/pull/3))
- **brand:** SVG-only logos on every page; drop the PNG logo variants ([#4](https://github.com/xantiagoma/xyte/pull/4))
- **ecosystem:** Add @xtandard/audit, @xtandard/links and @xtandard/entitlements ([#5](https://github.com/xantiagoma/xyte/pull/5))
- **ecosystem:** Link @xtandard/entitlements on npm ([#7](https://github.com/xantiagoma/xyte/pull/7))

### ❤️ Contributors

- Santiago Montoya A. ([@xantiagoma](https://github.com/xantiagoma))

## v0.1.3

[compare changes](https://github.com/xantiagoma/xyte/compare/v0.1.2...v0.1.3)

### 🚀 Enhancements

- **combinators:** Fallback(primary, fallbacks, { primaryAttempts }) ([06eb505](https://github.com/xantiagoma/xyte/commit/06eb505))
- **docker:** Publish ghcr.io/xantiagoma/xyte images on release; Modal from the image ([c56f102](https://github.com/xantiagoma/xyte/commit/c56f102))

### 🩹 Fixes

- **client:** Fail with the last upstream answer (a ban, a problem), not a later network error ([e008238](https://github.com/xantiagoma/xyte/commit/e008238))

### ❤️ Contributors

- Santiago Montoya ([@xantiagoma](https://github.com/xantiagoma))

## v0.1.2

[compare changes](https://github.com/xantiagoma/xyte/compare/v0.1.1...v0.1.2)

### 🚀 Enhancements

- **providers:** Fall back on Zyte account errors; names, xyteApi(), zyteSpend() ([c218345](https://github.com/xantiagoma/xyte/commit/c218345))
- **deploy:** Modal autoscaling settings, per-endpoint API timeout, thin-client fleets ([c27c6af](https://github.com/xantiagoma/xyte/commit/c27c6af))

### 📖 Documentation

- Disclaimer, mission, and the open-source files ([94e971e](https://github.com/xantiagoma/xyte/commit/94e971e))
- A docs site at me.xantiagoma.com/xyte (VitePress over docs/) ([db85f72](https://github.com/xantiagoma/xyte/commit/db85f72))

### ❤️ Contributors

- Santiago Montoya ([@xantiagoma](https://github.com/xantiagoma))

## v0.1.1

[compare changes](https://github.com/xantiagoma/xyte/compare/v0.1.0...v0.1.1)

### 🩹 Fixes

- **browser:** Close() during a render's setup no longer hangs ([0441589](https://github.com/xantiagoma/xyte/commit/0441589))

### 📖 Documentation

- **readme:** Npm, CI and license badges; social preview image ([309863a](https://github.com/xantiagoma/xyte/commit/309863a))

### ❤️ Contributors

- Santiago Montoya ([@xantiagoma](https://github.com/xantiagoma))

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
