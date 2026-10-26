# Contributing to xyte

Thank you for helping. This file covers the setup, the checks a pull request must pass and what
it needs. Bug reports and feature requests go through the
[issue templates](https://github.com/xantiagoma/xyte/issues/new/choose). **Never report a security
problem in a public issue**: [SECURITY.md](SECURITY.md) explains how to report it privately.

By taking part you agree to the [Code of Conduct](CODE_OF_CONDUCT.md). Contributions are accepted
under the project's [MIT licence](LICENSE). There is no CLA, and no DCO sign-off is needed.

xyte is a personal project maintained on a best-effort basis ([disclaimer](README.md#disclaimer)).
For anything bigger than a fix, open an issue first, so we agree on the approach before you spend
time on it.

## What the project is

A TypeScript library, a CLI and a server that implement Zyte API's `POST /v1/extract` on any
proxy provider. The ground rules, also in [CLAUDE.md](CLAUDE.md):

- **`src/` runs on Node.js ≥ 22 and Bun.** No Bun-only APIs in `src/` unless behind a runtime
  check with a Node fallback (see `src/transport.ts`). Bun is only the dev toolchain.
- **No runtime dependencies.** `playwright` and `undici` are optional peers, loaded with dynamic
  `import()` only when a request needs them. A new runtime dependency needs a very good reason.
- **Zyte's behaviour is the spec.** Request and response fields, defaults and error types
  (`status`, `type`) follow [Zyte's docs](https://docs.zyte.com/zyte-api/usage/reference.html).
  When xyte differs on purpose, the docs say so.
- **Every export is documented.** `docs/api.md` is generated from the doc comments, and CI fails
  when an export or a public member has none, or when the file is stale.
- **Generated files are regenerated, never edited**: `src/zyte.gen.ts` and `src/schemas.gen.ts`
  (`bun run gen:types`), `docs/coverage.md` (`bun run docs:coverage`), `docs/api.md`
  (`bun run docs:api`).

## Setup

You need [Bun](https://bun.sh) 1.4 and Node.js 22 or later.

```sh
git clone https://github.com/xantiagoma/xyte.git
cd xyte
bun install
bunx playwright install chromium   # for the browser tests
bunx patchright install chromium
```

Provider credentials are only needed for live tests. Put them in `.env` (gitignored). Never
commit them, and never paste them in an issue or a pull request.

## Checks a pull request must pass

CI runs these on every pull request:

```sh
bun run typecheck
bun test                    # unit + integration (local target site, local proxy, real Chromium)
bun run build
bun scripts/api-docs.ts --check
bun scripts/coverage.ts && git diff --exit-code docs/coverage.md
bunx publint
bun run test:node           # the built package under real Node.js
```

`bun run site:build` also builds the [docs site](https://me.xantiagoma.com/xyte/) and fails on a
dead link; `bun run site:dev` serves it while you write.

Run `bun run test:node` whenever you touch the transport, the server, the CLI or the browser
engine. Tests that need Redis run when `XYTE_TEST_REDIS_URL` is set (for example
`redis://127.0.0.1:6379`). `bun run test:live` hits real sites and isn't part of CI.

A fix comes with a test that fails without it.

## Commits and pull requests

- Commits follow [Conventional Commits](https://www.conventionalcommits.org): `fix(browser): …`,
  `feat(providers): …`, `docs: …`. Mark a breaking change with `!` (`feat!: …`). The changelog
  and the version are generated from them ([docs/releases.md](docs/releases.md)).
- Update the docs for any change in behaviour, options or environment variables.
- Keep pull requests focused: one change, with the why in the description.

## Adding a provider

Proxy-network presets live in `src/proxy.ts`, scraping APIs used as proxies in
`src/providers.ts`, and remote browsers in `src/browsers.ts`. A new one needs the provider's
documented format (link it in the doc comment), its geolocation and session parameters, a test,
and a row in [docs/providers.md](docs/providers.md). Live-test it with your own account if you
can, and say in the pull request whether you did.
