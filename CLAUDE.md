# xyte

A Zyte API-compatible `POST /v1/extract` client/server that runs on any proxy provider.

## Runtime rule: library code must run on Node.js too

- `src/` is published to npm and must work on Node >= 22 **and** Bun. No Bun-only APIs in `src/`
  unless behind a runtime check with a Node fallback (see `src/transport.ts`, `serve()` in `src/server.ts`).
- Bun is the dev toolchain only: `bun install`, `bun test`, `bun run build` (tsdown on Bun).
- `bun run test:node` builds and runs `test/node/smoke.mjs` under real Node against `dist/`. Run it
  after touching the transport, server, CLI or browser engine.
- `playwright` and `undici` are optional peers, loaded with dynamic `import()` only when needed.
- `docs/api.md` is generated from the doc comments (`bun run build && bun run docs:api`); every export
  and public class member needs one, and CI fails when the file is stale.
- Types in `src/zyte.gen.ts` are generated from `spec/zyte-openapi.json` (`bun run gen:types`); don't edit by hand.
- Commits are conventional commits (`feat(scope): …`, `fix: …`, `feat!:` for breaking): `bun run release`
  (changelogen) builds the version and CHANGELOG.md from them. See `docs/releases.md`.
- `isolatedDeclarations` is on (TS 7 has no API for tsdown's dts): exported functions/consts need explicit types.

The Bun guidance below applies to tests and scripts, not to `src/`.

---


Default to using Bun instead of Node.js.

- Use `bun <file>` instead of `node <file>` or `ts-node <file>`
- Use `bun test` instead of `jest` or `vitest`
- Use `bun build <file.html|file.ts|file.css>` instead of `webpack` or `esbuild`
- Use `bun install` instead of `npm install` or `yarn install` or `pnpm install`
- Use `bun run <script>` instead of `npm run <script>` or `yarn run <script>` or `pnpm run <script>`
- Use `bunx <package> <command>` instead of `npx <package> <command>`
- Bun automatically loads .env, so don't use dotenv.

## APIs

- `Bun.serve()` supports WebSockets, HTTPS, and routes. Don't use `express`.
- `bun:sqlite` for SQLite. Don't use `better-sqlite3`.
- `Bun.redis` for Redis. Don't use `ioredis`.
- `Bun.sql` for Postgres. Don't use `pg` or `postgres.js`.
- `WebSocket` is built-in. Don't use `ws`.
- Prefer `Bun.file` over `node:fs`'s readFile/writeFile
- Bun.$`ls` instead of execa.

## Testing

Use `bun test` to run tests.

```ts#index.test.ts
import { test, expect } from "bun:test";

test("hello world", () => {
  expect(1).toBe(1);
});
```

## Frontend

Use HTML imports with `Bun.serve()`. Don't use `vite`. HTML imports fully support React, CSS, Tailwind.

Server:

```ts#index.ts
import index from "./index.html"

Bun.serve({
  routes: {
    "/": index,
    "/api/users/:id": {
      GET: (req) => {
        return new Response(JSON.stringify({ id: req.params.id }));
      },
    },
  },
  // optional websocket support
  websocket: {
    open: (ws) => {
      ws.send("Hello, world!");
    },
    message: (ws, message) => {
      ws.send(message);
    },
    close: (ws) => {
      // handle close
    }
  },
  development: {
    hmr: true,
    console: true,
  }
})
```

HTML files can import .tsx, .jsx or .js files directly and Bun's bundler will transpile & bundle automatically. `<link>` tags can point to stylesheets and Bun's CSS bundler will bundle.

```html#index.html
<html>
  <body>
    <h1>Hello, world!</h1>
    <script type="module" src="./frontend.tsx"></script>
  </body>
</html>
```

With the following `frontend.tsx`:

```tsx#frontend.tsx
import React from "react";
import { createRoot } from "react-dom/client";

// import .css files directly and it works
import './index.css';

const root = createRoot(document.body);

export default function Frontend() {
  return <h1>Hello, world!</h1>;
}

root.render(<Frontend />);
```

Then, run index.ts

```sh
bun --hot ./index.ts
```

For more information, read the Bun API docs in `node_modules/bun-types/docs/**.mdx`.
