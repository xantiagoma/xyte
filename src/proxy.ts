import type { ExtractRequest, ExtractResponse } from './types.ts';
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
  /**
   * Headers added to every request through this proxy, for scraping APIs that take their
   * parameters as headers in proxy mode (Crawlbase, Zyte, Oxylabs Web Unblocker).
   */
  headers?: Record<string, string>;
  /**
   * Reads what a scraping API in proxy mode adds to its answers (HTTP requests only): the final
   * URL after redirects it followed itself, and its own error answers, which are retried as a
   * provider failure instead of being returned as the target's status.
   */
  inspect?: (res: { status: number; headers: Headers }) => { url?: string; failure?: string } | undefined;
  /** The provider's bookkeeping headers, left out of `httpResponseHeaders`. */
  hiddenHeaders?: RegExp;
  /**
   * False when this exit ignores the request's `geolocation` (a fixed proxy URL). Such requests
   * still run, with a warning (`onWarning`, `X-Xyte-Warning`).
   */
  appliesCountry?: boolean;
}

/**
 * A scraping service with no proxy port (Scrappey, ScrapingBot, Zyte API itself): it takes the
 * whole Zyte request and returns a Zyte-shaped response. Ban detection, retries, `rotate()` and
 * extractors work on its answer as on a proxied download.
 */
export interface ApiEndpoint {
  api: (request: ExtractRequest, info: { context: ProxyContext; signal: AbortSignal }) => Promise<ApiResult>;
}

export interface ApiResult {
  /** The Zyte-shaped response (url, statusCode, httpResponseBody / browserHtml, …). */
  response: ExtractResponse;
  /** The target's status, for ban detection. */
  statusCode: number;
  headers?: { name: string; value: string }[];
  /** The page as text, for ban detection and extractors. */
  html?: string;
  /** The service already handled bans (Zyte): skip xyte's ban check on this answer. */
  trusted?: boolean;
}

/** Picks the exit for each attempt. Presets resolve to a `ProxyEndpoint`; API adapters to an `ApiEndpoint`. */
export interface ProxyProvider<E extends ProxyEndpoint | ApiEndpoint = ProxyEndpoint | ApiEndpoint> {
  readonly name: string;
  /**
   * The provider answers AI extraction fields itself (Zyte API): requests for them are not
   * rejected upfront for lack of a local extractor.
   */
  readonly extracts?: boolean;
  /** The proxy (or API) for this attempt, or null to connect directly. */
  resolve(context: ProxyContext): E | null | Promise<E | null>;
}

export const isApiEndpoint = (endpoint: ProxyEndpoint | ApiEndpoint | null): endpoint is ApiEndpoint =>
  endpoint != null && 'api' in endpoint;

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
export function direct(): ProxyProvider<ProxyEndpoint> {
  return { name: 'direct', resolve: () => null };
}

/**
 * Any proxy (or list of proxies) given as URLs. With several, attempts rotate through them, so a
 * retry uses the next one. For providers that encode geo/session in the URL, use `custom`.
 */
export function proxyUrl(urls: string | readonly string[], options: { insecure?: boolean } = {}): ProxyProvider<ProxyEndpoint> {
  const list = typeof urls === 'string' ? [urls] : [...urls];
  if (list.length === 0) throw new Error('proxyUrl: at least one URL is required');
  return {
    name: 'proxy',
    resolve: ({ attempt, sessionId }) => ({
      url: list[(sessionNumber(sessionId, 1 << 30) + attempt) % list.length]!,
      insecure: options.insecure,
      appliesCountry: false,
    }),
  };
}

/** Build the proxy URL yourself from the context. */
export function custom(
  name: string,
  resolve: (context: ProxyContext) => string | ProxyEndpoint | null | Promise<string | ProxyEndpoint | null>,
): ProxyProvider<ProxyEndpoint> {
  return {
    name,
    async resolve(context) {
      const result = await resolve(context);
      return typeof result === 'string' ? { url: result } : result;
    },
  };
}

/**
 * Any provider, from its URL format. Placeholders:
 *
 * - `{country}` / `{country:lower}`: ISO-2 country from `geolocation`
 * - `{session}` / `{session:8}`: sticky-session token (alphanumeric, given length, default 12)
 * - `{session:number}` / `{session:number:99999}`: numeric session id (below the given max)
 * - `{ipType}`, `{attempt}`
 * - `{env:NAME}`: an environment variable (e.g. the password)
 *
 * Square brackets mark an optional part, dropped when a placeholder inside has no value (no
 * `geolocation` on the request, say). Substituted values are URL-encoded; literal text is not.
 *
 *     template('http://user-{env:USER}[-country-{country:lower}]-session-{session}:{env:PASS}@gate.example.com:7000')
 */
