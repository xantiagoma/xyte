import { XyteError } from './errors.ts';
import type { ApiEndpoint, AttemptOutcome, EndpointOf, ProxyContext, ProxyEndpoint, ProxyProvider } from './proxy.ts';
import { sessionNumber } from './util.ts';

type Resolved<E extends ProxyEndpoint | ApiEndpoint> = ReturnType<ProxyProvider<E>['resolve']>;

/** In-flight attempts a combinator keeps track of; older entries are dropped past this. */
const MAX_TRACKED = 10_000;

const attemptKey = (context: ProxyContext): string => `${context.requestId ?? context.sessionId}:${context.attempt}`;
const isAvailable = (provider: ProxyProvider, context: ProxyContext): boolean => provider.available?.(context) !== false;

function remember<V>(map: Map<string, V>, key: string, value: V): void {
  map.delete(key);
  map.set(key, value);
  if (map.size > MAX_TRACKED) map.delete(map.keys().next().value!);
}

/** Resolves through the chosen child and remembers it, so the attempt's outcome reaches it. */
class Delegation {
  private readonly chosen = new Map<string, ProxyProvider>();

  resolve(context: ProxyContext, child: ProxyProvider): ReturnType<ProxyProvider['resolve']> {
    context.path?.push(child.name);
    if (child.report) remember(this.chosen, attemptKey(context), child);
    return child.resolve(context);
  }

  report(context: ProxyContext, outcome: AttemptOutcome): void {
    const key = attemptKey(context);
    const child = this.chosen.get(key);
    this.chosen.delete(key);
    child?.report?.(context, outcome);
  }
}

/** A combinator: `pick` chooses the child for an attempt. */
function combine<E extends ProxyEndpoint | ApiEndpoint>(
  name: string,
  children: readonly ProxyProvider[],
  pick: (context: ProxyContext) => ProxyProvider,
  options: { available?: (context: ProxyContext) => boolean; context?: (context: ProxyContext) => ProxyContext } = {},
): ProxyProvider<E> {
  const delegation = new Delegation();
  return {
    name,
    extracts: children.some((child) => child.extracts),
    resolve: (context) => delegation.resolve(options.context?.(context) ?? context, pick(context)) as Resolved<E>,
    available: options.available ?? ((context) => isAvailable(pick(context), context)),
    report: (context, outcome) => delegation.report(context, outcome),
  };
}

/** The first available provider from `start` on (wrapping), or the one at `start` if none is. */
function firstAvailable(providers: readonly ProxyProvider[], start: number, context: ProxyContext): ProxyProvider {
  for (let k = 0; k < providers.length; k++) {
    const provider = providers[(start + k) % providers.length]!;
    if (isAvailable(provider, context)) return provider;
  }
  return providers[start % providers.length]!;
}

/**
 * Tries providers in order across attempts: attempt 0 → first, attempt 1 → second… and wraps.
 * A provider outage (e.g. a 407 on every request) then costs one attempt, not the request.
 * Unavailable providers (an open `healthy()` circuit, a spent `budget()`) are skipped.
 */
export function rotate<P extends ProxyProvider>(providers: readonly P[]): ProxyProvider<EndpointOf<P>> {
  if (providers.length === 0) throw new Error('rotate: at least one provider is required');
  return combine(`rotate(${providers.map((p) => p.name).join(',')})`, providers, (context) => firstAvailable(providers, context.attempt, context), {
    available: (context) => providers.some((p) => isAvailable(p, context)),
  });
}

/**
 * Picks the provider by the target's host, so each site gets the cheapest exit that works on it:
 * `route({ 'doordash.com': zyteApi(…), 'wolt.com': direct() }, residential)`. A key matches the
 * host and its subdomains (`doordash.com` matches `www.doordash.com`); the longest match wins.
 * Every attempt of a request, retries included, stays on its route: nest `rotate()` inside a
 * route for a fallback.
 */
