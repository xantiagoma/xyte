import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import {
  brightData,
  byIpType,
  decodo,
  decodeBody,
  iproyal,
  oxylabs,
  proxyFromEnv,
  proxyUrl,
  rotate,
  scraperApi,
  scrapingBee,
  Xyte,
  zenrows,
  type ProxyContext,
} from '../src/index.ts';
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

const ctx = (overrides: Partial<ProxyContext> = {}): ProxyContext => ({
  url: new URL('https://example.com/'),
  sessionId: 'abc123def456ghi',
  attempt: 0,
  browser: false,
  ...overrides,
});

const userOf = (url: string) => decodeURIComponent(new URL(url).username);
const passOf = (url: string) => decodeURIComponent(new URL(url).password);

describe('through a real proxy', () => {
  test('requests go through the proxy with its credentials', async () => {
    const xyte = new Xyte({ proxy: proxyUrl(`http://alice:secret@127.0.0.1:${proxy.port}`) });
    const res = await xyte.extract({ url: `${target.base}/html`, httpResponseBody: true, httpResponseHeaders: true });
    expect(res.httpResponseHeaders).toContainEqual({ name: 'x-via-proxy', value: '1' });
    expect(proxy.usernames.at(-1)).toBe('alice');
  });

  test('a provider preset encodes geolocation and session in the username', async () => {
    const xyte = new Xyte({
      proxy: oxylabs({ username: 'acme', password: 'secret', host: '127.0.0.1', port: proxy.port }),
    });
    await xyte.extract({ url: `${target.base}/html`, httpResponseBody: true, geolocation: 'gb', session: { id: 'S1' } });
    await xyte.extract({ url: `${target.base}/html`, httpResponseBody: true, geolocation: 'gb', session: { id: 'S1' } });
    const [a, b] = proxy.usernames.slice(-2);
    expect(a).toMatch(/^customer-acme-cc-GB-sessid-\w+-sesstime-10$/);
    expect(b).toBe(a!); // same session → same exit
  });

  test('without a session, every request gets a fresh exit', async () => {
    const xyte = new Xyte({ proxy: oxylabs({ username: 'acme', password: 'secret', host: '127.0.0.1', port: proxy.port }) });
    await xyte.extract({ url: `${target.base}/html`, httpResponseBody: true });
    await xyte.extract({ url: `${target.base}/html`, httpResponseBody: true });
    const [a, b] = proxy.usernames.slice(-2);
    expect(a).not.toBe(b!);
  });

  test('a 407 is retried and ends as a 520 naming the proxy', async () => {
    const xyte = new Xyte({ retries: 1, proxy: proxyUrl(`http://alice:wrong@127.0.0.1:${proxy.port}`) });
    const error = await xyte.extract({ url: `${target.base}/html`, httpResponseBody: true }).catch((e) => e);
    expect(error.status).toBe(520);
    expect(error.detail).toContain('407');
  });

  test('rotate() falls over to the next provider when one is down', async () => {
    const broken = proxyUrl(`http://alice:wrong@127.0.0.1:${proxy.port}`);
    const working = proxyUrl(`http://bob:secret@127.0.0.1:${proxy.port}`);
    const xyte = new Xyte({ proxy: rotate([broken, working]) });
    const res = await xyte.extract({ url: `${target.base}/html`, httpResponseBody: true });
    expect(decodeBody(res.httpResponseBody!)).toContain('hello');
    expect(proxy.usernames.slice(-2)).toEqual(['alice', 'bob']);
  });
});

describe('provider presets', () => {
  test('oxylabs datacenter', async () => {
    const endpoint = await oxylabs({ username: 'acme', password: 'p', type: 'datacenter' }).resolve(ctx({ country: 'US' }));
    expect(endpoint!.url).toStartWith('http://user-acme-country-US:p@dc.oxylabs.io:8000');
  });

  test('bright data', async () => {
    const endpoint = await brightData({ customerId: 'hl_1', zone: 'resi', password: 'p' }).resolve(ctx({ country: 'DE' }));
    expect(userOf(endpoint!.url)).toBe('brd-customer-hl_1-zone-resi-country-de-session-abc123def456');
    expect(endpoint!.url).toEndWith('@brd.superproxy.io:33335');
  });

  test('decodo', async () => {
    const endpoint = await decodo({ username: 'acme', password: 'p' }).resolve(ctx({ country: 'FR' }));
    expect(userOf(endpoint!.url)).toBe('user-acme-country-fr-session-abc123def456-sessionduration-10');
  });

  test('iproyal puts targeting in the password', async () => {
    const endpoint = await iproyal({ username: 'acme', password: 'p' }).resolve(ctx({ country: 'US' }));
    expect(passOf(endpoint!.url)).toBe('p_country-us_session-abc123de_lifetime-10m');
  });

  test('zenrows / scrapingbee / scraperapi proxy modes', async () => {
    const z = await zenrows({ apiKey: 'K' }).resolve(ctx({ country: 'US' }));
    expect(passOf(z!.url)).toMatch(/^premium_proxy=true&proxy_country=us&session_id=\d+$/);
    expect(z!.insecure).toBe(true);

    const s = await scrapingBee({ apiKey: 'K' }).resolve(ctx({ country: 'US' }));
    expect(passOf(s!.url)).toMatch(/^render_js=False&premium_proxy=True&country_code=us&session_id=\d+$/);

    const a = await scraperApi({ apiKey: 'K' }).resolve(ctx({ country: 'US' }));
    expect(userOf(a!.url)).toMatch(/^scraperapi\.country_code=us\.session_number=\d+$/);
    expect(passOf(a!.url)).toBe('K');
  });

  test('byIpType picks by the request ipType', async () => {
    const provider = byIpType({ datacenter: proxyUrl('http://dc:1'), residential: proxyUrl('http://resi:1') });
    expect((await provider.resolve(ctx({ ipType: 'residential' })))!.url).toBe('http://resi:1');
    expect((await provider.resolve(ctx()))!.url).toBe('http://dc:1');
  });
});

describe('proxyFromEnv', () => {
  test('XYTE_PROXY_URL', async () => {
    const provider = proxyFromEnv({ XYTE_PROXY_URL: 'http://a:b@h:1' });
    expect((await provider.resolve(ctx()))!.url).toBe('http://a:b@h:1');
  });

  test('XYTE_PROVIDER list rotates', async () => {
    const provider = proxyFromEnv({ XYTE_PROVIDER: 'oxylabs,zenrows', OXYLABS_USERNAME: 'u', OXYLABS_PASSWORD: 'p', ZENROWS_API_KEY: 'k' });
    expect((await provider.resolve(ctx()))!.url).toContain('pr.oxylabs.io');
    expect((await provider.resolve(ctx({ attempt: 1 })))!.url).toContain('api.zenrows.com');
  });

  test('missing credentials are reported', () => {
    expect(() => proxyFromEnv({ XYTE_PROVIDER: 'oxylabs' })).toThrow('OXYLABS_USERNAME');
  });

  test('nothing set means direct', async () => {
    expect(await proxyFromEnv({}).resolve(ctx())).toBeNull();
  });
});
