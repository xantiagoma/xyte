import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test';
import {
  adaptive,
  budget,
  byCountry,
  byKind,
  custom,
  decodeBody,
  healthy,
  proxyFromEnv,
  rotate,
  route,
  weighted,
  Xyte,
  type AttemptInfo,
  type ProxyContext,
  type ProxyProvider,
} from '../src/index.ts';
import { startByteCounter, startProxy, startTarget } from './fixtures.ts';

setDefaultTimeout(30_000);
let target: ReturnType<typeof startTarget>;
let proxy: Awaited<ReturnType<typeof startProxy>>;
beforeAll(async () => {
  target = startTarget();
  proxy = await startProxy({ password: 'secret' });
});
afterAll(async () => {
  target.stop();
  await proxy.stop();
});

const ctx = (overrides: Partial<ProxyContext> = {}): ProxyContext => ({
  url: new URL('https://example.com/'),
  sessionId: 's',
  attempt: 0,
  browser: false,
  requestId: 'r',
  ...overrides,
});

/** A provider that answers without network: `ok` pages, or a 403 ban. */
function fake(name: string, behaviour: (url: URL) => 'ok' | 'ban'): ProxyProvider & { calls: string[] } {
  const calls: string[] = [];
  return {
    name,
    calls,
    resolve: () => ({
      api: async (request) => {
        calls.push(request.url);
        const banned = behaviour(new URL(request.url)) === 'ban';
        const html = banned ? 'blocked' : `<p>${name}</p>`;
        return { response: { url: request.url, statusCode: banned ? 403 : 200, httpResponseBody: btoa(html) }, statusCode: banned ? 403 : 200, html };
      },
    }),
  };
}

const working = () => custom('working', () => `http://bob:secret@127.0.0.1:${proxy.port}`);
const broken = () => custom('broken', () => 'http://u:p@127.0.0.1:1'); // connection refused

/** A client that records every attempt. */
function client(provider: ProxyProvider, options: ConstructorParameters<typeof Xyte>[0] = {}) {
  const attempts: AttemptInfo[] = [];
  const xyte = new Xyte({ proxy: provider, onAttempt: (info) => attempts.push(info), onWarning: () => {}, ...options });
  return { xyte, attempts, get: (path = '/html') => xyte.extract({ url: `${target.base}${path}`, httpResponseBody: true }).catch((e) => e) };
}

describe('onAttempt', () => {
  test('reports the provider a combinator picked, the result, latency and size', async () => {
    const { attempts, get } = client(route({ 'elsewhere.example': working() }, rotate([broken(), working()])), { retries: 1 });
    await get();
    expect(attempts.map((a) => [a.provider, a.result, a.attempt])).toEqual([
      ['broken', 'error', 0],
      ['working', 'ok', 1],
    ]);
    expect(attempts[1]).toMatchObject({ statusCode: 200, browser: false, url: `${target.base}/html` });
    expect(attempts[1]!.bytes).toBeGreaterThan(0);
    expect(attempts[1]!.ms).toBeGreaterThanOrEqual(0);
  });

  test('a ban is a ban', async () => {
    const { attempts, get } = client(working(), { retries: 1 });
    await get('/forbidden');
    expect(attempts.map((a) => a.result)).toEqual(['ban', 'ban']);
  });
});

describe('byKind / byCountry', () => {
  const a = custom('a', () => 'http://a:p@a.example:1');
  const b = custom('b', () => 'http://b:p@b.example:1');
  const host = async (provider: ProxyProvider, c: Partial<ProxyContext>) =>
    new URL(((await provider.resolve(ctx(c))) as { url: string }).url).hostname;

  test('byKind: HTTP and browser attempts go to different providers', async () => {
    const kind = byKind({ http: a, browser: b });
    expect(await host(kind, { browser: false })).toBe('a.example');
    expect(await host(kind, { browser: true })).toBe('b.example');
  });

  test('byCountry: by geolocation, else the fallback', async () => {
    const country = byCountry({ us: a }, b);
    expect(await host(country, { country: 'US' })).toBe('a.example');
    expect(await host(country, { country: 'DE' })).toBe('b.example');
    expect(await host(country, {})).toBe('b.example');
  });
});

describe('weighted', () => {
  test('splits requests by weight; a retry moves to the next provider', async () => {
    const a = custom('a', () => 'http://a:p@a.example:1');
    const b = custom('b', () => 'http://b:p@b.example:1');
    const split = weighted([[a, 9], [b, 1]]);
    let toB = 0;
    for (let i = 0; i < 2000; i++) {
      const path: string[] = [];
      await split.resolve(ctx({ requestId: `req-${i}`, path }));
      if (path[0] === 'b') toB++;
    }
    expect(toB / 2000).toBeGreaterThan(0.06);
    expect(toB / 2000).toBeLessThan(0.14);

    const first: string[] = [];
    const retry: string[] = [];
    await split.resolve(ctx({ requestId: 'x', path: first }));
    await split.resolve(ctx({ requestId: 'x', attempt: 1, path: retry }));
    expect(retry[0]).not.toBe(first[0]);
  });
});