export function template(format: string, options: { insecure?: boolean; name?: string } = {}): ProxyProvider<ProxyEndpoint> {
  const env = typeof process !== 'undefined' ? process.env : {};
  const value = (token: string, context: ProxyContext): string | undefined => {
    const [key = '', ...args] = token.split(':');
    switch (key) {
      case 'country':
        return args[0] === 'lower' ? context.country?.toLowerCase() : context.country;
      case 'session':
        if (args[0] === 'number') return String(sessionNumber(context.sessionId, Number(args[1] ?? 1_000_000)));
        return sessionToken(context.sessionId, Number(args[0] ?? 12));
      case 'ipType':
        return context.ipType;
      case 'attempt':
        return String(context.attempt);
      case 'env':
        return env[args.join(':')];
      default:
        throw new Error(`template: unknown placeholder {${token}}`);
    }
  };
  const fill = (part: string, context: ProxyContext): string | undefined => {
    let missing = false;
    const out = part.replace(/\{([^}]+)\}/g, (_, token: string) => {
      const v = value(token, context);
      if (v == null || v === '') missing = true;
      return encode(v ?? '');
    });
    return missing ? undefined : out;
  };
  return {
    name: options.name ?? 'template',
    resolve(context) {
      const withOptional = format.replace(/\[([^\]]*)\]/g, (whole, part: string) =>
        // `[::1]` is an IPv6 host, not an optional part.
        /^[0-9a-f:.]+$/i.test(part) && part.includes(':') ? whole : (fill(part, context) ?? ''),
      );
      const url = fill(withOptional, context);
      if (url == null) throw new Error(`template: a required placeholder has no value in ${format}`);
      return { url, insecure: options.insecure, appliesCountry: format.includes('{country') };
    },
  };
}

/** Uses `datacenter` or `residential` per the request's `ipType`. */
export function byIpType<E extends ProxyEndpoint | ApiEndpoint>(providers: {
  datacenter?: ProxyProvider<E>;
  residential?: ProxyProvider<E>;
  /** When the request sets no `ipType`. Default: `datacenter` if given, else `residential`. */
  default?: 'datacenter' | 'residential';
}): ProxyProvider<E> {
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
export function rotate<E extends ProxyEndpoint | ApiEndpoint>(providers: readonly ProxyProvider<E>[]): ProxyProvider<E> {
  if (providers.length === 0) throw new Error('rotate: at least one provider is required');
  return {
    name: `rotate(${providers.map((p) => p.name).join(',')})`,
    extracts: providers.some((p) => p.extracts),
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
}): ProxyProvider<ProxyEndpoint> {
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
}): ProxyProvider<ProxyEndpoint> {
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
}): ProxyProvider<ProxyEndpoint> {
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
}): ProxyProvider<ProxyEndpoint> {
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
}): ProxyProvider<ProxyEndpoint> {
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
}): ProxyProvider<ProxyEndpoint> {
  return {
    name: 'scrapingbee',
    resolve({ country, sessionId }) {
      // forward_headers_pure: send our headers (cookies included) as they are.
      const params = new URLSearchParams({ render_js: 'False', forward_headers_pure: 'True', ...options.params });
      if (options.stealthProxy) params.set('stealth_proxy', 'True');
      else if (options.premiumProxy !== false) params.set('premium_proxy', 'True');
      if (country && (options.stealthProxy || options.premiumProxy !== false)) {
        params.set('country_code', country.toLowerCase());
      }
      params.set('session_id', String(sessionNumber(sessionId, 10_000_000)));
      return {
        url: `http://${encode(options.apiKey)}:${encode(params.toString())}@proxy.scrapingbee.com:8886`,
        insecure: true,
        inspect: (res) => ({
          url: res.headers.get('resolved-url') ?? res.headers.get('spb-resolved-url') ?? undefined,
          // Its own errors (unresolvable domain, target 5xx) are unbilled 5xx answers.
          failure:
            res.status >= 500 && (res.headers.get('spb-cost') ?? res.headers.get('cost')) === '0'
              ? `ScrapingBee could not fetch the page (${res.status}, not billed)`
              : undefined,
        }),
        hiddenHeaders: /^(spb-.*|cost|initial-status-code|resolved-url)$/i,
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
}): ProxyProvider<ProxyEndpoint> {
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
