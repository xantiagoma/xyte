import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { cacheFromEnv, createHandler, requestKey, Xyte, type RequestReport } from '../src/index.ts';
import { startTarget } from './fixtures.ts';

let target: ReturnType<typeof startTarget>;
beforeAll(() => {
  target = startTarget();
});
afterAll(() => target.stop());

const hits = (path: string) => target.hits.get(path) ?? 0;

function client(ttl: ConstructorParameters<typeof Xyte>[0] extends infer O ? (O extends { cache?: infer C } ? C : never) : never) {
  const reports: RequestReport[] = [];
  return { xyte: new Xyte({ retries: 0, cache: ttl, onRequest: (r) => reports.push(r) }), reports };
}

describe('cache', () => {
  test('a repeat is answered from the cache; labels (echoData, jobId, tags) come from each request', async () => {
    const { xyte, reports } = client({ ttl: 60 });
    const before = hits('/html');
    const first = await xyte.extract({ url: `${target.base}/html`, httpResponseBody: true, echoData: 1, tags: { a: 'x' } });
    const second = await xyte.extract({ url: `${target.base}/html`, httpResponseBody: true, echoData: 2, jobId: 'j2', tags: { a: 'y' } });
    expect(hits('/html') - before).toBe(1);
    expect(second.httpResponseBody).toBe(first.httpResponseBody!);
    expect(second).toMatchObject({ echoData: 2, jobId: 'j2' });
    expect(reports.map((r) => r.cache)).toEqual(['miss', 'hit']);
    expect(reports[1]!.attempts).toEqual([]);
  });

  test('a different request is a different entry', async () => {
    const { xyte } = client({ ttl: 60 });
    const before = hits('/echo');
    await xyte.extract({ url: `${target.base}/echo`, httpResponseBody: true });
    await xyte.extract({ url: `${target.base}/echo`, httpResponseBody: true, customHttpRequestHeaders: [{ name: 'X-A', value: '1' }] });
    expect(hits('/echo') - before).toBe(2);
    expect(requestKey({ url: 'u', httpResponseBody: true, tags: { a: '1' } })).toBe(requestKey({ httpResponseBody: true, url: 'u' }));
  });

  test('per-site ttl, with 0 for not caching; sessions are never cached', async () => {
    const host = new URL(target.base).hostname;
    const { xyte } = client({ ttl: { [host]: 0, '*': 60 } });
    const before = hits('/html');
    await xyte.extract({ url: `${target.base}/html`, httpResponseBody: true });
    await xyte.extract({ url: `${target.base}/html`, httpResponseBody: true });
    expect(hits('/html') - before).toBe(2);

    const sessions = client({ ttl: 60 }).xyte;
    const was = hits('/html');
    for (let i = 0; i < 2; i++) await sessions.extract({ url: `${target.base}/html`, httpResponseBody: true, session: { id: 's' } });
    expect(hits('/html') - was).toBe(2);
  });

  test('only cacheable answers are kept (by default below 400, plus 404 and 410)', async () => {
    const { xyte } = client({ ttl: 60, cacheable: (r) => r.statusCode === 200 });
    const before = hits('/missing');
    for (let i = 0; i < 2; i++) await xyte.extract({ url: `${target.base}/missing`, httpResponseBody: true });
    expect(hits('/missing') - before).toBe(2);
    const byDefault = client({ ttl: 60 }).xyte;
    const was = hits('/missing');
    for (let i = 0; i < 2; i++) await byDefault.extract({ url: `${target.base}/missing`, httpResponseBody: true });
    expect(hits('/missing') - was).toBe(1);
  });

  test('identical requests in flight share one run', async () => {
    const { xyte, reports } = client({ ttl: 60 });
    const before = hits('/api/slow');
    await Promise.all([1, 2, 3].map(() => xyte.extract({ url: `${target.base}/api/slow`, httpResponseBody: true })));
    expect(hits('/api/slow') - before).toBe(1);
    expect(reports.map((r) => r.cache).sort()).toEqual(['miss', 'shared', 'shared']);
  });

  test('entries expire', async () => {
    const { xyte } = client({ ttl: 1 });
    const before = hits('/html');
    await xyte.extract({ url: `${target.base}/html`, httpResponseBody: true });
    await new Promise((r) => setTimeout(r, 1100));
    await xyte.extract({ url: `${target.base}/html`, httpResponseBody: true });
    expect(hits('/html') - before).toBe(2);
  });

  test('the server says X-Xyte-Cache', async () => {
    const handler = createHandler(new Xyte({ cache: { ttl: 60 } }));
    const call = () => handler(new Request('http://x/v1/extract', { method: 'POST', body: JSON.stringify({ url: `${target.base}/landing`, httpResponseBody: true }) }));
    expect((await call()).headers.get('x-xyte-cache')).toBe('miss');
    expect((await call()).headers.get('x-xyte-cache')).toBe('hit');
  });

  test('XYTE_CACHE_TTL', () => {
    expect(cacheFromEnv({})).toBeUndefined();
    expect(cacheFromEnv({ XYTE_CACHE_TTL: '3600' })).toEqual({ ttl: 3600 });
    expect(cacheFromEnv({ XYTE_CACHE_TTL: 'wolt.com=600, *=3600' })).toEqual({ ttl: { 'wolt.com': 600, '*': 3600 } });
    expect(() => cacheFromEnv({ XYTE_CACHE_TTL: 'wolt.com' })).toThrow(/host=seconds/);
  });
});
