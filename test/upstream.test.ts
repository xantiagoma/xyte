import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import {
  createHandler,
  decodeBody,
  direct,
  healthy,
  named,
  rotate,
  watch,
  Xyte,
  xyteApi,
  zyteApi,
  zyteSpend,
  type RequestReport,
} from '../src/index.ts';
import { startTarget } from './fixtures.ts';

const suspended = { type: '/auth/account-suspended', status: 403, title: 'Account Suspended', detail: 'Account is suspended, check billing details.' };

/** A Zyte-compatible endpoint that always answers `body` with `status`, counting the calls. */
function startUpstream(status: number, body: unknown) {
  let calls = 0;
  const server = Bun.serve({
    port: 0,
    fetch: () => {
      calls++;
      return Response.json(body, { status });
    },
  });
  return { endpoint: `http://127.0.0.1:${server.port}/v1/extract`, calls: () => calls, stop: () => server.stop(true) };
}

/** A client whose request reports land in `reports`. */
function reporting(options: ConstructorParameters<typeof Xyte>[0]) {
  const reports: RequestReport[] = [];
  return { xyte: new Xyte({ ...options, onRequest: (report) => reports.push(report) }), reports };
}

const attempts = (report: RequestReport | undefined) => report?.attempts.map((a) => `${a.provider}:${a.result}`);

let target: ReturnType<typeof startTarget>;
beforeAll(() => {
  target = startTarget();
});
afterAll(() => target.stop());

describe('account problems (a bad key, a suspended account)', () => {
  test('alone: Zyte’s 403 as is, not retryable, after one call', async () => {
    const zyte = startUpstream(403, suspended);
    const { xyte, reports } = reporting({ retries: 3, proxy: zyteApi({ apiKey: 'k', endpoint: zyte.endpoint }) });
    const error = await xyte.extract({ url: 'https://toscrape.com/', httpResponseBody: true }).catch((e) => e);
    expect(error.toJSON()).toEqual(suspended);
    expect(error.retryable).toBe(false);
    expect(zyte.calls()).toBe(1);
    expect(attempts(reports[0])).toEqual(['zyte-api:error']);
    zyte.stop();
  });

  test('a 401 without a body is /auth/not-valid', async () => {
    const zyte = startUpstream(401, {});
    const error = await new Xyte({ proxy: zyteApi({ apiKey: 'k', endpoint: zyte.endpoint }) })
      .extract({ url: 'https://toscrape.com/', httpResponseBody: true })
      .catch((e) => e);
    expect(error).toMatchObject({ status: 401, type: '/auth/not-valid', retryable: false });
    expect(zyte.calls()).toBe(1);
    zyte.stop();
  });

  test('in rotate: the next provider gets the request, and Zyte isn’t tried again for it', async () => {
    const zyte = startUpstream(403, suspended);
    // The target bans the first two direct attempts, so a plain rotation would come back to Zyte.
    let hits = 0;
    const flaky = Bun.serve({ port: 0, fetch: () => (++hits <= 2 ? new Response('blocked', { status: 429 }) : new Response('<p>ok</p>')) });
    const { xyte, reports } = reporting({ retries: 4, proxy: rotate([zyteApi({ apiKey: 'k', endpoint: zyte.endpoint }), direct()]) });
    const res = await xyte.extract({ url: `http://127.0.0.1:${flaky.port}/`, httpResponseBody: true });
    expect(decodeBody(res.httpResponseBody!)).toBe('<p>ok</p>');
    expect(zyte.calls()).toBe(1);
    expect(attempts(reports[0])).toEqual(['zyte-api:error', 'direct:ban', 'zyte-api:aborted', 'direct:ban', 'zyte-api:aborted', 'direct:ok']);
    zyte.stop();
    flaky.stop(true);
  });

  test('with healthy(): the circuit opens at once, so the next request goes straight to the fallback', async () => {
    const zyte = startUpstream(403, suspended);
    const changes: boolean[] = [];
    const proxy = rotate([healthy(zyteApi({ apiKey: 'k', endpoint: zyte.endpoint }), { onChange: (open) => changes.push(open) }), direct()]);
    const { xyte, reports } = reporting({ proxy });
    await xyte.extract({ url: `${target.base}/html`, httpResponseBody: true });
    await xyte.extract({ url: `${target.base}/html`, httpResponseBody: true });
    expect(changes).toEqual([true]);
    expect(zyte.calls()).toBe(1);
    expect(attempts(reports[0])).toEqual(['zyte-api:error', 'direct:ok']);
    expect(attempts(reports[1])).toEqual(['direct:ok']);
    zyte.stop();
  });

  test('when every provider has an account problem, the last one’s problem comes back', async () => {
    const a = startUpstream(403, suspended);
    const b = startUpstream(401, { type: '/auth/key-not-found', status: 401, title: 'Authentication Key Not Found' });
    const proxy = rotate([zyteApi({ apiKey: 'k', endpoint: a.endpoint, name: 'a' }), zyteApi({ apiKey: 'k', endpoint: b.endpoint, name: 'b' })]);
    const error = await new Xyte({ retries: 3, proxy }).extract({ url: 'https://toscrape.com/', httpResponseBody: true }).catch((e) => e);
    expect(error).toMatchObject({ status: 401, type: '/auth/key-not-found', retryable: false });
    expect(a.calls() + b.calls()).toBeLessThanOrEqual(4);
    a.stop();
    b.stop();
  });

  test('a request error (400) is still final, in a combinator too', async () => {
    const zyte = startUpstream(400, { type: '/request/invalid', status: 400, title: 'Invalid Request', detail: 'bad combo' });
    const error = await new Xyte({ proxy: rotate([zyteApi({ apiKey: 'k', endpoint: zyte.endpoint }), direct()]) })
      .extract({ url: `${target.base}/html`, httpResponseBody: true })
      .catch((e) => e);
    expect(error).toMatchObject({ status: 400, detail: 'bad combo' });
    zyte.stop();
  });
});

