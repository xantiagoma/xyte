import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { decodeBody, memoryStore, Xyte } from '../src/index.ts';
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

  test('accepted the way Zyte accepts them', async () => {
    // session wins over sessionContext; an orphan or empty context is ignored.
    const both = await xyte.extract({ url: `${target.base}/html`, httpResponseBody: true, sessionContext: [{ name: 'a', value: 'b' }], session: { id: 'x' } });
    expect(both.session).toEqual({ id: 'x' });
    const orphan = await xyte.extract({ url: `${target.base}/html`, httpResponseBody: true, sessionContextParameters: { actions: [] } });
    expect(orphan.statusCode).toBe(200);
    const empty = await xyte.extract({ url: `${target.base}/html`, httpResponseBody: true, sessionContext: [] });
    expect(empty.statusCode).toBe(200);
  });
});

describe('SessionPool with a shared store', () => {
  const tick = () => new Promise((r) => setTimeout(r, 20));

  test('a session one instance initialized reaches the other ready, with its cookies', async () => {
    const store = memoryStore(); // stands in for Redis
    const one = new SessionPool({ store, syncEvery: 0 });
    const two = new SessionPool({ store, syncEvery: 0 });
    const s = await one.acquire('ctx');
    s.ready = Promise.resolve();
    s.jar.set({ name: 'login', value: 'yes', domain: 'shop.example' }, true);
    one.save(s);
    one.release(s, 'ok');
    await tick();
    const t = await two.acquire('ctx');
    expect(t.id).toBe(s.id);
    expect(t.ready).toBeDefined(); // not initialized again
    expect(t.jar.all()).toEqual([expect.objectContaining({ name: 'login', value: 'yes' })]);
  });

  test('bans are shared: a session banned out on one instance is retired on the other', async () => {
    const store = memoryStore();
    const one = new SessionPool({ store, syncEvery: 0, size: 1 });
    const two = new SessionPool({ store, syncEvery: 0, size: 1 });
    const s = await one.acquire('ctx');
    await tick();
    for (let i = 0; i < 3; i++) {
      one.release(s, 'ban');
      await tick();
    }
    expect((await two.acquire('ctx')).id).not.toBe(s.id);
  });
});

describe('SessionPool', () => {
  test('reuses an idle session, grows when busy, retires after 3 bans', async () => {
    const pool = new SessionPool({ size: 2 });
    const a = await pool.acquire('k');
    const b = await pool.acquire('k'); // a is busy → new
    expect(b.id).not.toBe(a.id);
    const c = await pool.acquire('k'); // full → least busy
    expect([a.id, b.id]).toContain(c.id);
    for (const s of [a, b, c]) pool.release(s, 'ok');

  });

  test('a session is retired after 3 bans', async () => {
    const pool = new SessionPool({ size: 1 });
    const first = await pool.acquire('k');
    pool.release(first, 'ban');
    for (let i = 0; i < 2; i++) {
      const again = await pool.acquire('k');
      expect(again.id).toBe(first.id);
      pool.release(again, 'ban');
    }
    expect((await pool.acquire('k')).id).not.toBe(first.id);
  });

  test('expired sessions are replaced', async () => {
    const pool = new SessionPool({ maxAge: 0 });
    const a = await pool.acquire('k');
    pool.release(a, 'ok');
    expect((await pool.acquire('k')).id).not.toBe(a.id);
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