describe('healthy', () => {
  test('after N straight failures the provider is skipped; after the cooldown one try decides', async () => {
    const changes: boolean[] = [];
    // The cooldown outlasts a retry's backoff (~0.5 s), so the third request finds it still open.
    const flaky = healthy(broken(), { failures: 2, cooldown: 1.5, onChange: (open) => changes.push(open) });
    const { attempts, get } = client(rotate([flaky, working()]), { retries: 1 });

    await get();
    await get();
    expect(changes).toEqual([true]);
    attempts.length = 0;
    await get();
    expect(attempts.map((a) => a.provider)).toEqual(['working']); // skipped: no attempt lost

    await new Promise((r) => setTimeout(r, 1600));
    attempts.length = 0;
    await get();
    expect(attempts.map((a) => a.provider)).toEqual(['broken', 'working']); // half-open: tried once, reopened
    attempts.length = 0;
    await get();
    expect(attempts.map((a) => a.provider)).toEqual(['working']);
  });

  test('bans do not open the circuit', async () => {
    const changes: boolean[] = [];
    const { get } = client(healthy(working(), { failures: 1, onChange: (open) => changes.push(open) }), { retries: 1 });
    await get('/forbidden');
    expect(changes).toEqual([]);
  });
});

describe('budget', () => {
  test('alone: a 429 /limits/over-user-limit once spent', async () => {
    const { get } = client(budget(working(), { max: 2, per: 'hour' }), { retries: 0 });
    expect((await get()).statusCode).toBe(200);
    expect((await get()).statusCode).toBe(200);
    const error = await get();
    expect(error).toMatchObject({ status: 429, type: '/limits/over-user-limit' });
    expect(error.retryable).toBe(true);
  });

  test('in a rotate: skipped once spent; network failures are given back', async () => {
    const capped = budget(broken(), { max: 1, per: 'hour' });
    const { attempts, get } = client(rotate([capped, working()]), { retries: 1 });
    await get();
    await get(); // the failed attempt was given back, so the budget is still there
    expect(attempts.filter((a) => a.provider === 'broken')).toHaveLength(2);

    const paid = budget(working(), { max: 1, per: 'minute' });
    const second = client(rotate([paid, custom('other', () => `http://bob:secret@127.0.0.1:${proxy.port}`)]));
    await second.get();
    await second.get();
    expect(second.attempts.map((a) => a.provider)).toEqual(['working', 'other']);
  });
});

describe('adaptive', () => {
  test('learns per site to skip the cheap provider that gets banned, and keeps it where it works', async () => {
    const cheap = fake('cheap', (url) => (url.hostname === 'hard.example' ? 'ban' : 'ok'));
    const expensive = fake('expensive', () => 'ok');
    const smart = adaptive([cheap, expensive], { explore: 0 });
    const xyte = new Xyte({ proxy: smart, retries: 1 });
    const get = (host: string) => xyte.extract({ url: `https://${host}/`, httpResponseBody: true });

    for (let i = 0; i < 4; i++) expect(decodeBody((await get('hard.example')).httpResponseBody!)).toContain('expensive');
    expect(cheap.calls.filter((u) => u.includes('hard.example'))).toHaveLength(4); // tried, banned each time

    cheap.calls.length = 0;
    await get('hard.example');
    expect(cheap.calls).toHaveLength(0); // learned: straight to the one that works

    await get('easy.example');
    expect(cheap.calls).toEqual(['https://easy.example/']); // another site still starts cheap

    const scores = smart.scores();
    expect(scores['hard.example']!.cheap).toBeLessThan(0.5);
    expect(scores['easy.example']!.cheap).toBe(1);
  });

  test('explore re-tests the cheaper provider', async () => {
    let blocked = true;
    const cheap = fake('cheap', () => (blocked ? 'ban' : 'ok'));
    const smart = adaptive([cheap, fake('expensive', () => 'ok')], { explore: 1 });
    const xyte = new Xyte({ proxy: smart, retries: 1 });
    for (let i = 0; i < 5; i++) await xyte.extract({ url: 'https://site.example/', httpResponseBody: true });
    blocked = false; // the site stopped blocking
    cheap.calls.length = 0;
    await xyte.extract({ url: 'https://site.example/', httpResponseBody: true });
    expect(cheap.calls).toHaveLength(1);
  });
});

