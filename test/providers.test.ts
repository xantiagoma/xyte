import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import {
  abcProxy,
  anyIp,
  brightDataBrowser,
  browserless,
  crawlbase,
  custom,
  dataImpulse,
  decodeBody,
  evomi,
  massive,
  netNut,
  nodeMaven,
  oxylabsBrowser,
  oxylabsUnblocker,
  packetStream,
  PROVIDER_NAMES,
  proxyFromEnv,
  proxySeller,
  rapidProxy,
  rayobyte,
  scrapeDo,
  scrapeOps,
  scrapfly,
  soax,
  swiftProxy,
  thordata,
  webshare,
  Xyte,
  zenrowsBrowser,
  zyteProxy,
  type ProxyContext,
  type ProxyEndpoint,
  type ProxyProvider,
} from '../src/index.ts';
import { startProxy, startTarget } from './fixtures.ts';

const ctx = (overrides: Partial<ProxyContext> = {}): ProxyContext => ({
  url: new URL('https://example.com/'),
  sessionId: 'abc123def456ghi789jkl',
  attempt: 0,
  browser: false,
  country: 'US',
  ...overrides,
});

const parts = async (provider: ProxyProvider<ProxyEndpoint>, overrides?: Partial<ProxyContext>) => {
  const endpoint = (await provider.resolve(ctx(overrides)))!;
  const url = new URL(endpoint.url);
  return {
    host: url.host,
    user: decodeURIComponent(url.username),
    pass: decodeURIComponent(url.password),
    insecure: endpoint.insecure,
    headers: endpoint.headers,
  };
};

const up = { username: 'acme', password: 'pw' };

describe('residential presets', () => {
  test.each([
    ['nodemaven', nodeMaven(up), 'gate.nodemaven.com:8080', 'acme-country-us-sid-abc123def456-ttl-10m', 'pw'],
    ['netnut', netNut(up), 'gw.netnut.net:5959', /^acme-res-us-sid-\d+$/, 'pw'],
    ['webshare', webshare(up), 'p.webshare.io', /^acme-us-\d+$/, 'pw'],
    ['rayobyte', rayobyte(up), 'us-east.gw.rayobyte.com:8000', 'acme', 'pw-country-US-session-abc123def456ghi7-duration-10'],
    ['packetstream', packetStream(up), 'proxy.packetstream.io:31112', 'acme', 'pw_country-US_session-abc123def456'],
    ['evomi', evomi(up), 'rp.evomi.com:1000', 'acme', 'pw_country-US_session-abc123def4_lifetime-30'],
    ['dataimpulse', dataImpulse(up), 'gw.dataimpulse.com:823', 'acme__cr.us;sessid.abc123def456', 'pw'],
    ['massive', massive(up), 'network.joinmassive.com:65534', 'acme-country-US-session-abc123def456ghi7-sessionttl-15', 'pw'],
    ['proxy-seller', proxySeller(up), 'res.proxy-seller.com:10000', 'acme_c_US_s_abc123def456_ttl_15m', 'pw'],
    ['anyip', anyIp(up), 'portal.anyip.io:1080', 'acme,country_US,session_abc123def456,sesstime_10', 'pw'],
    ['thordata', thordata(up), 't.pr.thordata.net:9999', 'td-customer-acme-country-us-sessid-abc123def456-sesstime-10', 'pw'],
    ['abcproxy', abcProxy(up), 'proxy.abcproxy.com:4950', 'acme-zone-abc-region-us-session-abc123def456-sessTime-10', 'pw'],
    ['rapidproxy', rapidProxy(up), 'eu.rapidproxy.io:5001', /^acme-residential-US-session-\d+-stime-10$/, 'pw'],
    ['swiftproxy', swiftProxy(up), 'us.swiftproxy.net:7878', 'acme_custom_zone_US', 'pw'],
  ] as const)('%s', async (_, provider, host, user, pass) => {
    const p = await parts(provider);
    expect(p.host).toBe(host);
    if (typeof user === 'string') expect(p.user).toBe(user);
    else expect(p.user).toMatch(user);
    expect(p.pass).toBe(pass);
  });

  test('soax: package id in the user, package key as password', async () => {
    const p = await parts(soax({ packageId: '123', packageKey: 'KEY' }));
    expect(p).toMatchObject({ host: 'proxy.soax.com:5000', user: 'package-123-country-us-sessionid-abc123def456-sessionlength-600', pass: 'KEY' });
  });

  test('no geolocation drops the country part', async () => {
    expect((await parts(nodeMaven(up), { country: undefined })).user).toBe('acme-sid-abc123def456-ttl-10m');
    expect((await parts(netNut(up), { country: undefined })).user).toMatch(/^acme-res-any-sid-\d+$/);
    expect((await parts(swiftProxy(up), { country: undefined })).user).toBe('acme');
  });

  test('webshare sticky: false rotates', async () => {
    expect((await parts(webshare({ ...up, sticky: false }))).user).toBe('acme-us-rotate');
  });
});

