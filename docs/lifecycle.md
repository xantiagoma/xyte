# The client's lifecycle

How long a `Xyte` client lives, what it holds open, and how to close it: `close()`, `try` /
`finally`, and `await using`. Everything here was checked on Node.js 22 and 24 and on Bun.

## What a client holds open

| Resource | Opened when | Keeps the process alive? | Closed by |
| --- | --- | --- | --- |
| A local browser (Chromium, or your `browser.launch`) | The first request that needs one: `browserHtml`, `screenshot`, `actions`, `networkCapture`… | **Yes**: a script that rendered a page and never closed the client doesn't exit | `xyte.close()` |
| HTTP connections to providers and sites | Each HTTP request | No | Nothing to do |
| A remote browser (`browser.connect`: Bright Data, Browserless…) | Each render, its own connection | No: each render disconnects when it's done | Nothing to do |
| A Redis connection (`redisStoreFromUrl`, `XYTE_REDIS_URL`) | The first operation on the store | **On Node with `ioredis` or `redis`, yes**. Bun's client doesn't | `store.close()` (it's yours, not the client's) |

So a client that only makes HTTP requests needs no closing. Once it renders a page, it does.

## `close()`

`await xyte.close()` cancels the requests still in flight, waits for them, then closes the browser,
if one was launched. Its behavior:

- **It can be called any number of times.** Calling it on a client that never launched a
  browser does nothing.
- **The client keeps working after it.** It isn't a destroyed state: the next render launches a
  new browser. It only stops what's open now.
- **Requests still running are cancelled.** Any `extract()` in progress when you close, HTTP or
  browser, rejects with a `XyteError` of type `/client/closed` (status 500, not retryable). So
  wait for your requests before closing. That's also what guarantees nothing opens a browser
  after `close()`: a request that hadn't reached its browser yet is cancelled too.
- **A browser that crashes or disconnects is relaunched** on the next render by itself: you
  don't need to close and recreate the client for that.

## Closing it, the usual way: `try` / `finally`

This works everywhere, including plain JavaScript on Node.js 22:

```ts
const xyte = new Xyte({ proxy: oxylabs({ username, password }) });
try {
  const page = await xyte.extract({ url, browserHtml: true });
  console.log(page.browserHtml);
} finally {
  await xyte.close(); // runs whether extract() succeeded or threw
}
```

Without the `finally`, an exception in `extract()` would skip `close()` and leave the script
hanging with the browser open.

## The same, shorter: `await using`

