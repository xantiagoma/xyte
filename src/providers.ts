/**
 * Long-tail provider presets. Formats come from each provider's docs (linked per preset) as of
 * 2026-10; "verify" marks ones taken from partial or third-party sources. When a preset is off
 * for your account, `template()` takes the exact format from your dashboard.
 */
import { proxyEndpointUrl, type ProxyContext, type ProxyEndpoint, type ProxyProvider } from './proxy.ts';
import { sessionNumber, sessionToken } from './util.ts';

interface Credentials {
  username: string;
  password: string;
  host?: string;
  port?: number;
}

const join = (parts: readonly (string | false | undefined)[], separator: string) =>
  parts.filter(Boolean).join(separator);

function provider(
  name: string,
  defaults: { host: string; port: number },
  options: Credentials,
  credentials: (context: ProxyContext) => { username: string; password: string },
): ProxyProvider {
  return {
    name,
    resolve(context): ProxyEndpoint {
      return {
        url: proxyEndpointUrl({
          host: options.host ?? defaults.host,
          port: options.port ?? defaults.port,
          ...credentials(context),
        }),
      };
    },
  };
}

const lower = (country: string | undefined) => country?.toLowerCase();

// --- Residential networks -------------------------------------------------------------------

/**
 * NodeMaven (https://docs.nodemaven.com): `USER-country-us-sid-…-ttl-10m` on gate.nodemaven.com:8080.
 * `type` picks the pool (`residential` / `mobile`), `filter` the IP quality.
 */
export function nodeMaven(
  options: Credentials & { type?: 'residential' | 'mobile'; filter?: 'low' | 'medium' | 'high'; ttl?: string },
): ProxyProvider {
  return provider('nodemaven', { host: 'gate.nodemaven.com', port: 8080 }, options, ({ country, sessionId }) => ({
    username: join(
      [
        options.username,
        country && `country-${lower(country)}`,
        options.type && `type-${options.type}`,
        options.filter && `filter-${options.filter}`,
        `sid-${sessionToken(sessionId, 12)}`,
        `ttl-${options.ttl ?? '10m'}`,
      ],
      '-',
    ),
    password: options.password,
  }));
}

/** SOAX (https://helpcenter.soax.com): user `package-ID-country-us-sessionid-…-sessionlength-600`, password = package key. */
export function soax(options: { packageId: string; packageKey: string; sessionSeconds?: number; host?: string; port?: number }): ProxyProvider {
  return provider(
    'soax',
    { host: 'proxy.soax.com', port: 5000 },
    { username: '', password: '', host: options.host, port: options.port },
    ({ country, sessionId }) => ({
      username: join(
        [
          `package-${options.packageId}`,
          country && `country-${lower(country)}`,
          `sessionid-${sessionToken(sessionId, 12)}`,
          `sessionlength-${options.sessionSeconds ?? 600}`,
        ],
        '-',
      ),
      password: options.packageKey,
    }),
  );
}

/** NetNut (https://help.netnut.io): `USER-res-us-sid-123456789` on gw.netnut.net:5959. Verify for non-residential plans. */
export function netNut(options: Credentials): ProxyProvider {
  return provider('netnut', { host: 'gw.netnut.net', port: 5959 }, options, ({ country, sessionId }) => ({
    username: `${options.username}-res-${lower(country) ?? 'any'}-sid-${sessionNumber(sessionId, 999_999_999)}`,
    password: options.password,
  }));
}

/**
 * Webshare rotating residential (https://apidocs.webshare.io/proxy-connection):
 * `USER-us-1234` (numeric sticky session) on p.webshare.io:80. `sticky: false` uses `-rotate`
 * (a new IP per request).
 */
export function webshare(options: Credentials & { sticky?: boolean }): ProxyProvider {
  return provider('webshare', { host: 'p.webshare.io', port: 80 }, options, ({ country, sessionId }) => ({
    username: join(
      [options.username, lower(country), options.sticky === false ? 'rotate' : String(sessionNumber(sessionId, 1_000_000))],
      '-',
    ),
    password: options.password,
  }));
}

/** Rayobyte (https://docs.rayobyte.com): targeting in the password, `PASS-country-US-session-…-duration-10`. */
export function rayobyte(options: Credentials & { durationMinutes?: number }): ProxyProvider {
  return provider('rayobyte', { host: 'us-east.gw.rayobyte.com', port: 8000 }, options, ({ country, sessionId }) => ({
    username: options.username,
    password: join(
      [
        options.password,
        country && `country-${country}`,
        `session-${sessionToken(sessionId, 16)}`,
        `duration-${options.durationMinutes ?? 10}`,
      ],
      '-',
    ),
  }));
}

