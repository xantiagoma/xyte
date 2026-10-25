import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import {
  brightData,
  byIpType,
  custom,
  decodo,
  decodeBody,
  iproyal,
  oxylabs,
  proxyFromEnv,
  proxyUrl,
  rotate,
  route,
  scraperApi,
  scrapingBee,
  template,
  browserFromEnv,
  Xyte,
  zenrows,
  type ProxyContext,
} from '../src/index.ts';
import { startProxy, startTarget } from './fixtures.ts';
import { sessionToken } from '../src/util.ts';
const T8 = sessionToken('abc123def456ghi', 8);
const T10 = sessionToken('abc123def456ghi', 10);
const T12 = sessionToken('abc123def456ghi', 12);
const T16 = sessionToken('abc123def456ghi', 16);

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

/** proxyFromEnv may also return API adapters; these tests expect proxies. */
const urlOf = (endpoint: unknown) => (endpoint as { url: string }).url;
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

  test('ScrapingBee: final url, hidden bookkeeping headers, its own errors retried', async () => {
    // The real preset's endpoint, pointed at the local proxy.
    const bee = await scrapingBee({ apiKey: 'K' }).resolve(ctx({}));
    const provider = custom('bee', () => ({ ...bee!, url: `http://bob:secret@127.0.0.1:${proxy.port}`, insecure: false }));
    const xyte = new Xyte({ retries: 1, proxy: provider });

    const ok = await xyte.extract({ url: `${target.base}/spb-ok`, httpResponseBody: true, httpResponseHeaders: true });
    expect(ok.url).toBe(`${target.base}/landing`);
    const names = ok.httpResponseHeaders!.map((h) => h.name.toLowerCase());
    expect(names).toContain('x-real');
    expect(names).not.toContain('spb-cost');
    expect(names).not.toContain('resolved-url');

    const before = target.hits.get('/spb-error') ?? 0;
    const error = await xyte.extract({ url: `${target.base}/spb-error`, httpResponseBody: true }).catch((e) => e);
    expect(error.status).toBe(520);
    expect(error.detail).toContain('ScrapingBee could not fetch the page');
    expect((target.hits.get('/spb-error') ?? 0) - before).toBe(2);
  });

  test('geolocation warns only when the exit ignores it, once per request', async () => {
    const warningsFor = async (provider: Parameters<typeof rotate>[0][number] | undefined, request: Partial<Parameters<Xyte['extract']>[0]> = {}) => {
      const warnings: string[] = [];
      const xyte = new Xyte({ proxy: provider, retries: 1, onWarning: (message) => warnings.push(message) });
      await xyte.extract({ url: `${target.base}/html`, httpResponseBody: true, geolocation: 'US', ...request }).catch(() => {});
      return warnings;
    };
    const local = `127.0.0.1:${proxy.port}`;
    expect(await warningsFor(undefined)).toEqual([expect.stringContaining('exit directly from this machine')]);
    expect(await warningsFor(proxyUrl(`http://bob:secret@${local}`))).toEqual([expect.stringContaining('no country parameter')]);
    expect(await warningsFor(template(`http://bob:secret@${local}`))).toHaveLength(1);
    expect(await warningsFor(template(`http://bob[-{country}]:secret@${local}`))).toEqual([]);
    expect(await warningsFor(oxylabs({ username: 'acme', password: 'secret', host: '127.0.0.1', port: proxy.port }))).toEqual([]);
    expect(await warningsFor(undefined, { geolocation: undefined })).toEqual([]);
    // Retried twice (a 403 each time), still one warning.
    expect(await warningsFor(undefined, { url: `${target.base}/forbidden` })).toHaveLength(1);
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

describe('route()', () => {
  const a = proxyUrl('http://a:p@a.example:1');
  const b = proxyUrl('http://b:p@b.example:1');
  const c = proxyUrl('http://c:p@c.example:1');
  const routed = route({ 'doordash.com': a, 'api.doordash.com': b }, c);
  const exit = async (url: string, attempt = 0) => new URL(urlOf(await routed.resolve(ctx({ url: new URL(url), attempt })))).hostname;

  test('matches the host and its subdomains, the longest key first, else the fallback', async () => {
    expect(await exit('https://doordash.com/x')).toBe('a.example');
    expect(await exit('https://www.doordash.com/x')).toBe('a.example');
    expect(await exit('https://api.doordash.com/x')).toBe('b.example');
    expect(await exit('https://notdoordash.com/x')).toBe('c.example');
    expect(await exit('https://wolt.com/', 3)).toBe('c.example');
  });

  test('retries stay on the route; rotate() inside a route gives it a fallback', async () => {
    const withFallback = route({ 'doordash.com': rotate([a, b]) }, c);
    const at = async (attempt: number) =>
      new URL(urlOf(await withFallback.resolve(ctx({ url: new URL('https://www.doordash.com/'), attempt })))).hostname;
    expect([await at(0), await at(1), await at(2)]).toEqual(['a.example', 'b.example', 'a.example']);
  });

  test('XYTE_ROUTES, with XYTE_PROVIDER as the fallback and + for a chain', async () => {
    const provider = proxyFromEnv({
      XYTE_ROUTES: 'doordash.com=oxylabs+zenrows, wolt.com=direct',
      XYTE_PROVIDER: 'zenrows',
      OXYLABS_USERNAME: 'u',
      OXYLABS_PASSWORD: 'p',
      ZENROWS_API_KEY: 'k',
    });
    const resolveFor = (url: string, attempt = 0) => provider.resolve(ctx({ url: new URL(url), attempt }));
    expect(await resolveFor('https://wolt.com/')).toBeNull();
    expect(urlOf(await resolveFor('https://www.doordash.com/'))).toContain('oxylabs.io');
    expect(urlOf(await resolveFor('https://www.doordash.com/', 1))).toContain('zenrows.com');
    expect(urlOf(await resolveFor('https://example.com/'))).toContain('zenrows.com');
    expect(() => proxyFromEnv({ XYTE_ROUTES: 'doordash.com' })).toThrow(/host=provider/);
  });
});

describe('provider presets', () => {
  test('oxylabs datacenter', async () => {
    const endpoint = await oxylabs({ username: 'acme', password: 'p', type: 'datacenter' }).resolve(ctx({ country: 'US' }));
    expect(endpoint!.url).toStartWith('http://user-acme-country-US:p@dc.oxylabs.io:8000');
  });

  test('bright data', async () => {
    const endpoint = await brightData({ customerId: 'hl_1', zone: 'resi', password: 'p' }).resolve(ctx({ country: 'DE' }));
    expect(userOf(endpoint!.url)).toBe(`brd-customer-hl_1-zone-resi-country-de-session-${T12}`);
    expect(endpoint!.url).toEndWith('@brd.superproxy.io:33335');
  });

  test('decodo', async () => {
    const endpoint = await decodo({ username: 'acme', password: 'p' }).resolve(ctx({ country: 'FR' }));
    expect(userOf(endpoint!.url)).toBe(`user-acme-country-fr-session-${T12}-sessionduration-10`);
  });

  test('iproyal puts targeting in the password', async () => {
    const endpoint = await iproyal({ username: 'acme', password: 'p' }).resolve(ctx({ country: 'US' }));
    expect(passOf(endpoint!.url)).toBe(`p_country-us_session-${T8}_lifetime-10m`);
  });

  test('zenrows / scrapingbee / scraperapi proxy modes', async () => {
    const z = await zenrows({ apiKey: 'K' }).resolve(ctx({ country: 'US' }));
    expect(passOf(z!.url)).toMatch(/^premium_proxy=true&proxy_country=us&session_id=\d+$/);
    expect(z!.insecure).toBe(true);

    const s = await scrapingBee({ apiKey: 'K' }).resolve(ctx({ country: 'US' }));
    expect(passOf(s!.url)).toMatch(/^render_js=False&forward_headers_pure=True&premium_proxy=True&country_code=us&session_id=\d+$/);

    const a = await scraperApi({ apiKey: 'K' }).resolve(ctx({ country: 'US' }));
    expect(userOf(a!.url)).toMatch(/^scraperapi\.country_code=us\.session_number=\d+$/);
    expect(passOf(a!.url)).toBe('K');
  });

  test('byIpType picks by the request ipType', async () => {
    const provider = byIpType({ datacenter: proxyUrl('http://dc:1'), residential: proxyUrl('http://resi:1') });
    expect((await provider.resolve(ctx({ ipType: 'residential' })))!.url).toBe('http://resi:1');
    expect(urlOf(await provider.resolve(ctx()))).toBe('http://dc:1');
  });
});

describe('proxyFromEnv', () => {
  test('XYTE_PROXY_URL', async () => {
    const provider = proxyFromEnv({ XYTE_PROXY_URL: 'http://a:b@h:1' });
    expect(urlOf(await provider.resolve(ctx()))).toBe('http://a:b@h:1');
  });

  test('XYTE_PROVIDER list rotates', async () => {
    const provider = proxyFromEnv({ XYTE_PROVIDER: 'oxylabs,zenrows', OXYLABS_USERNAME: 'u', OXYLABS_PASSWORD: 'p', ZENROWS_API_KEY: 'k' });
    expect(urlOf(await provider.resolve(ctx()))).toContain('pr.oxylabs.io');
    expect(urlOf(await provider.resolve(ctx({ attempt: 1 })))).toContain('api.zenrows.com');
  });

  test('missing credentials are reported', () => {
    expect(() => proxyFromEnv({ XYTE_PROVIDER: 'oxylabs' })).toThrow('OXYLABS_USERNAME');
  });

  test('nothing set means direct', async () => {
    expect(await proxyFromEnv({}).resolve(ctx())).toBeNull();
  });
});

describe('template()', () => {
  test('fills placeholders and URL-encodes values', async () => {
    process.env.XYTE_TEST_PASS = 'p@ss:word';
    const provider = template('http://user-acme-country-{country:lower}-session-{session:8}:{env:XYTE_TEST_PASS}@gate.example.com:7000');
    const { url } = (await provider.resolve(ctx({ country: 'US' })))!;
    expect(url).toBe(`http://user-acme-country-us-session-${T8}:p%40ss%3Aword@gate.example.com:7000`);
    expect(decodeURIComponent(new URL(url).password)).toBe('p@ss:word');
  });

  test('drops optional [parts] whose placeholders have no value', async () => {
    const provider = template('http://acme[-cc-{country}]-sid-{session:number:9999}:pw@h:1');
    expect(urlOf(await provider.resolve(ctx()))).toMatch(/^http:\/\/acme-sid-\d{1,4}:pw@h:1$/);
    expect((await provider.resolve(ctx({ country: 'GB' })))!.url).toMatch(/^http:\/\/acme-cc-GB-sid-\d+:pw@h:1$/);
  });

  test('a required placeholder without value is an error', () => {
    expect(() => template('http://acme-{country}:pw@h:1').resolve(ctx())).toThrow('required placeholder');
  });

  test('works through XYTE_PROXY_TEMPLATE', async () => {
    const provider = proxyFromEnv({ XYTE_PROXY_TEMPLATE: 'http://u[-{country:lower}]:p@h:1' });
    expect(urlOf(await provider.resolve(ctx({ country: 'DE' })))).toBe('http://u-de:p@h:1');
  });
});

describe('browserFromEnv', () => {
  test('maps variables to browser options', async () => {
    const options = browserFromEnv({
      XYTE_BROWSER: 'patchright',
      XYTE_BROWSER_CHANNEL: 'chrome',
      XYTE_BROWSER_ARGS: '--a, --b',
      XYTE_BLOCK_RESOURCES: 'image,font',
      XYTE_BROWSER_WS: 'wss://browser.example.com?country={country:lower}&session={session}',
    });
    expect(options.launchOptions).toEqual({ channel: 'chrome', args: ['--a', '--b'] });
    expect(options.blockResources).toEqual(['image', 'font']);
    const remote = await options.connect!(ctx({ country: 'FR' }));
    expect(remote).toEqual({ endpoint: `wss://browser.example.com?country=fr&session=${T12}`, protocol: 'cdp' });
    const browserType = await (options.browserType as () => Promise<unknown>)();
    expect(typeof (browserType as { launch: unknown }).launch).toBe('function');
  });

  test('empty env means defaults', () => {
    expect(browserFromEnv({})).toEqual({});
  });
});