describe('names', () => {
  test('zyteApi({ name }) and named() keep each provider’s numbers apart', async () => {
    const ok = (body: string) => (async () => Response.json({ url: target.base, statusCode: 200, httpResponseBody: btoa(body) })) as unknown as typeof fetch;
    const failing = (async () => Response.json({ type: '/download/temporary-error', status: 520, title: 'x' }, { status: 520 })) as unknown as typeof fetch;
    const { xyte, reports } = reporting({
      retries: 2,
      proxy: rotate([zyteApi({ apiKey: 'k', fetch: failing }), zyteApi({ apiKey: 'k', fetch: failing, name: 'xyte-oxylabs' }), named('backup', zyteApi({ apiKey: 'k', fetch: ok('b') }))]),
    });
    await xyte.extract({ url: `${target.base}/html`, httpResponseBody: true });
    expect(attempts(reports[0])).toEqual(['zyte-api:error', 'xyte-oxylabs:error', 'backup:ok']);
    expect(Object.keys(reports[0]!.byProvider).sort()).toEqual(['backup', 'xyte-oxylabs', 'zyte-api']);
  });

  test('named() keeps the wrapped provider’s circuit', async () => {
    const zyte = startUpstream(403, suspended);
    const proxy = rotate([named('zyte-main', healthy(zyteApi({ apiKey: 'k', endpoint: zyte.endpoint }))), direct()]);
    const { xyte, reports } = reporting({ proxy });
    await xyte.extract({ url: `${target.base}/html`, httpResponseBody: true });
    await xyte.extract({ url: `${target.base}/html`, httpResponseBody: true });
    expect(attempts(reports[0])).toEqual(['zyte-main:error', 'direct:ok']);
    expect(attempts(reports[1])).toEqual(['direct:ok']);
    zyte.stop();
  });
});

