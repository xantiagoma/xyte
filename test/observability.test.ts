import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { createHandler, custom, rotate, route, Xyte, type RequestReport } from '../src/index.ts';
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