/** PacketStream (https://packetstream.io/docs): password `KEY_country-US_session-…` on proxy.packetstream.io:31112. */
export function packetStream(options: Credentials): ProxyProvider {
  return provider('packetstream', { host: 'proxy.packetstream.io', port: 31112 }, options, ({ country, sessionId }) => ({
    username: options.username,
    password: join([options.password, country && `country-${country}`, `session-${sessionToken(sessionId, 12)}`], '_'),
  }));
}

/** Evomi (https://docs.evomi.com): password `PASS_country-US_session-…_lifetime-30` on rp.evomi.com:1000. */
export function evomi(options: Credentials & { lifetimeMinutes?: number }): ProxyProvider {
  return provider('evomi', { host: 'rp.evomi.com', port: 1000 }, options, ({ country, sessionId }) => ({
    username: options.username,
    password: join(
      [
        options.password,
        country && `country-${country}`,
        `session-${sessionToken(sessionId, 10)}`,
        `lifetime-${options.lifetimeMinutes ?? 30}`,
      ],
      '_',
    ),
  }));
}

/** DataImpulse (https://docs.dataimpulse.com): user `LOGIN__cr.us;sessid.…` on gw.dataimpulse.com:823. */
export function dataImpulse(options: Credentials): ProxyProvider {
  return provider('dataimpulse', { host: 'gw.dataimpulse.com', port: 823 }, options, ({ country, sessionId }) => ({
    username: `${options.username}__${join([country && `cr.${lower(country)}`, `sessid.${sessionToken(sessionId, 12)}`], ';')}`,
    password: options.password,
  }));
}

/** Massive (https://docs.joinmassive.com): `USER-country-US-session-…-sessionttl-15` on network.joinmassive.com:65534. */
export function massive(options: Credentials & { sessionTtlMinutes?: number }): ProxyProvider {
  return provider('massive', { host: 'network.joinmassive.com', port: 65534 }, options, ({ country, sessionId }) => ({
    username: join(
      [
        options.username,
        country && `country-${country}`,
        `session-${sessionToken(sessionId, 16)}`,
        `sessionttl-${options.sessionTtlMinutes ?? 15}`,
      ],
      '-',
    ),
    password: options.password,
  }));
}

/** Proxy-Seller residential (https://docs.proxy-seller.com): `USER_c_US_s_…_ttl_15m` on res.proxy-seller.com:10000. */
export function proxySeller(options: Credentials & { ttl?: string }): ProxyProvider {
  return provider('proxy-seller', { host: 'res.proxy-seller.com', port: 10000 }, options, ({ country, sessionId }) => ({
    username: join([options.username, country && `c_${country}`, `s_${sessionToken(sessionId, 12)}`, `ttl_${options.ttl ?? '15m'}`], '_'),
    password: options.password,
  }));
}

/** Anyip (https://anyip.io/docs): `user_ID,country_US,session_…,sesstime_10` on portal.anyip.io:1080 (verify host). */
export function anyIp(options: Credentials & { sessionMinutes?: number }): ProxyProvider {
  return provider('anyip', { host: 'portal.anyip.io', port: 1080 }, options, ({ country, sessionId }) => ({
    username: join(
      [options.username, country && `country_${country}`, `session_${sessionToken(sessionId, 12)}`, `sesstime_${options.sessionMinutes ?? 10}`],
      ',',
    ),
    password: options.password,
  }));
}

/** Thordata (https://doc.thordata.com): `td-customer-USER-country-us-sessid-…-sesstime-10` on t.pr.thordata.net:9999. */
export function thordata(options: Credentials & { sessionMinutes?: number }): ProxyProvider {
  return provider('thordata', { host: 't.pr.thordata.net', port: 9999 }, options, ({ country, sessionId }) => ({
    username: join(
      [
        options.username.startsWith('td-customer-') ? options.username : `td-customer-${options.username}`,
        country && `country-${lower(country)}`,
        `sessid-${sessionToken(sessionId, 12)}`,
        `sesstime-${options.sessionMinutes ?? 10}`,
      ],
      '-',
    ),
    password: options.password,
  }));
}

/** ABCProxy (https://docs.abcproxy.com): `ACCOUNT-zone-abc-region-us-session-…-sessTime-10` on proxy.abcproxy.com:4950. Verify. */
export function abcProxy(options: Credentials & { sessionMinutes?: number }): ProxyProvider {
  return provider('abcproxy', { host: 'proxy.abcproxy.com', port: 4950 }, options, ({ country, sessionId }) => ({
    username: join(
      [
        options.username.includes('-zone-') ? options.username : `${options.username}-zone-abc`,
        country && `region-${lower(country)}`,
        `session-${sessionToken(sessionId, 12)}`,
        `sessTime-${options.sessionMinutes ?? 10}`,
      ],
      '-',
    ),
    password: options.password,
  }));
}