export function route<R extends Readonly<Record<string, ProxyProvider>>, F extends ProxyProvider>(
  routes: R,
  fallback: F,
): ProxyProvider<EndpointOf<R[keyof R] | F>> {
  const entries = Object.entries(routes)
    .map(([host, provider]) => [host.toLowerCase().replace(/^\*?\./, ''), provider] as const)
    .sort(([a], [b]) => b.length - a.length);
  const pick = (context: ProxyContext): ProxyProvider => {
    const hostname = context.url.hostname.toLowerCase();
    return entries.find(([host]) => hostname === host || hostname.endsWith(`.${host}`))?.[1] ?? fallback;
  };
  const name = `route(${[...entries.map(([host, p]) => `${host}→${p.name}`), `*→${fallback.name}`].join(',')})`;
  return combine(name, [...entries.map(([, p]) => p), fallback], pick);
}

/** Uses `datacenter` or `residential` per the request's `ipType`. */
export function byIpType<D extends ProxyProvider = never, R extends ProxyProvider = never>(providers: {
  datacenter?: D;
  residential?: R;
  /** When the request sets no `ipType`. Default: `datacenter` if given, else `residential`. */
  default?: 'datacenter' | 'residential';
}): ProxyProvider<EndpointOf<D | R>> {
  const fallback = providers.default ?? (providers.datacenter ? 'datacenter' : 'residential');
  const typeOf = (context: ProxyContext) => context.ipType ?? fallback;
  const pick = (context: ProxyContext): ProxyProvider => {
    const type = typeOf(context);
    const provider = providers[type] ?? providers[type === 'datacenter' ? 'residential' : 'datacenter'];
    if (!provider) throw new Error('byIpType: no provider configured');
    return provider;
  };
  const children = [providers.datacenter, providers.residential].filter((p): p is D | R => p != null);
  return combine('byIpType', children, pick, { context: (context) => ({ ...context, ipType: typeOf(context) }) });
}

/**
 * One provider for plain HTTP requests, another for browser renders. Scraping APIs bill every
 * sub-request of a render, residential proxies bill per GB: `byKind({ http: scrapingBee(…),
 * browser: oxylabs(…) })`.
 */
export function byKind<H extends ProxyProvider, B extends ProxyProvider>(providers: { http: H; browser: B }): ProxyProvider<EndpointOf<H | B>> {
  return combine(`byKind(${providers.http.name},${providers.browser.name})`, [providers.http, providers.browser], (context) =>
    context.browser ? providers.browser : providers.http,
  );
}

/**
 * Picks the provider by the request's `geolocation` (ISO 3166-1 alpha-2): some networks are
 * better, or cheaper, in some countries. `byCountry({ US: oxylabs(…), FI: direct() }, decodo(…))`.
 */
export function byCountry<R extends Readonly<Record<string, ProxyProvider>>, F extends ProxyProvider>(
  countries: R,
  fallback: F,
): ProxyProvider<EndpointOf<R[keyof R] | F>> {
  const table = new Map(Object.entries(countries).map(([code, provider]) => [code.toUpperCase(), provider]));
  const name = `byCountry(${[...[...table].map(([code, p]) => `${code}→${p.name}`), `*→${fallback.name}`].join(',')})`;
  return combine(name, [...table.values(), fallback], (context) => (context.country && table.get(context.country)) || fallback);
}

/**
 * Splits traffic by weight, e.g. to try a new provider on 10% of requests:
 * `weighted([[current, 9], [candidate, 1]])`. Each request picks once (by its id); its retries
 * move on to the next provider, skipping unavailable ones.
 */
export function weighted<P extends ProxyProvider>(entries: readonly (readonly [P, number])[]): ProxyProvider<EndpointOf<P>> {
  const providers = entries.map(([provider]) => provider);
  const total = entries.reduce((sum, [, weight]) => sum + Math.max(0, weight), 0);
  if (providers.length === 0 || total <= 0) throw new Error('weighted: at least one provider with a positive weight is required');
  const startOf = (context: ProxyContext): number => {
    let point = (sessionNumber(context.requestId ?? context.sessionId, 1_000_000) / 1_000_000) * total;
    for (let i = 0; i < entries.length; i++) {
      point -= Math.max(0, entries[i]![1]);
      if (point < 0) return i;
    }
    return entries.length - 1;
  };
  const name = `weighted(${entries.map(([p, w]) => `${p.name}:${w}`).join(',')})`;
  return combine(name, providers, (context) => firstAvailable(providers, startOf(context) + context.attempt, context), {
    available: (context) => providers.some((p) => isAvailable(p, context)),
  });
}

