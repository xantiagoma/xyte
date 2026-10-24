import { afterAll, beforeAll, expect, test } from 'bun:test';
import { createHandler, decodeBody, serve, Xyte } from '../src/index.ts';
import { startTarget } from './fixtures.ts';

let target: ReturnType<typeof startTarget>;
let server: Awaited<ReturnType<typeof serve>>;

beforeAll(async () => {
  target = startTarget();
  server = await serve(createHandler(new Xyte({ retries: 0 }), { apiKeys: ['KEY'] }), { port: 0 });
});
afterAll(async () => {
  target.stop();
  await server.stop();
});

/** Exactly how snappr's getHTMLFromZyte calls Zyte, with only the base URL changed. */
const zyteFetch = (body: unknown, key = 'KEY') =>
  fetch(`${server.url}v1/extract`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Basic ' + btoa(key + ':') },
    body: JSON.stringify(body),
  });

test('serves POST /v1/extract like api.zyte.com', async () => {
  const res = await zyteFetch({ url: `${target.base}/html`, httpResponseBody: true });
  expect(res.status).toBe(200);
  const body = (await res.json()) as { httpResponseBody: string; statusCode: number };
  expect(body.statusCode).toBe(200);
  expect(decodeBody(body.httpResponseBody)).toContain('hello');
});

test('errors are Zyte problem bodies with Zyte statuses', async () => {
  const banned = await zyteFetch({ url: `${target.base}/forbidden`, httpResponseBody: true });
  expect(banned.status).toBe(520);
  expect(await banned.json()).toMatchObject({ status: 520, type: '/download/temporary-error' });

  const invalid = await zyteFetch({ url: `${target.base}/html`, browserHtml: true, httpResponseBody: true });
  expect(invalid.status).toBe(400);
  expect(await invalid.json()).toMatchObject({ type: '/request/invalid' });
});

test('checks the API key when configured', async () => {
  const res = await zyteFetch({ url: `${target.base}/html`, httpResponseBody: true }, 'WRONG');
  expect(res.status).toBe(401);
});

test('rejects malformed JSON', async () => {
  const res = await fetch(`${server.url}v1/extract`, {
    method: 'POST',
    headers: { Authorization: 'Basic ' + btoa('KEY:') },
    body: '{nope',
  });
  expect(res.status).toBe(400);
  expect(await res.json()).toMatchObject({ type: '/request/invalid-json' });
});
