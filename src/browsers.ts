/**
 * Remote browser presets for `browser.connect`: hosted Chromium reached over CDP, which handles
 * proxies (and often CAPTCHAs) itself. Each returns a `connect` function that builds the endpoint
 * from the request's country and session.
 *
 *     new Xyte({ browser: { connect: brightDataBrowser({ customerId, zone, password }) } })
 */
import type { BrowserOptions } from './engines/browser.ts';
import { proxyEndpointUrl } from './proxy.ts';
import { sessionToken } from './util.ts';

type Connect = NonNullable<BrowserOptions['connect']>;

const wss = (url: string) => url.replace(/^http:/, 'wss:');

/** Bright Data Scraping Browser (https://docs.brightdata.com/products/scraping-browser): country in the username, port 9222. */
export function brightDataBrowser(options: { customerId: string; zone: string; password: string }): Connect {
  return ({ country }) => {
    const username = [
      `brd-customer-${options.customerId.replace(/^brd-customer-/, '')}`,
      `zone-${options.zone}`,
      country && `country-${country.toLowerCase()}`,
    ]
      .filter(Boolean)
      .join('-');
    return wss(proxyEndpointUrl({ host: 'brd.superproxy.io', port: 9222, username, password: options.password }));
  };
}

/**
 * Browserless (https://docs.browserless.io): token in the query, residential proxy with
 * `proxyCountry` / `proxySticky` when the request has a geolocation (or `proxy: 'residential'`).
 */
export function browserless(options: {
  token: string;
  /** e.g. `production-sfo`, `production-lon`, or a full `wss://` URL for self-hosted. */
  region?: string;
  proxy?: 'residential';
  params?: Record<string, string>;
}): Connect {
  return ({ country }) => {
    const base = options.region?.startsWith('ws') ? options.region : `wss://${options.region ?? 'production-sfo'}.browserless.io`;
    const url = new URL(base);
    url.searchParams.set('token', options.token);
    for (const [k, v] of Object.entries(options.params ?? {})) url.searchParams.set(k, v);
    if (options.proxy || country) {
      url.searchParams.set('proxy', options.proxy ?? 'residential');
      url.searchParams.set('proxySticky', 'true');
      if (country) url.searchParams.set('proxyCountry', country.toLowerCase());
    }
    return url.toString();
  };
}

/** ZenRows Scraping Browser (https://docs.zenrows.com/scraping-browser): `wss://browser.zenrows.com?apikey=…&proxy_country=…`. */
export function zenrowsBrowser(options: { apiKey: string; sessionTtl?: string }): Connect {
  return ({ country }) => {
    const url = new URL('wss://browser.zenrows.com');
    url.searchParams.set('apikey', options.apiKey);
    if (country) url.searchParams.set('proxy_country', country.toLowerCase());
    if (options.sessionTtl) url.searchParams.set('session_ttl', options.sessionTtl);
    return url.toString();
  };
}

/** Oxylabs Unblocking Browser: `wss://USER:PASS@ubc.oxylabs.io?p_cc=US`. */
export function oxylabsBrowser(options: { username: string; password: string }): Connect {
  return ({ country }) => {
    const url = new URL(wss(proxyEndpointUrl({ host: 'ubc.oxylabs.io', port: 443, ...options })).replace(':443', ''));
    if (country) url.searchParams.set('p_cc', country);
    return url.toString();
  };
}

/** NodeMaven Scraping Browser: `wss://USER-country-us-sid-…:PASS@browser.nodemaven.com:8080`. Verify. */
export function nodeMavenBrowser(options: { username: string; password: string }): Connect {
  return ({ country, sessionId }) => {
    const username = [options.username, country && `country-${country.toLowerCase()}`, `sid-${sessionToken(sessionId, 12)}`]
      .filter(Boolean)
      .join('-');
    return wss(proxyEndpointUrl({ host: 'browser.nodemaven.com', port: 8080, username, password: options.password }));
  };
}
