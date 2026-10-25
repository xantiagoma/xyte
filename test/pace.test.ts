import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { parseLimit, rateLimitsFromEnv, Xyte } from '../src/index.ts';
import { Pacer } from '../src/pace.ts';
import { startTarget } from './fixtures.ts';

let target: ReturnType<typeof startTarget>;
beforeAll(() => {
  target = startTarget();
});
afterAll(() => target.stop());

const timed = async (fn: () => Promise<unknown>) => {
  const started = Date.now();
  await fn();
  return Date.now() - started;
};

describe('Pacer', () => {
  test('spaces attempts to a site evenly', async () => {
    const pacer = new Pacer({ '*': '10/s' });
    const ms = await timed(async () => {
      for (let i = 0; i < 3; i++) (await pacer.acquire('https://a.example/'))();
    });
    expect(ms).toBeGreaterThanOrEqual(190);
  });

  test("under '*' each site has its own pace; a listed site shares one with its subdomains", async () => {
    const pacer = new Pacer({ 'shop.example': '1/s', '*': '1/s' });
    const apart = await timed(async () => {
      (await pacer.acquire('https://a.example/'))();
      (await pacer.acquire('https://b.example/'))();
    });
    expect(apart).toBeLessThan(100);
    const together = await timed(async () => {
      (await pacer.acquire('https://www.shop.example/'))();
      (await pacer.acquire('https://api.shop.example/'))();
    });
    expect(together).toBeGreaterThanOrEqual(900);
  });

  test('concurrency: the next one waits for a slot; a cancelled waiter leaves the queue', async () => {
    const pacer = new Pacer({ '*': { concurrency: 1 } });
    const first = await pacer.acquire('https://a.example/');
    const controller = new AbortController();
    const cancelled = pacer.acquire('https://a.example/', controller.signal);
    const third = pacer.acquire('https://a.example/');
    controller.abort(new Error('gone'));
    await expect(cancelled).rejects.toThrow('gone');
    first();
    (await third)(); // woken, not lost to the cancelled one
  });

  test('formats', () => {
    expect(parseLimit('2/s')).toEqual({ rate: 2, per: 1 });
    expect(parseLimit('120/m')).toEqual({ rate: 120, per: 60 });
    expect(parseLimit('5/10s')).toEqual({ rate: 5, per: 10 });
    expect(() => parseLimit('fast')).toThrow(/rate limit/);
    expect(rateLimitsFromEnv({ XYTE_RATE_LIMITS: 'yelp.co.uk=2/s, *=10/s' })).toEqual({ 'yelp.co.uk': '2/s', '*': '10/s' });
    expect(() => rateLimitsFromEnv({ XYTE_RATE_LIMITS: 'yelp.co.uk=lots' })).toThrow(/rate limit/);
  });
});

test('rateLimits paces real attempts', async () => {
  const xyte = new Xyte({ retries: 0, rateLimits: { '*': '5/s' } });
  const ms = await timed(async () => {
    for (let i = 0; i < 3; i++) await xyte.extract({ url: `${target.base}/html`, httpResponseBody: true });
  });
  expect(ms).toBeGreaterThanOrEqual(390);
});