export interface HealthyOptions {
  /** Consecutive failed attempts (proxy or network errors, not bans) that open the circuit. Default 5. */
  failures?: number;
  /** Seconds the circuit stays open. Then one attempt is let through: a failure reopens it. Default 60. */
  cooldown?: number;
  /** Called when the circuit opens (`true`) or closes again (`false`). */
  onChange?: (open: boolean, provider: string) => void;
}

/**
 * A circuit breaker: after `failures` consecutive proxy/network errors (a 407 on every login, a
 * gateway outage), the provider is reported unavailable for `cooldown` seconds, and `rotate()`,
 * `weighted()` and `adaptive()` go straight to the others instead of losing an attempt on it.
 * Bans don't count: they say the site blocked an IP, not that the provider is down. Used alone,
 * an open circuit doesn't block requests (there is nothing to fall back to).
 */
export function healthy<P extends ProxyProvider>(provider: P, options: HealthyOptions = {}): ProxyProvider<EndpointOf<P>> {
  const failures = options.failures ?? 5;
  const cooldownMs = (options.cooldown ?? 60) * 1000;
  let errors = 0;
  let openUntil = 0;
  let tripped = false;
  return {
    name: provider.name,
    extracts: provider.extracts,
    resolve: (context) => provider.resolve(context) as Resolved<EndpointOf<P>>,
    available: (context) => Date.now() >= openUntil && isAvailable(provider, context),
    report(context, outcome) {
      if (outcome.result === 'error') {
        errors++;
        // Half-open after the cooldown: a single failure reopens the circuit.
        if (tripped || errors >= failures) {
          if (!tripped) options.onChange?.(true, provider.name);
          openUntil = Date.now() + cooldownMs;
          tripped = true;
          errors = 0;
        }
      } else if (outcome.result === 'ok' || outcome.result === 'ban') {
        if (tripped) options.onChange?.(false, provider.name);
        errors = 0;
        tripped = false;
      }
      provider.report?.(context, outcome);
    },
  };
}

export interface BudgetOptions {
  /** Attempts allowed per window. */
  max: number;
  /** The window: seconds, or `minute`, `hour`, `day`. */
  per: number | 'minute' | 'hour' | 'day';
}

const WINDOWS = { minute: 60, hour: 3600, day: 86_400 } as const;

/**
 * Caps how many attempts go to a provider per time window, e.g. so a fallback to Zyte can't
 * run up the bill when a site starts blocking the cheaper exits: `rotate([residential,
 * budget(zyteApi(…), { max: 500, per: 'hour' })])`. Attempts that failed at the network level
 * are given back. Once spent, `rotate()` and the others skip it; used alone (or when every
 * option is spent), requests fail with a 429 `/limits/over-user-limit`, retryable later.
 */
export function budget<P extends ProxyProvider>(provider: P, options: BudgetOptions): ProxyProvider<EndpointOf<P>> {
  const windowMs = (typeof options.per === 'number' ? options.per : WINDOWS[options.per]) * 1000;
  const spent: number[] = [];
  const used = () => {
    const since = Date.now() - windowMs;
    while (spent.length > 0 && spent[0]! <= since) spent.shift();
    return spent.length;
  };
  return {
    name: provider.name,
    extracts: provider.extracts,
    resolve(context) {
      if (used() >= options.max) {
        throw new XyteError({
          status: 429,
          type: '/limits/over-user-limit',
          title: 'Budget Exceeded',
          detail: `the ${options.max} attempts per ${options.per}${typeof options.per === 'number' ? ' s' : ''} budget for "${provider.name}" is spent`,
        });
      }
      spent.push(Date.now());
      return provider.resolve(context) as Resolved<EndpointOf<P>>;
    },
    available: (context) => used() < options.max && isAvailable(provider, context),
    report(context, outcome) {
      // Network failures and aborted attempts aren't billed: give them back.
      if (outcome.result === 'error' || outcome.result === 'aborted') spent.pop();
      provider.report?.(context, outcome);
    },
  };
}