describe('xyteApi: another xyte server as a provider', () => {
  test('its attempts and bytes end up in the local report', async () => {
    let hits = 0;
    const flaky = Bun.serve({ port: 0, fetch: () => (++hits === 1 ? new Response('blocked', { status: 429 }) : new Response('<p>remote</p>')) });
    const remote = Bun.serve({ port: 0, fetch: createHandler(new Xyte({ proxy: named('remote-exit', direct()) }), { apiKeys: ['secret'] }) });
    const { xyte, reports } = reporting({ proxy: xyteApi({ endpoint: `http://127.0.0.1:${remote.port}/v1/extract`, apiKey: 'secret', name: 'xyte-remote' }) });
    const res = await xyte.extract({ url: `http://127.0.0.1:${flaky.port}/`, httpResponseBody: true });
    expect(decodeBody(res.httpResponseBody!)).toBe('<p>remote</p>');
    const attempt = reports[0]!.attempts[0]!;
    expect(attempt.provider).toBe('xyte-remote');
    expect(attempt.upstream?.attempts).toEqual([
      { provider: 'remote-exit', result: 'ban' },
      { provider: 'remote-exit', result: 'ok' },
    ]);
    expect(attempt.upstream?.requestId).toBeString();
    expect(attempt.transferBytes).toBeGreaterThan(0);
    expect(reports[0]!.transferBytes).toBe(attempt.transferBytes!);
    remote.stop(true);
    flaky.stop(true);
  });

  test('a failing remote: its attempts are kept on the local failed attempt', async () => {
    const remote = Bun.serve({ port: 0, fetch: createHandler(new Xyte({ retries: 0, proxy: named('remote-exit', direct()) })) });
    const { xyte, reports } = reporting({ retries: 0, proxy: xyteApi({ endpoint: `http://127.0.0.1:${remote.port}/v1/extract`, apiKey: 'x' }) });
    const blocked = Bun.serve({ port: 0, fetch: () => new Response('blocked', { status: 429 }) });
    const error = await xyte.extract({ url: `http://127.0.0.1:${blocked.port}/`, httpResponseBody: true }).catch((e) => e);
    expect(error.status).toBe(520);
    expect(reports[0]!.attempts[0]).toMatchObject({ provider: 'xyte', result: 'ban', upstream: { attempts: [{ provider: 'remote-exit', result: 'ban' }] } });
    remote.stop(true);
    blocked.stop(true);
  });

  test('zyteApi() ignores the headers (Zyte doesn’t send them)', async () => {
    const fetch = (async () =>
      Response.json({ url: target.base, statusCode: 200, httpResponseBody: btoa('x') }, { headers: { 'x-xyte-attempts': 'a:ok' } })) as unknown as typeof globalThis.fetch;
    const { xyte, reports } = reporting({ proxy: zyteApi({ apiKey: 'k', fetch }) });
    await xyte.extract({ url: `${target.base}/html`, httpResponseBody: true });
    expect(reports[0]!.attempts[0]!.upstream).toBeUndefined();
  });

  test('needs an endpoint', () => {
    expect(() => xyteApi({ apiKey: 'k' } as never)).toThrow('endpoint');
  });
});

test('fetch is resolved at call time: a stub put on globalThis later is used', async () => {
  const provider = zyteApi({ apiKey: 'k' });
  const xyte = new Xyte({ proxy: provider });
  const original = globalThis.fetch;
  let called = '';
  globalThis.fetch = (async (input: string | URL | Request) => {
    called = String(input);
    return Response.json({ url: 'https://x.example/', statusCode: 200, httpResponseBody: btoa('stub') });
  }) as typeof fetch;
  try {
    const res = await xyte.extract({ url: 'https://x.example/', httpResponseBody: true });
    expect(decodeBody(res.httpResponseBody!)).toBe('stub');
    expect(called).toBe('https://api.zyte.com/v1/extract');
  } finally {
    globalThis.fetch = original;
  }
});

