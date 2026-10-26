## What and why

<!-- What this pull request changes, and the problem it solves. Link the issue: "Fixes #123". -->

## How it was verified

<!--
The checks you ran (CONTRIBUTING.md, "Checks a pull request must pass"): typecheck, bun test,
build, the api-docs check. Plus `bun run test:node` if you touched the transport, server, CLI or
browser engine. For a provider or Zyte-compatibility change, say whether you checked it live.
-->

## Checklist

- [ ] Commits follow Conventional Commits (`type(scope): subject`), and a breaking change is marked with `!`.
- [ ] A fix comes with a test that fails without it.
- [ ] The docs are updated for any change in behaviour, options or environment variables.
- [ ] Every new export or public member has a doc comment, and `docs/api.md` is regenerated (`bun run build && bun run docs:api`).
- [ ] `src/` still runs on Node.js ≥ 22 (no Bun-only APIs without a fallback) and adds no runtime dependency.
- [ ] No credentials, cookies or private URLs in the code, tests or this description.