`await using` is JavaScript's [explicit resource
management](https://github.com/tc39/proposal-explicit-resource-management): it declares a
variable whose value is closed automatically when the block where it's declared ends. It's what
the `try` / `finally` above does, written by the language:

```ts
{
  await using xyte = new Xyte({ proxy: oxylabs({ username, password }) });
  const page = await xyte.extract({ url, browserHtml: true });
  console.log(page.browserHtml);
} // ← xyte.close() runs here
```

How it works:

- **When it closes:** when execution leaves the block, whichever way it leaves: the end of the
  block, a `return`, a `break`, or an exception. If `extract()` throws, the client is closed and
  then the exception continues as usual.
- **What it calls:** an object works with `await using` if it has a `[Symbol.asyncDispose]()`
  method. `Xyte` has one, and it calls `close()`. The `await` is because closing is asynchronous
  (closing a browser takes a moment), and the block waits for it before moving on.
- **The block is any block:** a function body, an `if`, a `for`, or a bare `{ }` like above. In a
  function, it closes when the function returns:

  ```ts
  async function scrape(url: string) {
    await using xyte = new Xyte({ proxy });
    return await xyte.extract({ url, browserHtml: true });
  } // closed after the return value is ready
  ```

  Use `return await` there, not just `return`. Without the `await`, the function returns the
  pending promise, the block ends, and the client closes while the request is still running: it
  rejects with `/client/closed`. (Before xyte checked for this, the render went on, opened a
  browser after the close, and the process never exited.)

- **Several resources:** each `await using` is closed in reverse order of declaration, the last
  one first. A Redis store and a client:

  ```ts
  {
    await using store = redisStoreFromUrl(process.env.REDIS_URL!);
    await using xyte = new Xyte({ proxy: budget(oxylabs(creds), { max: 1000, per: 'day', store }) });
    await xyte.extract({ url, browserHtml: true });
  } // xyte closes first, then the store: the client never finds its store closed
  ```

- **It's `const`:** you can't reassign the variable.

### Where `await using` works

It's new syntax, so it depends on what runs your code:

| Your code | `await using` |
| --- | --- |
| Bun | works |
| Node.js 24 or later | works |
| TypeScript (5.2 or later) compiled for Node.js 22 | works: the compiler turns it into a `try` / `finally`, and Node.js 22 already has `Symbol.asyncDispose` |
| Plain JavaScript (`.js`, `.mjs`) on Node.js 22 | a `SyntaxError`: use `try` / `finally` |

In TypeScript, that needs `"lib": ["esnext"]` (or `"esnext.disposable"`) in `tsconfig.json`, so
the compiler knows `Symbol.asyncDispose` and `AsyncDisposable`.

## In a service: one client, closed on shutdown

A server, a worker or a queue consumer should create **one client at startup**, share it across
all requests, and close it when the process is told to stop. One client per request would launch
a browser per request, and lose what the client keeps between requests (the cache, `adaptive`'s
scores, circuit breakers, sessions):

```ts
const store = redisStoreFromUrl(process.env.REDIS_URL!);
const xyte = new Xyte({ proxy: adaptive([direct(), oxylabs(creds)], { store }) });
const server = await serve(createHandler(xyte), { port: 8080 });

const shutdown = async () => {
  await server.stop();  // 1. stop taking requests (in-flight ones finish)
  await xyte.close();   // 2. close the browser
  await store.close();  // 3. close Redis, which the client no longer uses
  process.exit(0);
};
process.on('SIGTERM', shutdown); // what Cloud Run, Kubernetes, Docker send
process.on('SIGINT', shutdown);  // Ctrl+C
```

The order matters: each step closes something the earlier ones might still use. `xyte serve`
does exactly this, and also writes the last second of buffered [stats](observability.md#a-zyte-compatible-stats-api).

`await using` doesn't fit a service: the client must outlive the block that creates it.

If you build things from the environment (`proxyFromEnv()`, `cacheFromEnv()`… with
`XYTE_REDIS_URL`), they share one Redis connection per URL that you don't hold directly:
`await closeSharedStores()` closes them, after `xyte.close()`.

## In a script or a batch

```ts
await using xyte = new Xyte({ proxy });
for await (const result of xyte.extractMany(urls.map((url) => ({ url, browserHtml: true })))) {
  if ('error' in result) continue;
  save(result.response);
}
```

Leaving an `extractMany()` loop early (`break`, `return`, an exception) cancels the requests
still in flight and stops reading from the source: nothing keeps running unread in the
background, and the client can be closed right after.

## In tests

One client per test file, closed after all the tests:

```ts
import { afterAll, test } from 'bun:test'; // or node:test, vitest

const xyte = new Xyte({ proxy: direct() });
afterAll(() => xyte.close());
```

## If you forget to close

- **Only HTTP requests:** nothing happens, the process exits normally.
- **After a render:** the process doesn't exit. A script seems to hang at the end; a test runner
  waits until its timeout. Closing (or `process.exit()`) fixes it.
- **A Redis store on Node with `ioredis` / `redis`:** same, the process doesn't exit until the
  store is closed.

## Cancelling a request

Closing stops everything; to stop one request, pass an `AbortSignal`:

```ts
const page = await xyte.extract({ url, browserHtml: true }, { signal: AbortSignal.timeout(30_000) });
```

An aborted request stops its retries and closes its browser page. `extractMany()` takes a
`signal` too, for the whole batch.
