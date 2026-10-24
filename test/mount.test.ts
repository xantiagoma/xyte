import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import express from 'express';
import { Hono } from 'hono';
import http from 'node:http';
import { createHandler, decodeBody, toNodeHandler, Xyte } from '../src/index.ts';
import { startTarget } from './fixtures.ts';

let target: ReturnType<typeof startTarget>;
beforeAll(() => {
  target = startTarget();
});
afterAll(() => target.stop());

const xyte = new Xyte({ retries: 0 });
const extractBody = () => JSON.stringify({ url: `${target.base}/html`, httpResponseBody: true });
const post = (url: string, body = extractBody()) =>
  fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body });

async function listen(server: http.Server): Promise<{ base: string; close: () => Promise<void> }> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as { port: number };
  return { base: `http://127.0.0.1:${port}`, close: () => new Promise((resolve) => server.close(() => resolve())) };
}

describe('mounting', () => {
  test('Hono app.mount under a prefix', async () => {
    const app = new Hono();
    app.get('/', (c) => c.text('my app'));
    app.mount('/zyte', createHandler(xyte));
    const res = await app.request('/zyte/v1/extract', { method: 'POST', body: extractBody() });
    expect(res.status).toBe(200);
    expect(decodeBody(((await res.json()) as { httpResponseBody: string }).httpResponseBody)).toContain('hello');
  });

  test('Hono route without prefix stripping (suffix match)', async () => {
    const app = new Hono();
    const handler = createHandler(xyte);
    app.post('/scrape/v1/extract', (c) => handler(c.req.raw));
    const res = await app.request('/scrape/v1/extract', { method: 'POST', body: extractBody() });
    expect(res.status).toBe(200);
  });

  test('basePath makes routing strict', async () => {
    const handler = createHandler(xyte, { basePath: '/zyte/' });
    expect((await handler(new Request('http://x/zyte/v1/extract', { method: 'POST', body: extractBody() }))).status).toBe(200);
    expect((await handler(new Request('http://x/other/v1/extract', { method: 'POST', body: extractBody() }))).status).toBe(404);
    expect(await (await handler(new Request('http://x/zyte/healthz'))).text()).toBe('ok');
  });

  test('Express app.use with toNodeHandler', async () => {
    const app = express();
    app.get('/', (_req, res) => void res.send('my app'));
    app.use('/zyte', toNodeHandler(createHandler(xyte, { apiKeys: ['K'] })));
    const server = await listen(http.createServer(app));
    try {
      const unauthorized = await post(`${server.base}/zyte/v1/extract`);
      expect(unauthorized.status).toBe(401);

      const res = await fetch(`${server.base}/zyte/v1/extract`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Basic ${btoa('K:')}` },
        body: extractBody(),
      });
      expect(res.status).toBe(200);
      expect(((await res.json()) as { statusCode: number }).statusCode).toBe(200);
    } finally {
      await server.close();
    }
  });

  test('Express with express.json() already parsing the body', async () => {
    const app = express();
    app.use(express.json());
    app.use('/zyte', toNodeHandler(createHandler(xyte)));
    const server = await listen(http.createServer(app));
    try {
      const res = await post(`${server.base}/zyte/v1/extract`);
      expect(res.status).toBe(200);
    } finally {
      await server.close();
    }
  });

  test('a client hanging up cancels the scrape', async () => {
    let aborted = false;
    const slow = new Xyte({
      retries: 0,
      transport: ({ signal }) =>
        new Promise((_, reject) =>
          signal.addEventListener('abort', () => {
            aborted = true;
            reject(signal.reason);
          }),
        ),
    });
    const controller = new AbortController();
    const pending = createHandler(slow)(
      new Request('http://x/v1/extract', {
        method: 'POST',
        body: JSON.stringify({ url: 'https://example.com', httpResponseBody: true }),
        signal: controller.signal,
      }),
    );
    await Bun.sleep(20);
    controller.abort();
    await pending;
    expect(aborted).toBe(true);
  });
});

test('extract({ signal }) rejects when aborted', async () => {
  const controller = new AbortController();
  controller.abort(new Error('stop'));
  await expect(xyte.extract({ url: `${target.base}/html`, httpResponseBody: true }, { signal: controller.signal })).rejects.toThrow('stop');
});
