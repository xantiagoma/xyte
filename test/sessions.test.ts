import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { decodeBody, Xyte } from '../src/index.ts';
import { SessionPool } from '../src/sessions.ts';
import { startTarget } from './fixtures.ts';

setDefaultTimeout(30_000);
let target: ReturnType<typeof startTarget>;
const xyte = new Xyte({ retries: 0 });

beforeAll(() => {
  target = startTarget();
});
afterAll(async () => {
  await xyte.close();
  target.stop();
});

describe('sessionContext (server-managed sessions)', () => {
  const cookieOf = (res: { httpResponseBody?: string }) => JSON.parse(decodeBody(res.httpResponseBody!)).headers.cookie;

  test('init actions run once; later requests reuse the session and its cookies', async () => {
    const request = (n: number) => ({
      url: `${target.base}/echo`,
      httpResponseBody: true,
      sessionContext: [{ name: 'id', value: 'cookies' }],
      sessionContextParameters: { actions: [{ action: 'goto' as const, url: `${target.base}/set-cookie` }] },
      echoData: n,
    });
    const before = target.hits.get('/set-cookie') ?? 0;
    const first = await xyte.extract(request(1));
    const second = await xyte.extract(request(2));
    expect(cookieOf(first)).toMatch(/^visit=\d+$/);
    expect(cookieOf(second)).toBe(cookieOf(first));
    expect((target.hits.get('/set-cookie') ?? 0) - before).toBe(1);
  });

  test('another context gets its own session', async () => {
    const before = target.hits.get('/set-cookie') ?? 0;
    await xyte.extract({
      url: `${target.base}/echo`,
      httpResponseBody: true,
      sessionContext: [{ name: 'id', value: 'other' }],
      sessionContextParameters: { actions: [{ action: 'goto', url: `${target.base}/set-cookie` }] },
    });
    expect((target.hits.get('/set-cookie') ?? 0) - before).toBe(1);
  });

  test('a context without parameters is just a pooled sticky session', async () => {
    const res = await xyte.extract({ url: `${target.base}/html`, httpResponseBody: true, sessionContext: [{ name: 'a', value: 'b' }] });
    expect(res.statusCode).toBe(200);
  });

  test('validation', async () => {
    const both = await xyte
      .extract({ url: `${target.base}/html`, httpResponseBody: true, sessionContext: [{ name: 'a', value: 'b' }], session: { id: 'x' } })
      .catch((e) => e);
    expect(both.status).toBe(400);
    const orphan = await xyte
      .extract({ url: `${target.base}/html`, httpResponseBody: true, sessionContextParameters: { actions: [] } })
      .catch((e) => e);
    expect(orphan.status).toBe(400);
  });
});

describe('SessionPool', () => {
  test('reuses an idle session, grows when busy, retires after 3 bans', () => {
    const pool = new SessionPool({ size: 2 });
    const a = pool.acquire('k');
    const b = pool.acquire('k'); // a is busy → new
    expect(b.id).not.toBe(a.id);
    const c = pool.acquire('k'); // full → least busy
    expect([a.id, b.id]).toContain(c.id);
    for (const s of [a, b, c]) pool.release(s, 'ok');

  });

  test('a session is retired after 3 bans', () => {
    const pool = new SessionPool({ size: 1 });
    const first = pool.acquire('k');
    pool.release(first, 'ban');
    for (let i = 0; i < 2; i++) {
      const again = pool.acquire('k');
      expect(again.id).toBe(first.id);
      pool.release(again, 'ban');
    }
    expect(pool.acquire('k').id).not.toBe(first.id);
  });

  test('expired sessions are replaced', () => {
    const pool = new SessionPool({ maxAge: 0 });
    const a = pool.acquire('k');
    pool.release(a, 'ok');
    expect(pool.acquire('k').id).not.toBe(a.id);
  });
});

describe('includeIframes', () => {
  test('embeds iframe documents into browserHtml', async () => {
    const res = await xyte.extract({ url: `${target.base}/frames`, browserHtml: true, includeIframes: true });
    expect(res.browserHtml).toMatch(/<iframe src="\/html">[\s\S]*<h1>hello<\/h1>[\s\S]*<\/iframe>/);
  });

  test('iframes stay empty by default', async () => {
    const res = await xyte.extract({ url: `${target.base}/frames`, browserHtml: true });
    expect(res.browserHtml).toContain('<iframe src="/html"></iframe>');
  });
});
