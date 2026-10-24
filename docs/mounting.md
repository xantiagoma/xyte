# Mounting xyte in your own server

`createHandler(xyte, options)` returns a Web-standard `(Request) => Promise<Response>` that
serves:

- `POST …/v1/extract`: the Zyte HTTP API
- `GET …/healthz`: `ok`

By default it matches **any path ending in** `/v1/extract`, so it works under a prefix whether or
not your framework strips it. Pass `basePath: '/zyte'` to match `/zyte/v1/extract` only.

```ts
import { createHandler, proxyFromEnv, toNodeHandler, Xyte } from 'xyte';

const xyte = new Xyte({ proxy: proxyFromEnv() });
const handler = createHandler(xyte, { apiKeys: ['secret'], basePath: '/zyte' });
```

When the caller hangs up, the scrape is cancelled: the `Request` signal is passed to
`extract()`, which aborts the fetch or closes the browser context.

## Web-standard frameworks

```ts
// Hono: app.mount strips the prefix; either way works.
app.mount('/zyte', createHandler(xyte));

// Bun.serve routes
Bun.serve({ idleTimeout: 255, routes: { '/v1/extract': { POST: createHandler(xyte) } } });

// Deno
Deno.serve(createHandler(xyte));

// Next.js App Router: app/api/zyte/v1/extract/route.ts (Node.js runtime)
export const runtime = 'nodejs';
export const POST = createHandler(xyte);

// Elysia
app.mount('/zyte', createHandler(xyte));
```

## Node-style frameworks

`toNodeHandler(handler)` adapts the handler to `(req, res)`. If middleware already parsed the
body (`express.json()`), it re-serializes it.

```ts
// Express
app.use('/zyte', toNodeHandler(createHandler(xyte)));

// Fastify
fastify.all('/zyte/*', (request, reply) => {
  reply.hijack();
  return toNodeHandler(createHandler(xyte))(request.raw, reply.raw);
});

// node:http
http.createServer(toNodeHandler(createHandler(xyte))).listen(8011);
```

Or skip the HTTP layer entirely: `await xyte.extract({ url, httpResponseBody: true })` from any
route of your own.

## Timeouts

A scrape with retries can take more than a minute. Raise the server and proxy timeouts:

- Bun: `idleTimeout: 255`
- Node: `server.requestTimeout = 0` (`serve()` sets it)
- Nginx/ALB: a read timeout of 300 s or more

Runnable versions are in [`examples/`](../examples); `bun run typecheck` checks them against the
current API. Tests: [`test/mount.test.ts`](../test/mount.test.ts) (Hono,
Express with and without `express.json()`, `basePath`, cancellation).
