import { describe, expect, test } from 'bun:test';
import {
  budget,
  custom,
  healthy,
  memoryStore,
  oxylabsUsage,
  proxyFromEnv,
  redisStore,
  redisStoreFromUrl,
  resilient,
  rotate,
  scraperApiUsage,
  scrapingBeeUsage,
  statusPage,
  watch,
  zenrowsUsage,
  type ProxyContext,
  type StateStore,
} from '../src/index.ts';

const ctx = (overrides: Partial<ProxyContext> = {}): ProxyContext => ({
  url: new URL('https://example.com/'),
  sessionId: 's',
  attempt: 0,
  browser: false,
  requestId: `r-${Math.random()}`,
  ...overrides,
});
const tick = () => new Promise((r) => setTimeout(r, 20));
const proxyA = () => custom('a', () => 'http://a:p@a.example:1');
const proxyB = () => custom('b', () => 'http://b:p@b.example:1');
const hostOf = async (provider: ReturnType<typeof rotate>, context = ctx()) =>
  new URL(((await provider.resolve(context)) as { url: string }).url).hostname;

/** A fetch that answers by URL. */
const fakeFetch = (routes: Record<string, unknown>, calls: string[] = []) =>
  (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push(`${init?.method ?? 'GET'} ${url}`);
    const key = Object.keys(routes).find((k) => url.includes(k));
    return key ? Response.json(routes[key]) : new Response('not found', { status: 404 });
  }) as typeof fetch;

describe('stores', () => {
  test('memoryStore: counters with a time to live', async () => {
    const store = memoryStore();
    expect(await store.incr('k', 1, 0.05)).toBe(1);
    expect(await store.incr('k', 2, 0.05)).toBe(3);
    await store.set('s', 'v', 0.05);
    expect(await store.get('s')).toBe('v');
    await new Promise((r) => setTimeout(r, 70));
    expect(await store.get('s')).toBeNull();
    expect(await store.incr('k', 1, 1)).toBe(1);
  });

  test('redisStore: the commands it sends', async () => {
    const sent: string[][] = [];
    const values = new Map<string, number>();
    const store = redisStore(async (command) => {
      sent.push(command);
      if (command[0] === 'INCRBY') return values.set(command[1]!, (values.get(command[1]!) ?? 0) + Number(command[2])).get(command[1]!);
      return null;
    });
    await store.incr('k', 1, 60);
    await store.incr('k', 1, 60);
    await store.set('s', 'v', 30);
    expect(sent).toEqual([
      ['INCRBY', 'xyte:k', '1'],
      ['EXPIRE', 'xyte:k', '60'],
      ['INCRBY', 'xyte:k', '1'],
      ['SET', 'xyte:s', 'v', 'EX', '30'],
    ]);
  });

  test('resilient: a failing store falls back to memory, reported once', async () => {
    const errors: unknown[] = [];
    const broken: StateStore = {
      incr: () => Promise.reject(new Error('down')),
      get: () => Promise.reject(new Error('down')),
      set: () => Promise.reject(new Error('down')),
    };
    const store = resilient(broken, (e) => errors.push(e));
    expect(await store.incr('k', 1, 60)).toBe(1);
    expect(await store.incr('k', 1, 60)).toBe(2);
    expect(errors).toHaveLength(1);
  });

  const redisUrl = process.env.XYTE_TEST_REDIS_URL;
  test.skipIf(!redisUrl)('redisStoreFromUrl against a real Redis (XYTE_TEST_REDIS_URL)', async () => {
    const store = redisStoreFromUrl(redisUrl!, { prefix: `xyte-test:${Date.now()}:` });
    expect(await store.incr('k', 1, 60)).toBe(1);
    expect(await store.incr('k', 4, 60)).toBe(5);
    await store.set('s', 'hello', 60);
    expect(await store.get('s')).toBe('hello');
    expect(await store.get('missing')).toBeNull();
    // close() releases the connection; using the store again opens a new one.
    await store.close!();
    await store.close!();
    expect(await store.get('s')).toBe('hello');
    await store.close!();
  });

  // On Node, ioredis's open connection keeps the process alive until the store is closed.
  test.skipIf(!redisUrl)('on Node with ioredis, the process exits once the store is closed', async () => {
    const script = (close: boolean) => `
      import { redisStoreFromUrl } from ${JSON.stringify(new URL('../src/state.ts', import.meta.url).pathname)};
      const store = redisStoreFromUrl(${JSON.stringify(redisUrl)});
      await store.set('xyte-test:exit', '1', 10);
      ${close ? 'await store.close();' : ''}
    `;
    const run = async (close: boolean) => {
      const proc = Bun.spawn(['node', '--experimental-strip-types', '--no-warnings', '--input-type=module', '-e', script(close)], { stderr: 'pipe' });
      const exited = await Promise.race([proc.exited.then(() => true), Bun.sleep(4000).then(() => false)]);
      proc.kill();
      return exited;
    };
    expect(await run(true)).toBe(true);
    expect(await run(false)).toBe(false);
  }, 15_000);
});

describe('shared state across instances', () => {
  test('budget: two instances spend from one budget', async () => {
    const store = memoryStore(); // stands in for Redis: shared by both "instances"
    const one = budget(proxyA(), { max: 2, per: 'hour', store, key: 'zyte' });
    const two = budget(proxyA(), { max: 2, per: 'hour', store, key: 'zyte' });
    await one.resolve(ctx());
    await two.resolve(ctx());
    expect(two.resolve(ctx())).rejects.toMatchObject({ status: 429 });
    expect(one.resolve(ctx())).rejects.toMatchObject({ status: 429 });
  });

  test('healthy: a circuit one instance opens is open for the other', async () => {
    const store = memoryStore();
    const one = healthy(proxyA(), { failures: 1, cooldown: 60, store, key: 'oxy' });
    const two = healthy(proxyA(), { failures: 1, cooldown: 60, store, key: 'oxy' });
    const c = ctx();
    await one.resolve(c);
    one.report!(c, { result: 'error', ms: 1 });
    await tick();
    expect(two.available!(ctx())).toBe(true); // the first read happens in the background
    await tick();
    expect(two.available!(ctx())).toBe(false);
  });
});