/** 922 S5 Proxy (https://doc.922proxy.com): `USER-region-FR-sessid-…-sessTime-10`; the host is per account. Verify. */
export function proxy922(options: Credentials & { host: string; port: number; sessionMinutes?: number }): ProxyProvider {
  return provider('922s5', { host: options.host, port: options.port }, options, ({ country, sessionId }) => ({
    username: join(
      [options.username, country && `region-${country}`, `sessid-${sessionToken(sessionId, 12)}`, `sessTime-${options.sessionMinutes ?? 10}`],
      '-',
    ),
    password: options.password,
  }));
}

/** LunaProxy (https://www.lunaproxy.com/help): `user-SUB-region-us-sessid-…-sesstime-10`; the host is per account. Verify. */
export function lunaProxy(options: Credentials & { host: string; port: number; sessionMinutes?: number }): ProxyProvider {
  return provider('lunaproxy', { host: options.host, port: options.port }, options, ({ country, sessionId }) => ({
    username: join(
      [
        options.username.startsWith('user-') ? options.username : `user-${options.username}`,
        country && `region-${lower(country)}`,
        `sessid-${sessionToken(sessionId, 12)}`,
        `sesstime-${options.sessionMinutes ?? 10}`,
      ],
      '-',
    ),
    password: options.password,
  }));
}

/** ProxyEmpire: `USER-country-us-sid-…` on v2.proxyempire.io:5000 (session lifetime is set in the dashboard). Verify. */
export function proxyEmpire(options: Credentials): ProxyProvider {
  return provider('proxyempire', { host: 'v2.proxyempire.io', port: 5000 }, options, ({ country, sessionId }) => ({
    username: join([options.username, country && `country-${lower(country)}`, `sid-${sessionToken(sessionId, 12)}`], '-'),
    password: options.password,
  }));
}

/** RapidProxy: `USER-residential-US-session-12345678-stime-10` on eu.rapidproxy.io:5001. From an API example; verify. */
export function rapidProxy(options: Credentials & { stimeMinutes?: number }): ProxyProvider {
  return provider('rapidproxy', { host: 'eu.rapidproxy.io', port: 5001 }, options, ({ country, sessionId }) => ({
    username: join(
      [
        options.username,
        'residential',
        country,
        `session-${sessionNumber(sessionId, 99_999_999)}`,
        `stime-${options.stimeMinutes ?? 10}`,
      ],
      '-',
    ),
    password: options.password,
  }));
}

/**
 * Swiftproxy: `USER_custom_zone_US` on us.swiftproxy.net:7878. Sticky sessions are configured in
 * their dashboard's endpoint generator (no documented username syntax), so every request rotates
 * unless you use a sticky endpoint from there with `proxyUrl()`.
 */
export function swiftProxy(options: Credentials): ProxyProvider {
  return provider('swiftproxy', { host: 'us.swiftproxy.net', port: 7878 }, options, ({ country }) => ({
    username: country ? `${options.username}_custom_zone_${country}` : options.username,
    password: options.password,
  }));
}

// --- Scraping APIs in proxy mode (TLS is re-signed: insecure) ---------------------------------

/** Crawlbase Smart Proxy (https://crawlbase.com/docs/smart-proxy/): token as user; params as `CrawlbaseAPI-*` headers. */
export function crawlbase(options: { token: string; javascript?: boolean }): ProxyProvider {
  return {
    name: 'crawlbase',
    resolve({ country, sessionId }) {
      const headers: Record<string, string> = { 'CrawlbaseAPI-Session-Id': sessionToken(sessionId, 16) };
      if (country) headers['CrawlbaseAPI-Country'] = country;
      if (options.javascript) headers['CrawlbaseAPI-Parameters'] = 'javascript=true';
      return { url: `http://${encodeURIComponent(options.token)}:@smartproxy.crawlbase.com:8012`, insecure: true, headers };
    },
  };
}

/** Scrape.do proxy mode (https://scrape.do/documentation/proxy-mode/): token as user, API params as the password. */
export function scrapeDo(options: { token: string; render?: boolean; super?: boolean; params?: Record<string, string> }): ProxyProvider {
  return {
    name: 'scrape.do',
    resolve({ country, sessionId }) {
      const params = new URLSearchParams(options.params);
      if (options.render) params.set('render', 'true');
      if (options.super) params.set('super', 'true');
      if (country) params.set('geoCode', lower(country)!);
      params.set('sessionId', String(sessionNumber(sessionId, 1_000_000)));
      return {
        url: `http://${encodeURIComponent(options.token)}:${encodeURIComponent(params.toString())}@proxy.scrape.do:8080`,
        insecure: true,
      };
    },
  };
}

