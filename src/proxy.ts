import { sessionNumber, sessionToken } from './util.ts';

/** What a provider gets to pick an exit for one attempt of one request. */
export interface ProxyContext {
  /** Target URL. */
  url: URL;
  /** ISO 3166-1 alpha-2, upper case, from the request's `geolocation`. */
  country?: string;
  /** From the request's `ipType`. */
  ipType?: 'datacenter' | 'residential';
  /**
   * Sticky-session key: the request's `session.id`, or a fresh id per attempt. Providers map it
   * to their session parameter so every hop of one attempt (redirects, browser sub-requests)
   * leaves from one IP, and a retry leaves from another.
   */
  sessionId: string;
  /** 0 for the first try, then 1, 2… */
  attempt: number;
  /** The attempt renders in a browser (every page sub-request goes through the proxy). */
  browser: boolean;
}

export interface ProxyEndpoint {
  /** `http://user:pass@host:port` (or `https://`). */
  url: string;
  /**
   * Skip TLS verification of the target. Scraping APIs in proxy mode (ZenRows, ScrapingBee,
   * ScraperAPI) re-sign traffic with their own certificate, so it is required for them.
   */
  insecure?: boolean;
}

export interface ProxyProvider {
  readonly name: string;
  /** The proxy for this attempt, or null to connect directly. */
  resolve(context: ProxyContext): ProxyEndpoint | null | Promise<ProxyEndpoint | null>;
}

const encode = encodeURIComponent;

export function proxyEndpointUrl(args: {
  host: string;
  port: number | string;
  username?: string;
  password?: string;
  protocol?: 'http' | 'https';
}): string {
  const auth =
    args.username != null
      ? `${encode(args.username)}${args.password != null ? `:${encode(args.password)}` : ''}@`
      : '';
  return `${args.protocol ?? 'http'}://${auth}${args.host}:${args.port}`;
}

/** No proxy: requests go straight from this machine. */
export function direct(): ProxyProvider {
  return { name: 'direct', resolve: () => null };
}

/**
 * Any proxy (or list of proxies) given as URLs. With several, attempts rotate through them, so a
 * retry uses the next one. For providers that encode geo/session in the URL, use `custom`.
 */
export function proxyUrl(urls: string | readonly string[], options: { insecure?: boolean } = {}): ProxyProvider {
  const list = typeof urls === 'string' ? [urls] : [...urls];
  if (list.length === 0) throw new Error('proxyUrl: at least one URL is required');
  return {
    name: 'proxy',
    resolve: ({ attempt, sessionId }) => ({
      url: list[(sessionNumber(sessionId, 1 << 30) + attempt) % list.length]!,
      insecure: options.insecure,
    }),
  };
}

/** Build the proxy URL yourself from the context. */
export function custom(
  name: string,
  resolve: (context: ProxyContext) => string | ProxyEndpoint | null | Promise<string | ProxyEndpoint | null>,
): ProxyProvider {
  return {
    name,
    async resolve(context) {
      const result = await resolve(context);
      return typeof result === 'string' ? { url: result } : result;
    },
  };
}

/** Uses `datacenter` or `residential` per the request's `ipType`. */
export function byIpType(providers: {
  datacenter?: ProxyProvider;
  residential?: ProxyProvider;
  /** When the request sets no `ipType`. Default: `datacenter` if given, else `residential`. */
  default?: 'datacenter' | 'residential';
}): ProxyProvider {
  const fallback = providers.default ?? (providers.datacenter ? 'datacenter' : 'residential');
  return {
    name: 'byIpType',
    resolve(context) {
      const type = context.ipType ?? fallback;
      const provider = providers[type] ?? providers[type === 'datacenter' ? 'residential' : 'datacenter'];
      if (!provider) throw new Error('byIpType: no provider configured');
      return provider.resolve({ ...context, ipType: type });
    },
  };
}

/**
 * Tries providers in order across attempts: attempt 0 → first, attempt 1 → second… and wraps.
 * A provider outage (e.g. a 407 on every request) then costs one attempt, not the request.
 */
export function rotate(providers: readonly ProxyProvider[]): ProxyProvider {
  if (providers.length === 0) throw new Error('rotate: at least one provider is required');
  return {
    name: `rotate(${providers.map((p) => p.name).join(',')})`,
    resolve: (context) => providers[context.attempt % providers.length]!.resolve(context),
  };
}

