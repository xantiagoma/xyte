# xyte docs

| Page | What's in it |
| --- | --- |
| [coverage.md](coverage.md) | How much of the Zyte API is implemented, field by field (generated from the spec) |
| [routing.md](routing.md) | Combining providers: `rotate` (fallback on retries), `route` (per site), `byIpType`; how attempts, sessions and costs work |
| [configuration.md](configuration.md) | Every `Xyte` option, environment variable, server option and CLI flag |
| [providers.md](providers.md) | Proxy networks, scraping APIs in proxy mode, remote browsers, and `template()` for anything else |
| [browser.md](browser.md) | Browser rendering: patchright and other forks, remote browsers, hooks, resource blocking |
| [extraction.md](extraction.md) | AI extraction (`product`, `article`, `customAttributes`…) through any LLM, with Zyte's schemas |
| [deploy.md](deploy.md) | Docker images; Cloud Run, Fly, Render, App Platform, Modal; sizing |
| [mounting.md](mounting.md) | Serving `/v1/extract` from Hono, Express, Fastify, Bun.serve, Next.js, node:http |
| [migrating-from-zyte.md](migrating-from-zyte.md) | Moving code that calls Zyte: change the base URL, or call the library; gotchas (`geolocation` with `direct()`…); live checks |

Runnable, typechecked examples are in [`../examples`](../examples).