/** ScrapingAnt proxy mode (https://docs.scrapingant.com/proxy-mode): user `scrapingant&browser=false&…`, API key as password. Verify country. */
export function scrapingAnt(options: { apiKey: string; browser?: boolean; params?: Record<string, string> }): ProxyProvider {
  return {
    name: 'scrapingant',
    resolve({ country }) {
      const params = new URLSearchParams({ browser: String(options.browser ?? false), ...options.params });
      if (country) params.set('proxy_country', country);
      return {
        url: `http://${encodeURIComponent(`scrapingant&${params.toString()}`)}:${encodeURIComponent(options.apiKey)}@proxy.scrapingant.com:8080`,
        insecure: true,
      };
    },
  };
}

/** ScrapeOps proxy aggregator (https://scrapeops.io/docs/proxy-aggregator/): user `scrapeops.country=us`, API key as password. Verify. */
export function scrapeOps(options: { apiKey: string; renderJs?: boolean; params?: Record<string, string> }): ProxyProvider {
  return {
    name: 'scrapeops',
    resolve({ country }) {
      const params: Record<string, string> = { ...options.params };
      if (country) params.country = lower(country)!;
      if (options.renderJs) params.render_js = 'true';
      const username = ['scrapeops', ...Object.entries(params).map(([k, v]) => `${k}=${v}`)].join('.');
      return {
        url: `http://${encodeURIComponent(username)}:${encodeURIComponent(options.apiKey)}@proxy.scrapeops.io:5353`,
        insecure: true,
      };
    },
  };
}

/** Scrapfly proxy mode (https://scrapfly.io/docs/scrape-api/proxy-mode): dash-separated options as user, API key as password. Verify. */
export function scrapfly(options: { apiKey: string; renderJs?: boolean; asp?: boolean }): ProxyProvider {
  return {
    name: 'scrapfly',
    resolve({ country, sessionId }) {
      const username = join(
        [
          'scrapfly',
          country && `country-${lower(country)}`,
          `session-${sessionToken(sessionId, 12)}`,
          `renderJs-${options.renderJs ? 'true' : 'false'}`,
          options.asp && 'asp-true',
        ],
        '-',
      );
      return {
        url: `http://${encodeURIComponent(username)}:${encodeURIComponent(options.apiKey)}@proxy.scrapfly.io:7777`,
        insecure: true,
      };
    },
  };
}

/**
 * Zyte API itself, in proxy mode (https://docs.zyte.com/zyte-api/usage/proxy-mode.html), e.g. as
 * the last provider in `rotate()`: API key as user, `Zyte-Geolocation` / `Zyte-Session-ID` headers.
 */
export function zyteProxy(options: { apiKey: string }): ProxyProvider {
  return {
    name: 'zyte',
    resolve({ country, sessionId }) {
      const headers: Record<string, string> = { 'Zyte-Session-ID': uuidV4From(sessionId) };
      if (country) headers['Zyte-Geolocation'] = country;
      return { url: `http://${encodeURIComponent(options.apiKey)}:@api.zyte.com:8011`, insecure: true, headers };
    },
  };
}

/** Oxylabs Web Unblocker (https://developers.oxylabs.io): unblock.oxylabs.io:60000, params as `x-oxylabs-*` headers. */
export function oxylabsUnblocker(options: { username: string; password: string; render?: boolean }): ProxyProvider {
  return {
    name: 'oxylabs-unblocker',
    resolve({ country, sessionId }) {
      const headers: Record<string, string> = { 'x-oxylabs-session-id': sessionToken(sessionId, 16) };
      if (country) headers['x-oxylabs-geo-location'] = countryName(country);
      if (options.render) headers['x-oxylabs-render'] = 'html';
      return {
        url: proxyEndpointUrl({ host: 'unblock.oxylabs.io', port: 60000, username: options.username, password: options.password }),
        insecure: true,
        headers,
      };
    },
  };
}

/** "US" → "United States" (Oxylabs takes country names). */
function countryName(code: string): string {
  try {
    return new Intl.DisplayNames(['en'], { type: 'region' }).of(code) ?? code;
  } catch {
    return code;
  }
}

/** Zyte requires session ids to be v4 UUIDs; derive one deterministically from any session id. */
function uuidV4From(sessionId: string): string {
  const hex = /^[0-9a-f]{32}$/i.test(sessionId)
    ? sessionId.toLowerCase()
    : Array.from({ length: 4 }, (_, i) => sessionNumber(`${sessionId}#${i}`, 0xffffffff).toString(16).padStart(8, '0')).join('');
  const chars = hex.split('');
  chars[12] = '4';
  chars[16] = '89ab'[parseInt(chars[16]!, 16) % 4]!;
  const h = chars.join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