describe('browserFallback', () => {
  test('a banned plain GET is retried in a browser; the raw page comes back as httpResponseBody', async () => {
    const { xyte, attempts } = client(working(), { retries: 1, browserFallback: true });
    try {
      const res = await xyte.extract({ url: `${target.base}/js-challenge`, httpResponseBody: true });
      expect(res.statusCode).toBe(200);
      expect(decodeBody(res.httpResponseBody!)).toBe('<html><body><h1>real page</h1></body></html>');
      expect(attempts.map((a) => [a.result, a.browser])).toEqual([
        ['ban', false],
        ['ok', true],
      ]);
    } finally {
      await xyte.close();
    }
  });

  test('off by default, and never for a POST', async () => {
    const off = client(working(), { retries: 1 });
    expect((await off.get('/js-challenge')).status).toBe(520);
    const post = client(working(), { retries: 1, browserFallback: true });
    const error = await post.xyte
      .extract({ url: `${target.base}/js-challenge`, httpResponseBody: true, httpRequestMethod: 'POST', httpRequestText: 'x' })
      .catch((e) => e);
    expect(error.status).toBe(520);
    expect(post.attempts.every((a) => !a.browser)).toBe(true);
  });
});

describe('from env', () => {
  const creds = { OXYLABS_USERNAME: 'u', OXYLABS_PASSWORD: 'p', ZENROWS_API_KEY: 'k' };

  test('XYTE_ADAPTIVE and XYTE_BROWSER_PROVIDER', async () => {
    expect(proxyFromEnv({ ...creds, XYTE_ADAPTIVE: 'direct,oxylabs' }).name).toBe('adaptive(direct,oxylabs-residential)');
    const kind = proxyFromEnv({ ...creds, XYTE_PROVIDER: 'zenrows', XYTE_BROWSER_PROVIDER: 'oxylabs' });
    expect(((await kind.resolve(ctx({ browser: true }))) as { url: string }).url).toContain('oxylabs.io');
    expect(((await kind.resolve(ctx({ browser: false }))) as { url: string }).url).toContain('zenrows.com');
  });

  test('XYTE_BUDGET is shared by every place that names the provider', async () => {
    const provider = proxyFromEnv({ ...creds, XYTE_PROVIDER: 'oxylabs', XYTE_ROUTES: 'a.example=oxylabs', XYTE_BUDGET: 'oxylabs=1/hour' });
    await provider.resolve(ctx({ url: new URL('https://b.example/') }));
    expect(provider.resolve(ctx({ url: new URL('https://a.example/'), requestId: 'other' }))).rejects.toThrow(/budget/);
    expect(() => proxyFromEnv({ XYTE_BUDGET: 'oxylabs=lots' })).toThrow(/XYTE_BUDGET/);
  });

  test('XYTE_CIRCUIT_BREAKER wraps named providers', () => {
    const provider = proxyFromEnv({ ...creds, XYTE_PROVIDER: 'oxylabs,zenrows', XYTE_CIRCUIT_BREAKER: '5,60' });
    expect(provider.available?.(ctx())).toBe(true);
  });
});

describe('transferBytes', () => {
  /** One attempt through a byte-counting relay in front of the proxy; Chromium told not to bypass it for loopback. */
  const measure = async (request: Parameters<Xyte['extract']>[0]) => {
    const counter = await startByteCounter(proxy.port);
    const attempts: AttemptInfo[] = [];
    const xyte = new Xyte({
      proxy: custom('counted', () => `http://bob:secret@127.0.0.1:${counter.port}`),
      retries: 0,
      onAttempt: (a) => attempts.push(a),
      browser: { launchOptions: { args: ['--proxy-bypass-list=<-loopback>'] } },
    });
    try {
      await xyte.extract(request);
      await new Promise((r) => setTimeout(r, 50));
      return { measured: attempts[0]!.transferBytes!, page: attempts[0]!.bytes!, wire: counter.bytes() };
    } finally {
      await xyte.close();
      await counter.stop();
    }
  };

  test('HTTP: compressed body plus headers, within a few percent of the wire', async () => {
    const { measured, page, wire } = await measure({ url: `${target.base}/gzip`, httpResponseBody: true });
    expect(page).toBeGreaterThan(200_000); // decoded
    expect(wire).toBeLessThan(5_000); // as transferred
    expect(Math.abs(measured - wire) / wire).toBeLessThan(0.05);
  });

  test('HTTP: a compressed body streamed without Content-Length is estimated by recompressing', async () => {
    const { measured, page, wire } = await measure({ url: `${target.base}/gzip-chunked`, httpResponseBody: true });
    expect(page).toBeGreaterThan(150_000);
    expect(wire).toBeLessThan(page / 2);
    expect(Math.abs(measured - wire) / wire).toBeLessThan(0.1);
  });

  // Chromium's proxy-auth handshake (a 407, then the request again) adds ~1 KB per connection
  // that it doesn't report: noise on a real page, so the page here is a realistic 200 KB.
  test('browser: every sub-request, within a few percent of the wire', async () => {
    const { measured, wire } = await measure({ url: `${target.base}/noise`, browserHtml: true });
    expect(wire).toBeGreaterThan(200_000);
    expect(Math.abs(measured - wire) / wire).toBeLessThan(0.05);
  });
});
