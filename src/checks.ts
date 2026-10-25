import type { CheckResult, ProviderCheck } from './combinators.ts';

/**
 * Built-in checks for `watch()`: providers' usage APIs (is there quota left?) and status pages
 * (is it up?). Each takes the credentials it needs and an optional `fetch` (for tests or proxies).
 */

interface CheckOptions {
  fetch?: typeof fetch;
}

async function getJson(url: string, init: RequestInit & { signal: AbortSignal }, doFetch: typeof fetch = fetch): Promise<Record<string, unknown>> {
  const res = await doFetch(url, init);
  if (!res.ok) throw new Error(`${new URL(url).host} answered ${res.status}`);
  return (await res.json()) as Record<string, unknown>;
}

const num = (value: unknown): number | undefined => (typeof value === 'number' && Number.isFinite(value) ? value : typeof value === 'string' && value !== '' && Number.isFinite(Number(value)) ? Number(value) : undefined);

/**
 * ScrapingBee credits: unavailable once fewer than `minRemaining` are left (default 0).
 * Uses `GET app.scrapingbee.com/api/v1/usage` (checked against a live account).
 */
export function scrapingBeeUsage(options: CheckOptions & { apiKey: string; minRemaining?: number }): ProviderCheck {
  return async (signal) => {
    const usage = await getJson('https://app.scrapingbee.com/api/v1/usage', { headers: { authorization: `Bearer ${options.apiKey}` }, signal }, options.fetch);
    const max = num(usage.max_api_credit) ?? 0;
    const used = num(usage.used_api_credit) ?? 0;
    const remaining = max - used;
    return { available: remaining > (options.minRemaining ?? 0), remaining, detail: `scrapingbee ${used}/${max} credits used` };
  };
}

/**
 * ZenRows plan usage: unavailable when the subscription isn't active, its usage reaches
 * `maxPercent` (default 100), or the key's own credit caps are spent.
 * Uses `GET api.zenrows.com/v1/subscriptions/self/details` (from ZenRows's docs).
 */
export function zenrowsUsage(options: CheckOptions & { apiKey: string; maxPercent?: number }): ProviderCheck {
  return async (signal) => {
    const details = await getJson('https://api.zenrows.com/v1/subscriptions/self/details', { headers: { 'x-api-key': options.apiKey }, signal }, options.fetch);
    const status = String(details.status ?? 'unknown');
    const percent = num(details.usage_percent) ?? 0;
    const caps = ((details.api_key as { caps?: { remaining_credits?: unknown }[] } | undefined)?.caps ?? [])
      .map((cap) => num(cap.remaining_credits))
      .filter((n): n is number => n !== undefined);
    const remaining = caps.length > 0 ? Math.min(...caps) : undefined;
    const available = status.toUpperCase() === 'ACTIVE' && percent < (options.maxPercent ?? 100) && (remaining === undefined || remaining > 0);
    return { available, remaining, detail: `zenrows ${status.toLowerCase()}, ${percent}% used` };
  };
}

/**
 * ScraperAPI requests: unavailable once `requestCount` reaches `requestLimit`.
 * Uses `GET api.scraperapi.com/account` (from ScraperAPI's docs; not checked against an account).
 */
export function scraperApiUsage(options: CheckOptions & { apiKey: string }): ProviderCheck {
  return async (signal) => {
    const account = await getJson(`https://api.scraperapi.com/account?api_key=${encodeURIComponent(options.apiKey)}`, { signal }, options.fetch);
    const used = num(account.requestCount) ?? 0;
    const limit = num(account.requestLimit);
    const remaining = limit === undefined ? undefined : limit - used;
    return { available: remaining === undefined || remaining > 0, remaining, detail: `scraperapi ${used}/${limit ?? '?'} requests` };
  };
}

/**
 * Oxylabs residential traffic this month, against your plan's `limitGB` (the API reports usage,
 * not the limit): unavailable from `maxPercent` of it (default 100). Logs in to
 * `residential-api.oxylabs.io/v2` with the account's *main* proxy user (the first in the
 * dashboard), which may differ from the user requests go out with. From Oxylabs's docs; not yet
 * checked against an account.
 */
export function oxylabsUsage(options: CheckOptions & { username: string; password: string; limitGB: number; maxPercent?: number }): ProviderCheck {
  const base = 'https://residential-api.oxylabs.io/v2';
  let session: { token: string; userId: string; expires: number } | undefined;
  return async (signal) => {
    if (!session || session.expires < Date.now()) {
      const login = await getJson(
        `${base}/login`,
        { method: 'POST', headers: { authorization: `Basic ${btoa(`${options.username}:${options.password}`)}` }, signal },
        options.fetch,
      );
      if (typeof login.token !== 'string') throw new Error(`oxylabs login failed: ${String(login.error ?? 'no token')}`);
      // Tokens last an hour; renew a little before.
      session = { token: login.token, userId: String(login.user_id), expires: Date.now() + 50 * 60_000 };
    }
    const stats = await getJson(`${base}/users/${session.userId}/client-stats`, { headers: { authorization: `Bearer ${session.token}` }, signal }, options.fetch);
    const used = num(stats.traffic) ?? 0;
    const cap = options.limitGB * ((options.maxPercent ?? 100) / 100);
    const remaining = Math.max(0, options.limitGB - used);
    return { available: used < cap, remaining, detail: `oxylabs ${used.toFixed(2)}/${options.limitGB} GB this month` };
  };
}

/**
 * A Statuspage page (`https://status.zyte.com`, IPRoyal, Webshare…): unavailable while its
 * indicator is one of `downOn` (default `major`, `critical`; `minor` is a partial degradation).
 */
export function statusPage(url: string, options: CheckOptions & { downOn?: readonly string[] } = {}): ProviderCheck {
  const downOn = options.downOn ?? ['major', 'critical'];
  return async (signal) => {
    const page = await getJson(`${url.replace(/\/+$/, '')}/api/v2/status.json`, { signal }, options.fetch);
    const status = (page.status ?? {}) as { indicator?: string; description?: string };
    const indicator = status.indicator ?? 'unknown';
    return { available: !downOn.includes(indicator), detail: `${new URL(url).host}: ${status.description ?? indicator}` };
  };
}

/** Status pages known for providers xyte has presets for. */
export const STATUS_PAGES: Readonly<Record<string, string>> = {
  'zyte-api': 'https://status.zyte.com',
  zyte: 'https://status.zyte.com',
  iproyal: 'https://status.iproyal.com',
  webshare: 'https://status.webshare.io',
};

export type { CheckResult, ProviderCheck };