// --- Residential / datacenter proxy networks -------------------------------------------------

/**
 * Oxylabs (https://developers.oxylabs.io/proxies/residential-proxies).
 * Residential: `customer-USER-cc-US-sessid-…-sesstime-10` on pr.oxylabs.io:7777.
 * Datacenter: `user-USER-country-US` on dc.oxylabs.io:8000.
 */
export function oxylabs(options: {
  username: string;
  password: string;
  type?: 'residential' | 'datacenter';
  host?: string;
  port?: number;
  /** Sticky session lifetime, minutes (residential, max 1440). Default 10. */
  sessionMinutes?: number;
}): ProxyProvider {
  const type = options.type ?? 'residential';
  return {
    name: `oxylabs-${type}`,
    resolve({ country, sessionId }) {
      if (type === 'datacenter') {
        const username = `${prefixed(options.username, 'user-')}${country ? `-country-${country}` : ''}`;
        return {
          url: proxyEndpointUrl({
            host: options.host ?? 'dc.oxylabs.io',
            port: options.port ?? 8000,
            username,
            password: options.password,
          }),
        };
      }
      const username = [
        prefixed(options.username, 'customer-'),
        country && `cc-${country}`,
        `sessid-${sessionToken(sessionId, 10)}`,
        `sesstime-${options.sessionMinutes ?? 10}`,
      ]
        .filter(Boolean)
        .join('-');
      return {
        url: proxyEndpointUrl({
          host: options.host ?? 'pr.oxylabs.io',
          port: options.port ?? 7777,
          username,
          password: options.password,
        }),
      };
    },
  };
}

/**
 * Bright Data (https://docs.brightdata.com/proxy-networks/config-options).
 * `brd-customer-ID-zone-ZONE-country-us-session-…` on brd.superproxy.io:33335.
 * Bright Data intercepts TLS unless your account is verified; pass `insecure: true` (or install
 * their CA) if you see certificate errors.
 */
export function brightData(options: {
  customerId: string;
  zone: string;
  password: string;
  host?: string;
  port?: number;
  insecure?: boolean;
}): ProxyProvider {
  return {
    name: 'brightdata',
    resolve({ country, sessionId }) {
      const username = [
        `brd-customer-${options.customerId.replace(/^brd-customer-/, '')}`,
        `zone-${options.zone}`,
        country && `country-${country.toLowerCase()}`,
        `session-${sessionToken(sessionId, 12)}`,
      ]
        .filter(Boolean)
        .join('-');
      return {
        url: proxyEndpointUrl({
          host: options.host ?? 'brd.superproxy.io',
          port: options.port ?? 33335,
          username,
          password: options.password,
        }),
        insecure: options.insecure,
      };
    },
  };
}

/**
 * Decodo, formerly Smartproxy (https://help.decodo.com/docs/residential-proxy-parameters).
 * `user-USER-country-us-session-…-sessionduration-10` on gate.decodo.com:7000.
 */
export function decodo(options: {
  username: string;
  password: string;
  host?: string;
  port?: number;
  /** Sticky session lifetime, minutes (1–1440). Default 10. */
  sessionMinutes?: number;
}): ProxyProvider {
  return {
    name: 'decodo',
    resolve({ country, sessionId }) {
      const username = [
        prefixed(options.username, 'user-'),
        country && `country-${country.toLowerCase()}`,
        `session-${sessionToken(sessionId, 12)}`,
        `sessionduration-${options.sessionMinutes ?? 10}`,
      ]
        .filter(Boolean)
        .join('-');
      return {
        url: proxyEndpointUrl({
          host: options.host ?? 'gate.decodo.com',
          port: options.port ?? 7000,
          username,
          password: options.password,
        }),
      };
    },
  };
}

/** @deprecated Smartproxy is now Decodo. */
export const smartproxy: typeof decodo = decodo;

/**
 * IPRoyal residential (https://docs.iproyal.com/proxies/residential/proxy).
 * Targeting goes in the password: `PASS_country-us_session-XXXXXXXX_lifetime-10m`.
 */
