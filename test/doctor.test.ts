import { afterAll, beforeAll, expect, test } from 'bun:test';
import { doctor, formatDoctor } from '../src/index.ts';
import { startProxy, startTarget } from './fixtures.ts';

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

test('doctor: the exit each provider gets, rejected or missing credentials, and geolocation', async () => {
  const results = await doctor({
    env: { XYTE_PROXY_URL: `http://bob:wrong@127.0.0.1:${proxy.port}`, ZENROWS_API_KEY: '' },
    providers: ['direct', 'XYTE_PROXY_URL', 'zenrows'],
    url: `${target.base}/ipinfo`,
    country: 'US',
    timeout: 10,
  });
  const by = Object.fromEntries(results.map((r) => [r.provider, r]));
  expect(by.direct).toMatchObject({ ok: true, ip: '203.0.113.7', country: 'AR', org: 'AS0 Test Net' });
  expect(by.direct!.note).toContain("not US: geolocation isn't applied");
  expect(by.XYTE_PROXY_URL).toMatchObject({ ok: false, error: 'credentials rejected by the proxy (407)' });
  expect(by.zenrows).toMatchObject({ ok: false, error: 'ZENROWS_API_KEY is required' });

  const table = formatDoctor(results);
  expect(table.split('\n')[0]).toMatch(/^provider\s+status\s+exit \/ error/);
  expect(table).toContain('FAIL');
});

test('doctor: by default, direct plus every provider the environment configures', async () => {
  const results = await doctor({
    env: { XYTE_PROVIDER: 'zenrows', XYTE_ROUTES: 'a.example=scrapingbee+zenrows' },
    url: `${target.base}/ipinfo`,
    timeout: 10,
  });
  expect(results.map((r) => r.provider)).toEqual(['direct', 'zenrows', 'scrapingbee']);
});
