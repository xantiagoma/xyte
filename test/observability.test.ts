import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { createHandler, custom, rateFor, ratesFromEnv, rotate, route, Xyte, type RequestReport } from '../src/index.ts';
import { startProxy, startTarget } from './fixtures.ts';

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

const working = () => custom('working', () => `http://bob:secret@127.0.0.1:${proxy.port}`);
const broken = () => custom('broken', () => 'http://u:p@127.0.0.1:1');

describe('RequestReport', () => {
  test('every attempt, the route taken, totals per provider', async () => {
    const reports: RequestReport[] = [];
    const xyte = new Xyte({
      retries: 1,
      onRequest: (r) => reports.push(r),
      proxy: route({ 'other.example': working() }, rotate([broken(), working()])),
    });
    await xyte.extract({ url: `${target.base}/html`, httpResponseBody: true });
    const [report] = reports;
    expect(report).toMatchObject({ outcome: 'ok', statusCode: 200, provider: 'working', host: new URL(target.base).hostname, browser: false, escalated: false });
    expect(report!.attempts.map((a) => [a.provider, a.result, a.path])).toEqual([
      ['broken', 'error', ['rotate(broken,working)', 'broken']],
      ['working', 'ok', ['rotate(broken,working)', 'working']],
    ]);
    expect(report!.attempts.every((a) => a.requestId === report!.requestId)).toBe(true);
    expect(report!.byProvider.broken).toMatchObject({ attempts: 1, error: 1, transferBytes: 0 });
    expect(report!.byProvider.working).toMatchObject({ attempts: 1, ok: 1 });
    expect(report!.transferBytes).toBe(report!.byProvider.working!.transferBytes);
    expect(report!.transferBytes).toBeGreaterThan(0);
  });

  test('failures are reported too, with the problem; invalid requests with no attempts', async () => {
    const reports: RequestReport[] = [];
    const xyte = new Xyte({ retries: 1, proxy: working() });
    await xyte.extract({ url: `${target.base}/forbidden`, httpResponseBody: true }, { onReport: (r) => reports.push(r) }).catch(() => {});
    await xyte.extract({ url: `${target.base}/html` }, { onReport: (r) => reports.push(r) }).catch(() => {});
    expect(reports[0]).toMatchObject({ outcome: 'error', error: { status: 520, type: '/download/website-ban' }, provider: undefined });
    expect(reports[0]!.byProvider.working).toMatchObject({ attempts: 2, ban: 2 });
    expect(reports[1]).toMatchObject({ outcome: 'error', error: { status: 422 }, attempts: [] });
  });

  test("the request's tags and jobId label the report and every attempt", async () => {
    const reports: RequestReport[] = [];
    const xyte = new Xyte({ proxy: working(), onRequest: (r) => reports.push(r) });
    const tags = { spider: 'yelp', env: 'prod', shard: null };
    const res = await xyte.extract({ url: `${target.base}/html`, httpResponseBody: true, tags, jobId: 'job-42' });
    expect(reports[0]).toMatchObject({ tags, jobId: 'job-42' });
    expect(reports[0]!.attempts.every((a) => a.tags === tags)).toBe(true);
    expect(res).not.toHaveProperty('tags'); // the response stays Zyte's
  });

  test('time in the concurrency queue is reported apart', async () => {
    const reports: RequestReport[] = [];
    const xyte = new Xyte({ concurrency: 1, proxy: working(), onRequest: (r) => reports.push(r) });
    await Promise.all([1, 2].map(() => xyte.extract({ url: `${target.base}/api/slow`, httpResponseBody: true })));
    expect(Math.max(...reports.map((r) => r.queuedMs))).toBeGreaterThan(300); // the second waited for the first
  });

  test('browserFallback shows as escalated', async () => {
    const reports: RequestReport[] = [];
    const xyte = new Xyte({ retries: 1, browserFallback: true, proxy: working(), onRequest: (r) => reports.push(r) });
    try {
      await xyte.extract({ url: `${target.base}/js-challenge`, httpResponseBody: true });
    } finally {
      await xyte.close();
    }
    expect(reports[0]).toMatchObject({ outcome: 'ok', browser: true, escalated: true });
  });
});

describe('costs (rates)', () => {
  test('per attempt and per request: GB on the wire, per answer, per success; errors and failures cost nothing', async () => {
    const reports: RequestReport[] = [];
    const xyte = new Xyte({
      retries: 1,
      proxy: rotate([broken(), working()]),
      rates: { working: { perGB: 1000, perRequest: 0.01, perSuccess: 0.1 }, broken: { perRequest: 5 } },
      onRequest: (r) => reports.push(r),
    });
    await xyte.extract({ url: `${target.base}/html`, httpResponseBody: true });
    const [failed, ok] = reports[0]!.attempts;
    expect(failed!.costUsd).toBe(0); // a network error got no answer
    expect(ok!.costUsd).toBeCloseTo((ok!.transferBytes! / 1e9) * 1000 + 0.01 + 0.1, 10);
    expect(reports[0]!.costUsd).toBeCloseTo(ok!.costUsd!, 10);
    expect(reports[0]!.byProvider.working!.costUsd).toBeCloseTo(ok!.costUsd!, 10);

    const banned = new Xyte({ retries: 0, proxy: working(), rates: { working: { perRequest: 0.01, perSuccess: 0.1 } }, onRequest: (r) => reports.push(r) });
    await banned.extract({ url: `${target.base}/forbidden`, httpResponseBody: true }).catch(() => {});
    expect(reports[1]!.costUsd).toBeCloseTo(0.01, 10); // a ban is an answer, not a success
  });

  test('a rate key matches the provider or its prefix; XYTE_RATES', () => {
    const rates = { oxylabs: { perGB: 6 }, 'oxylabs-datacenter': { perGB: 0.6 } };
    expect(rateFor(rates, 'oxylabs-residential')).toEqual({ perGB: 6 });
    expect(rateFor(rates, 'oxylabs-datacenter')).toEqual({ perGB: 0.6 });
    expect(rateFor(rates, 'zyte-api')).toBeUndefined();
    expect(ratesFromEnv({ XYTE_RATES: 'oxylabs=6/GB, zyte-api=0.0013/request, x=2/GB+0.001/success' })).toEqual({
      oxylabs: { perGB: 6 },
      'zyte-api': { perRequest: 0.0013 },
      x: { perGB: 2, perSuccess: 0.001 },
    });
    expect(() => ratesFromEnv({ XYTE_RATES: 'oxylabs=cheap' })).toThrow(/XYTE_RATES/);
  });
});

describe('server', () => {
  test('X-Xyte-* headers on answers and on problems; the body stays Zyte’s', async () => {
    const handler = createHandler(new Xyte({ retries: 1, proxy: rotate([broken(), working()]) }));
    const call = (body: unknown) => handler(new Request('http://x/v1/extract', { method: 'POST', body: JSON.stringify(body) }));

    const ok = await call({ url: `${target.base}/html`, httpResponseBody: true });
    expect(ok.headers.get('x-xyte-attempts')).toBe('broken:error,working:ok');
    expect(Number(ok.headers.get('x-xyte-transfer-bytes'))).toBeGreaterThan(0);
    expect(ok.headers.get('x-xyte-request-id')).toBeTruthy();
    expect(Object.keys(await ok.json())).toEqual(['url', 'statusCode', 'httpResponseBody']);

    const banned = await call({ url: `${target.base}/forbidden`, httpResponseBody: true });
    expect(banned.status).toBe(520);
    expect(banned.headers.get('x-xyte-attempts')).toBe('broken:error,working:ban');
  });
});