describe('watch', () => {
  test('an exhausted provider is skipped before any attempt; it comes back when the check does', async () => {
    let left = 0;
    const changes: boolean[] = [];
    const watched = watch(proxyA(), {
      check: async () => ({ available: left > 0, remaining: left, detail: `${left} left` }),
      every: 0,
      onChange: (r) => changes.push(r.available),
    });
    const both = rotate([watched, proxyB()]);
    await watched.refresh();
    expect(watched.status()).toEqual({ available: false, remaining: 0, detail: '0 left' });
    expect(await hostOf(both)).toBe('b.example');
    left = 10;
    await watched.refresh();
    expect(await hostOf(both)).toBe('a.example');
    expect(changes).toEqual([false, true]);
  });

  test('checks run in the background, never on the request path; a failing check keeps the last result', async () => {
    let calls = 0;
    let fail = false;
    const watched = watch(proxyA(), {
      check: async () => {
        calls++;
        if (fail) throw new Error('usage API down');
        return { available: true };
      },
      every: 0,
    });
    expect(watched.available!(ctx())).toBe(true); // unknown yet: available; a check started
    await tick();
    expect(calls).toBe(1);
    fail = true;
    await watched.refresh();
    expect(watched.status()).toEqual({ available: true });
  });

  test('with a store, one instance checks and the others reuse its answer', async () => {
    const store = memoryStore();
    let calls = 0;
    const check = async () => (calls++, { available: false, detail: 'quota spent' });
    const one = watch(proxyA(), { check, store, key: 'bee', every: 60 });
    const two = watch(proxyA(), { check, store, key: 'bee', every: 60 });
    await one.refresh();
    await two.refresh();
    expect(calls).toBe(1);
    expect(two.status()).toEqual({ available: false, detail: 'quota spent' });
  });

  test('several checks: available only if all are', async () => {
    const watched = watch(proxyA(), {
      check: [async () => ({ available: true, remaining: 5 }), async () => ({ available: false, detail: 'major outage' })],
    });
    expect(await watched.refresh()).toEqual({ available: false, detail: 'major outage', remaining: 5 });
  });
});

describe('checks', () => {
  const signal = new AbortController().signal;

  test('scrapingBeeUsage', async () => {
    const calls: string[] = [];
    const check = scrapingBeeUsage({
      apiKey: 'k',
      minRemaining: 100,
      fetch: fakeFetch({ '/api/v1/usage': { max_api_credit: 1000, used_api_credit: 950 } }, calls),
    });
    expect(await check(signal)).toEqual({ available: false, remaining: 50, detail: 'scrapingbee 950/1000 credits used' });
    expect(calls).toEqual(['GET https://app.scrapingbee.com/api/v1/usage']);
  });

  test('zenrowsUsage', async () => {
    const check = zenrowsUsage({
      apiKey: 'k',
      fetch: fakeFetch({ '/subscriptions/self/details': { status: 'ACTIVE', usage_percent: 34, api_key: { caps: [{ remaining_credits: 0 }] } } }),
    });
    expect(await check(signal)).toMatchObject({ available: false, remaining: 0 });
  });

  test('scraperApiUsage', async () => {
    const check = scraperApiUsage({ apiKey: 'k', fetch: fakeFetch({ '/account': { requestCount: 10, requestLimit: 1000 } }) });
    expect(await check(signal)).toMatchObject({ available: true, remaining: 990 });
  });

  test('oxylabsUsage logs in once, then reads the month’s traffic', async () => {
    const calls: string[] = [];
    const check = oxylabsUsage({
      username: 'u',
      password: 'p',
      limitGB: 10,
      maxPercent: 90,
      fetch: fakeFetch({ '/v2/login': { token: 't', user_id: 'id' }, '/client-stats': { traffic: 9.5 } }, calls),
    });
    expect(await check(signal)).toMatchObject({ available: false, remaining: 0.5 });
    await check(signal);
    expect(calls.filter((c) => c.includes('/login'))).toHaveLength(1);
  });

  test('statusPage', async () => {
    const page = (indicator: string) => fakeFetch({ '/api/v2/status.json': { status: { indicator, description: indicator } } });
    expect((await statusPage('https://status.zyte.com', { fetch: page('minor') })(signal)).available).toBe(true);
    expect((await statusPage('https://status.zyte.com', { fetch: page('major') })(signal)).available).toBe(false);
  });
});

describe('from env', () => {
  test('XYTE_WATCH wraps providers that have a check; XYTE_BUDGET rejects once spent', async () => {
    const env = { SCRAPINGBEE_API_KEY: 'k', XYTE_PROVIDER: 'scrapingbee', XYTE_WATCH: 'true' };
    const provider = proxyFromEnv(env) as ReturnType<typeof watch>;
    expect(typeof provider.status).toBe('function');

    const capped = proxyFromEnv({ OXYLABS_USERNAME: 'u', OXYLABS_PASSWORD: 'p', XYTE_PROVIDER: 'oxylabs', XYTE_BUDGET: 'oxylabs=1/hour' });
    await capped.resolve(ctx());
    expect(capped.resolve(ctx())).rejects.toThrow(/budget/);
  });
});
