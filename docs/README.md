# xyte docs

| Page | What's in it |
| --- | --- |
| [api.md](api.md) | Every export of the package, grouped by purpose, with links to the pages above |
| [coverage.md](coverage.md) | How much of the Zyte API is implemented, field by field (generated from the spec) |
| [routing.md](routing.md) | Combining providers: `rotate`, `route`, `adaptive` (learns per site), `byKind`, `byCountry`, `weighted`; `healthy` (circuit breaker), `budget` and `watch` (usage APIs, status pages); shared state in Redis; `onAttempt`, `browserFallback`; how attempts, sessions and costs work |
| [actions.md](actions.md) | Which actions there are, which providers run them, Zyte's own three (`searchKeyword`, `setLocation`, `interaction`) through handlers, `unsupportedActions`, HTML-only APIs, pass-overs |
| [authentication.md](authentication.md) | Logged-in pages: cookies, header tokens, logging in first, and which providers can see your credentials |
| [observability.md](observability.md) | Per-request reports (`onRequest`), attempt events, `X-Xyte-*` headers, JSON request logs, byte accounting, analytics queries |
| [configuration.md](configuration.md) | Every `Xyte` option, environment variable, server option and CLI flag |
| [providers.md](providers.md) | Proxy networks, scraping APIs in proxy mode, remote browsers, and `template()` for anything else |
| [browser.md](browser.md) | Browser rendering: patchright and other forks, remote browsers, hooks, resource blocking |
| [extraction.md](extraction.md) | AI extraction (`product`, `article`, `customAttributes`…) through any LLM, with Zyte's schemas |
| [deploy.md](deploy.md) | Docker images; Cloud Run, Fly, Render, App Platform, Modal; sizing |
| [proxy-mode.md](proxy-mode.md) | Zyte's proxy mode: xyte as an HTTP proxy with `Zyte-*` headers, HTTPS through its own CA |
| [mounting.md](mounting.md) | Serving `/v1/extract` from Hono, Express, Fastify, Bun.serve, Next.js, node:http |
| [migrating-from-zyte.md](migrating-from-zyte.md) | Moving code that calls Zyte: change the base URL, or call the library; gotchas (`geolocation` with `direct()`…); live checks |

Runnable, typechecked examples are in [`../examples`](../examples).