describe('zyteSpend', () => {
  const stats = (micro: number) => {
    const calls: { url: URL; auth: string }[] = [];
    const fetch = (async (input: string | URL | Request, init: RequestInit = {}) => {
      calls.push({ url: new URL(String(input)), auth: (init.headers as Record<string, string>).authorization! });
      return Response.json({ page: 1, page_size: 500, total_result_count: 1, results: [{ cost_micro_total: [{ currency: 'USD', value: micro }, { currency: 'EUR', value: 999_000_000 }] }] });
    }) as typeof globalThis.fetch;
    return { fetch, calls };
  };

  test('spend under the cap: available, with what is left', async () => {
    const { fetch, calls } = stats(40_000_000);
    const result = await zyteSpend({ apiKey: 'dash', organizationId: 123, limitUsd: 100, maxPercent: 90, fetch })(AbortSignal.timeout(1000));
    expect(result).toEqual({ available: true, remaining: 60, detail: 'zyte 40.00/100 USD this cycle' });
    const { url, auth } = calls[0]!;
    expect(url.origin + url.pathname).toBe('https://zyte-api-stats.zyte.com/api/v1/stats');
    expect(url.searchParams.get('organization_id')).toBe('123');
    expect(auth).toBe(`Basic ${btoa('dash:')}`);
    // The cycle starts on day 1 by default, at midnight UTC.
    const start = new Date(url.searchParams.get('start_time')!);
    expect(start.getUTCDate()).toBe(1);
    expect(start.getUTCHours()).toBe(0);
    expect(start.getTime()).toBeLessThanOrEqual(Date.now());
  });

  test('from maxPercent of the limit: unavailable, so a combinator skips Zyte', async () => {
    const { fetch } = stats(95_000_000);
    expect((await zyteSpend({ apiKey: 'd', organizationId: 1, limitUsd: 100, maxPercent: 90, fetch })(AbortSignal.timeout(1000))).available).toBe(false);
  });

  test('cycleStartDay: the last such day not in the future', async () => {
    const { fetch, calls } = stats(0);
    const day = new Date().getUTCDate();
    await zyteSpend({ apiKey: 'd', organizationId: 1, limitUsd: 1, cycleStartDay: day, fetch })(AbortSignal.timeout(1000));
    await zyteSpend({ apiKey: 'd', organizationId: 1, limitUsd: 1, cycleStartDay: (day % 28) + 1, fetch })(AbortSignal.timeout(1000));
    const [today, other] = calls.map((c) => new Date(c.url.searchParams.get('start_time')!));
    if (day <= 28) expect(today!.getUTCDate()).toBe(day);
    expect(other!.getTime()).toBeLessThanOrEqual(Date.now());
    expect(Date.now() - other!.getTime()).toBeLessThan(32 * 86_400_000);
  });

  test('in watch(): Zyte is marked unavailable before it runs out', async () => {
    const zyte = startUpstream(200, {});
    const { fetch } = stats(100_000_000);
    const watched = watch(zyteApi({ apiKey: 'k', endpoint: zyte.endpoint }), { check: zyteSpend({ apiKey: 'd', organizationId: 1, limitUsd: 100, fetch }) });
    await watched.refresh();
    const res = await new Xyte({ proxy: rotate([watched, direct()]) }).extract({ url: `${target.base}/html`, httpResponseBody: true });
    expect(res.statusCode).toBe(200);
    expect(zyte.calls()).toBe(0);
    zyte.stop();
  });
});

test('XYTE_WATCH: zyte-api checks its status page, and its spend with the Stats API env', async () => {
  const { checkFor } = await import('../src/env.ts');
  const original = globalThis.fetch;
  const asked: string[] = [];
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input);
    asked.push(new URL(url).host);
    return url.includes('statuspage') || url.includes('status.zyte.com')
      ? Response.json({ status: { indicator: 'none', description: 'All Systems Operational' } })
      : Response.json({ results: [{ cost_micro_total: [{ currency: 'USD', value: 50_000_000 }] }] });
  }) as typeof globalThis.fetch;
  try {
    const statusOnly = await checkFor('zyte-api', {})!(AbortSignal.timeout(1000));
    expect(statusOnly.available).toBe(true);
    expect(asked).toEqual(['status.zyte.com']);
    const both = await checkFor('zyte-api', { ZYTE_STATS_API_KEY: 'd', ZYTE_ORGANIZATION_ID: '1', ZYTE_LIMIT_USD: '60', ZYTE_MAX_PERCENT: '80' })!(AbortSignal.timeout(1000));
    expect(both).toMatchObject({ available: false, remaining: 10 });
    expect(both.detail).toContain('zyte 50.00/60 USD this cycle');
  } finally {
    globalThis.fetch = original;
  }
});
