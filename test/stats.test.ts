import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createHandler, memoryStore, StatsRecorder, Xyte, type RequestReport } from '../src/index.ts';
import { startTarget } from './fixtures.ts';

let target: ReturnType<typeof startTarget>;
beforeAll(() => {
  target = startTarget();
});
afterAll(() => target.stop());

const report = (over: Partial<RequestReport>): RequestReport => ({
  requestId: 'r',
  url: 'https://shop.example/x',
  host: 'shop.example',
  outcome: 'ok',
  statusCode: 200,
  browser: false,
  escalated: false,
  queuedMs: 0,
  ms: 1000,
  attempts: [],
  transferBytes: 1000,
  byProvider: {},
  warnings: [],
  ...over,
});

describe('StatsRecorder', () => {
  test("totals in Zyte's /api/v1/stats shape, which a billing check reads", async () => {
    const stats = new StatsRecorder();
    const at = new Date('2026-10-20T10:30:00Z');
    stats.record(report({ costUsd: 0.002, ms: 2000 }), at);
    stats.record(report({ outcome: 'ok', statusCode: 404, costUsd: 0.001 }), at);
    stats.record(report({ outcome: 'error', statusCode: undefined, error: { status: 520, type: '/download/website-ban', title: 'Website Ban' } }), at);
    stats.record(report({ outcome: 'aborted', statusCode: undefined }), at);
    const res = await stats.query({ organization_id: '42', start_time: '2026-10-20T00:00:00Z', end_time: '2026-10-21T00:00:00Z' }, 'v1');
    expect(res).toMatchObject({ page: 1, page_size: 500, total_result_count: 1 });
    expect(res.results[0]).toMatchObject({
      organization_id: 42,
      request_count: 4,
      billed_traffic_bytes: 4000,
      cost_micro_total: [{ currency: 'USD', value: 3000 }],
      status_codes: [
        { code: null, count: 1 },
        { code: 200, count: 1 },
        { code: 404, count: 1 },
        { code: 520, count: 1 },
      ],
    });
    // The exact field a vendor-balance check parses.
    const spend = (res.results[0]!.cost_micro_total as { value: number }[])[0]!.value / 1e6;
    expect(spend).toBeCloseTo(0.003, 6);
  });

  test('/api/stats format, grouping by day and domain, filters', async () => {
    const stats = new StatsRecorder();
    stats.record(report({ host: 'a.example', tags: { spider: 'yelp' } }), new Date('2026-10-20T10:00:00Z'));
    stats.record(report({ host: 'b.example', tags: { spider: 'wolt' } }), new Date('2026-10-20T11:00:00Z'));
    stats.record(report({ host: 'a.example', tags: { spider: 'yelp' }, statusCode: 404 }), new Date('2026-10-21T09:00:00Z'));
    const window = { start_time: '2026-10-19T00:00:00Z', end_time: '2026-10-22T00:00:00Z' };
    const grouped = await stats.query({ ...window, groupby_time: 'day', groupby_domain: 'true' });
    expect(grouped.results.map((r) => [r.day, r.domain, r.request_count])).toEqual([
      ['2026-10-20T00:00:00.000Z', 'a.example', 1],
      ['2026-10-20T00:00:00.000Z', 'b.example', 1],
      ['2026-10-21T00:00:00.000Z', 'a.example', 1],
    ]);
    expect(grouped.results[0]).toHaveProperty('cost_microusd_total', '0.00');
    expect((await stats.query({ ...window, tags: 'spider:yelp' })).results[0]!.request_count).toBe(2);
    expect((await stats.query({ ...window, domains: 'b.example' })).results[0]!.request_count).toBe(1);
    expect((await stats.query({ ...window, response_codes: '404' })).results[0]!.request_count).toBe(1);
    expect((await stats.query({ ...window, page_size: 1, page: 2, groupby_domain: true })).results.map((r) => r.domain)).toEqual(['b.example']);
    await expect(stats.query({ include_domain_health: 'true' })).rejects.toThrow(/groupby_domain/);
  });

  test('with a shared store, two instances add up', async () => {
    const store = memoryStore();
    const one = new StatsRecorder({ store });
    const two = new StatsRecorder({ store });
    const at = new Date('2026-10-20T10:00:00Z');
    one.record(report({}), at);
    two.record(report({}), at);
    await one.flush();
    await two.flush();
    const res = await one.query({ start_time: '2026-10-20T00:00:00Z', end_time: '2026-10-21T00:00:00Z' });
    expect(res.results[0]!.request_count).toBe(2);
  });
});

test('the server records what it serves and answers /api/v1/stats', async () => {
  const handler = createHandler(new Xyte({ retries: 0, rates: { direct: { perRequest: 0.002 } } }), { apiKeys: ['K'] });
  const auth = { authorization: `Basic ${btoa('K:')}` };
  await handler(new Request('http://x/v1/extract', { method: 'POST', headers: auth, body: JSON.stringify({ url: `${target.base}/html`, httpResponseBody: true }) }));
  const res = await handler(new Request('http://x/api/v1/stats?organization_id=7', { headers: auth }));
  expect(res.status).toBe(200);
  const body = (await res.json()) as { results: Record<string, unknown>[] };
  expect(body.results[0]).toMatchObject({ organization_id: 7, request_count: 1, cost_micro_total: [{ currency: 'USD', value: 2000 }] });
  expect((await handler(new Request('http://x/api/v1/stats', { headers: { authorization: `Basic ${btoa('bad:')}` } }))).status).toBe(401);
  expect((await handler(new Request('http://x/api/stats?include_domain_health=true', { headers: auth }))).status).toBe(422);
});