describe('scraping APIs in proxy mode', () => {
  test('crawlbase: token as user, params as headers', async () => {
    const p = await parts(crawlbase({ token: 'T', javascript: true }));
    expect(p).toMatchObject({ host: 'smartproxy.crawlbase.com:8012', user: 'T', insecure: true });
    expect(p.headers).toMatchObject({ 'CrawlbaseAPI-Country': 'US', 'CrawlbaseAPI-Parameters': 'javascript=true' });
  });

  test('scrape.do: params as the password', async () => {
    const p = await parts(scrapeDo({ token: 'T', render: true }));
    expect(p.host).toBe('proxy.scrape.do:8080');
    expect(p.pass).toMatch(/^render=true&geoCode=us&sessionId=\d+$/);
  });

  test('scrapeops and scrapfly', async () => {
    expect((await parts(scrapeOps({ apiKey: 'K' }))).user).toBe('scrapeops.country=us');
    expect((await parts(scrapfly({ apiKey: 'K' }))).user).toBe('scrapfly-country-us-session-abc123def456-renderJs-false');
  });

  test('zyte proxy mode: v4 UUID session header', async () => {
    const p = await parts(zyteProxy({ apiKey: 'K' }));
    expect(p).toMatchObject({ host: 'api.zyte.com:8011', user: 'K', insecure: true });
    expect(p.headers!['Zyte-Geolocation']).toBe('US');
    expect(p.headers!['Zyte-Session-ID']).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    const again = await parts(zyteProxy({ apiKey: 'K' }));
    expect(again.headers!['Zyte-Session-ID']).toBe(p.headers!['Zyte-Session-ID']!);
  });

  test('oxylabs web unblocker: country name header', async () => {
    const p = await parts(oxylabsUnblocker(up), { country: 'DE' });
    expect(p.host).toBe('unblock.oxylabs.io:60000');
    expect(p.headers!['x-oxylabs-geo-location']).toBe('Germany');
  });
});

describe('proxy headers reach the target', () => {
  let target: ReturnType<typeof startTarget>;
  let proxy: Awaited<ReturnType<typeof startProxy>>;
  beforeAll(async () => {
    target = startTarget();
    proxy = await startProxy();
  });
  afterAll(async () => {
    target.stop();
    await proxy.stop();
  });

  test('HTTP engine sends ProxyEndpoint.headers on every request', async () => {
    const xyte = new Xyte({
      proxy: custom('headers', ({ country }) => ({
        url: `http://k:@127.0.0.1:${proxy.port}`,
        headers: { 'X-Api-Country': country ?? 'none' },
      })),
    });
    const res = await xyte.extract({ url: `${target.base}/echo`, httpResponseBody: true, geolocation: 'fr' });
    expect(JSON.parse(decodeBody(res.httpResponseBody!)).headers['x-api-country']).toBe('FR');
  });
});

describe('remote browser presets', () => {
  test('bright data scraping browser', async () => {
    const url = await brightDataBrowser({ customerId: 'hl_1', zone: 'sb', password: 'p' })(ctx());
    expect(url).toBe('wss://brd-customer-hl_1-zone-sb-country-us:p@brd.superproxy.io:9222');
  });

  test('browserless adds residential proxy params only with a country', async () => {
    expect(await browserless({ token: 'T' })(ctx())).toBe(
      'wss://production-sfo.browserless.io/?token=T&proxy=residential&proxySticky=true&proxyCountry=us',
    );
    expect(await browserless({ token: 'T' })(ctx({ country: undefined }))).toBe('wss://production-sfo.browserless.io/?token=T');
  });

  test('zenrows and oxylabs', async () => {
    expect(await zenrowsBrowser({ apiKey: 'K' })(ctx())).toBe('wss://browser.zenrows.com/?apikey=K&proxy_country=us');
    expect(await oxylabsBrowser({ username: 'u', password: 'p' })(ctx())).toBe('wss://u:p@ubc.oxylabs.io/?p_cc=US');
  });
});

describe('env names', () => {
  test('every preset is reachable from XYTE_PROVIDER', () => {
    for (const name of ['nodemaven', 'soax', 'netnut', 'webshare', 'evomi', 'massive', 'crawlbase', 'zyte', 'oxylabs-unblocker']) {
      expect(PROVIDER_NAMES).toContain(name);
    }
  });

  test('NAME_USERNAME / NAME_PASSWORD / NAME_HOST', async () => {
    const provider = proxyFromEnv({
      XYTE_PROVIDER: 'evomi',
      EVOMI_USERNAME: 'u',
      EVOMI_PASSWORD: 'p',
      EVOMI_HOST: 'custom.evomi.com',
      EVOMI_PORT: '2000',
    });
    const { url } = (await provider.resolve(ctx())) as ProxyEndpoint;
    expect(url).toStartWith('http://u:p_country-US_session-');
    expect(url).toEndWith('@custom.evomi.com:2000');
  });
});