export interface AdaptiveOptions {
  /** A provider is used for a site while its success score there is at least this. Default 0.5. */
  minSuccess?: number;
  /** Share of requests that re-test a cheaper provider the site had stopped working on. Default 0.05. */
  explore?: number;
  /** How fast scores follow recent outcomes, 0–1. Default 0.2. */
  learningRate?: number;
  /** The key scores are kept by. Default: the host without `www.`. */
  keyOf?: (url: URL) => string;
}

export type AdaptiveProvider<E extends ProxyEndpoint | ApiEndpoint> = ProxyProvider<E> & {
  /** Current scores, by site and provider (1: always works, 0: never). */
  scores(): Record<string, Record<string, number>>;
};

/**
 * Learns, per site, the cheapest provider that works. List providers cheapest first:
 * `adaptive([direct(), residential, zyteApi(…)])`. Each request starts at the first provider
 * whose success score on that site is at least `minSuccess`; a retry moves to the next one.
 * Scores start optimistic and follow outcomes (bans and errors lower them), and a small share of
 * requests re-tests the cheaper ones, so a site that stops blocking moves back down.
 */
export function adaptive<P extends ProxyProvider>(providers: readonly P[], options: AdaptiveOptions = {}): AdaptiveProvider<EndpointOf<P>> {
  if (providers.length === 0) throw new Error('adaptive: at least one provider is required');
  const minSuccess = options.minSuccess ?? 0.5;
  const explore = options.explore ?? 0.05;
  const rate = options.learningRate ?? 0.2;
  const keyOf = options.keyOf ?? ((url: URL) => url.hostname.toLowerCase().replace(/^www\./, ''));
  const scores = new Map<string, (number | undefined)[]>();
  const starts = new Map<string, number>();
  const served = new Map<string, number>();

  const scoresFor = (site: string) => {
    let list = scores.get(site);
    if (!list) remember(scores, site, (list = providers.map(() => undefined)));
    return list;
  };
  const usable = (context: ProxyContext) => providers.map((p, i) => i).filter((i) => isAvailable(providers[i]!, context));

  const pickIndex = (context: ProxyContext): number => {
    const candidates = usable(context);
    if (candidates.length === 0) return Math.min(context.attempt, providers.length - 1);
    const request = context.requestId ?? context.sessionId;
    let start = context.attempt === 0 ? undefined : starts.get(request);
    if (start === undefined) {
      const site = scoresFor(keyOf(context.url));
      const good = candidates.find((i) => (site[i] ?? 1) >= minSuccess);
      start = good ?? candidates.reduce((best, i) => ((site[i] ?? 1) > (site[best] ?? 1) ? i : best));
      const cheaper = candidates.filter((i) => i < start!);
      if (cheaper.length > 0 && Math.random() < explore) start = cheaper[Math.floor(Math.random() * cheaper.length)]!;
      remember(starts, request, start);
    }
    // Attempt n: the n-th usable provider from the start, then stay on the last one.
    const from = candidates.filter((i) => i >= start!);
    return from.length > 0 ? from[Math.min(context.attempt, from.length - 1)]! : candidates[candidates.length - 1]!;
  };

  const delegation = new Delegation();
  return {
    name: `adaptive(${providers.map((p) => p.name).join(',')})`,
    extracts: providers.some((p) => p.extracts),
    resolve(context) {
      const index = pickIndex(context);
      remember(served, attemptKey(context), index);
      return delegation.resolve(context, providers[index]!) as Resolved<EndpointOf<P>>;
    },
    available: (context) => providers.some((p) => isAvailable(p, context)),
    report(context, outcome) {
      const key = attemptKey(context);
      const index = served.get(key);
      served.delete(key);
      if (index !== undefined && outcome.result !== 'aborted') {
        const site = scoresFor(keyOf(context.url));
        const score = site[index] ?? 1;
        site[index] = outcome.result === 'ok' ? score + rate * (1 - score) : score * (1 - rate);
      }
      if (outcome.result === 'ok') starts.delete(context.requestId ?? context.sessionId);
      delegation.report(context, outcome);
    },
    scores() {
      const out: Record<string, Record<string, number>> = {};
      for (const [site, list] of scores) {
        out[site] = Object.fromEntries(list.flatMap((score, i) => (score === undefined ? [] : [[providers[i]!.name, Math.round(score * 1000) / 1000]])));
      }
      return out;
    },
  };
}