export function iproyal(options: {
  username: string;
  password: string;
  host?: string;
  port?: number;
  /** Sticky session lifetime, e.g. `10m`, `1h`. Default `10m`. */
  lifetime?: string;
}): ProxyProvider {
  return {
    name: 'iproyal',
    resolve({ country, sessionId }) {
      const password = [
        options.password,
        country && `country-${country.toLowerCase()}`,
        `session-${sessionToken(sessionId, 8)}`,
        `lifetime-${options.lifetime ?? '10m'}`,
      ]
        .filter(Boolean)
        .join('_');
      return {
        url: proxyEndpointUrl({
          host: options.host ?? 'geo.iproyal.com',
          port: options.port ?? 12321,
          username: options.username,
          password,
        }),
      };
    },
  };
}

// --- Scraping APIs in proxy mode ---------------------------------------------------------------
// These solve anti-bot on their side and bill per request. Prefer the HTTP engine with them: in a
// browser, every sub-request of the page is a billed request.

/**
 * ZenRows Universal Scraper API, proxy mode (https://docs.zenrows.com/universal-scraper-api/features/proxy-mode).
 * `http://APIKEY:premium_proxy=true&proxy_country=us@api.zenrows.com:8001`.
 */
export function zenrows(options: {
  apiKey: string;
  /** Residential IPs. Default true (required for `proxy_country`). */
  premiumProxy?: boolean;
  /** Extra ZenRows parameters, e.g. `{ js_render: 'true' }`. */
  params?: Record<string, string>;
}): ProxyProvider {
  return {
    name: 'zenrows',
    resolve({ country, sessionId }) {
      const params = new URLSearchParams(options.params);
      if (options.premiumProxy !== false) params.set('premium_proxy', 'true');
      if (country && options.premiumProxy !== false) params.set('proxy_country', country.toLowerCase());
      params.set('session_id', String(sessionNumber(sessionId, 99_999)));
      return {
        url: `http://${encode(options.apiKey)}:${encode(params.toString())}@api.zenrows.com:8001`,
        insecure: true,
      };
    },
  };
}

/**
 * ScrapingBee, proxy mode (https://www.scrapingbee.com/documentation/proxy-mode/).
 * `http://APIKEY:render_js=False&premium_proxy=True@proxy.scrapingbee.com:8886`.
 */
export function scrapingBee(options: {
  apiKey: string;
  /** Residential IPs (required for `country_code`). Default true. */
  premiumProxy?: boolean;
  /** ScrapingBee's hardest-target pool. */
  stealthProxy?: boolean;
  params?: Record<string, string>;
}): ProxyProvider {
  return {
    name: 'scrapingbee',
    resolve({ country, sessionId }) {
      const params = new URLSearchParams({ render_js: 'False', ...options.params });
      if (options.stealthProxy) params.set('stealth_proxy', 'True');
      else if (options.premiumProxy !== false) params.set('premium_proxy', 'True');
      if (country && (options.stealthProxy || options.premiumProxy !== false)) {
        params.set('country_code', country.toLowerCase());
      }
      params.set('session_id', String(sessionNumber(sessionId, 10_000_000)));
      return {
        url: `http://${encode(options.apiKey)}:${encode(params.toString())}@proxy.scrapingbee.com:8886`,
        insecure: true,
      };
    },
  };
}

/**
 * ScraperAPI, proxy mode (https://docs.scraperapi.com/making-requests/proxy-port-method).
 * `http://scraperapi.country_code=us.session_number=123:APIKEY@proxy-server.scraperapi.com:8001`.
 */
export function scraperApi(options: {
  apiKey: string;
  premium?: boolean;
  params?: Record<string, string>;
}): ProxyProvider {
  return {
    name: 'scraperapi',
    resolve({ country, sessionId }) {
      const params: Record<string, string> = { ...options.params };
      if (country) params.country_code = country.toLowerCase();
      if (options.premium) params.premium = 'true';
      params.session_number = String(sessionNumber(sessionId, 1_000_000));
      const username = ['scraperapi', ...Object.entries(params).map(([k, v]) => `${k}=${v}`)].join('.');
      return {
        url: `http://${encode(username)}:${encode(options.apiKey)}@proxy-server.scraperapi.com:8001`,
        insecure: true,
      };
    },
  };
}

function prefixed(username: string, prefix: string): string {
  return username.startsWith(prefix) ? username : `${prefix}${username}`;
}
