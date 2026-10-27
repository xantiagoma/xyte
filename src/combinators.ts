import { XyteError } from './errors.ts';
import type { ApiEndpoint, AttemptOutcome, EndpointOf, ProxyContext, ProxyEndpoint, ProxyProvider } from './proxy.ts';
import { memoryStore, resilient, type StateStore } from './state.ts';
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
    zyteActions: children.some((child) => child.zyteActions),
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
 * The same provider under another name, for reports, `rates`, circuits, budgets and `adaptive()`:
 * `named('oxylabs-us', oxylabs({ … }))`. Two instances of one preset in a combinator otherwise
 * share a name, and with it their numbers.
 */
export function named<P extends ProxyProvider>(name: string, provider: P): ProxyProvider<EndpointOf<P>> {
  return {
    name,
    extracts: provider.extracts,
    zyteActions: provider.zyteActions,
    resolve: (context) => provider.resolve(context) as Resolved<EndpointOf<P>>,
    ...(provider.available && { available: (context: ProxyContext) => provider.available!(context) }),
    ...(provider.report && { report: (context: ProxyContext, outcome: AttemptOutcome) => provider.report!(context, outcome) }),
  };
}

/** Options for `fallback()`. */
export interface FallbackOptions {
  /**
   * Attempts the primary gets per request before the fallbacks take over. Default 3: with the
   * default `retries: 3` (4 attempts), the fallbacks get the last one.
   */
  primaryAttempts?: number;
}

/**
 * The primary while it works, then the fallbacks: `fallback(zyteApi(…), [fleet], { primaryAttempts: 3 })`.
 * Each request gives the primary its first `primaryAttempts` attempts, then rotates through the
 * fallbacks. The fallbacks get every attempt when the primary is unavailable (an open `healthy()`
 * circuit, a spent `budget()`), and the rest of the request once it is passed over (an account
 * problem, an action it can't run). Counted per request, from each attempt's report.
 */
export function fallback<P extends ProxyProvider, F extends ProxyProvider>(
  primary: P,
  fallbacks: readonly F[],
  options: FallbackOptions = {},
): ProxyProvider<EndpointOf<P | F>> {
  const primaryAttempts = options.primaryAttempts ?? 3;
  /** Per request: attempts the primary and the fallbacks made, and whether the primary is out. */
  const requests = new Map<string, { primary: number; fallback: number; out: boolean }>();
  const chosen = new Map<string, ProxyProvider>();
  const stateOf = (context: ProxyContext) => {
    const key = context.requestId ?? context.sessionId;
    let state = requests.get(key);
    if (!state) remember(requests, key, (state = { primary: 0, fallback: 0, out: false }));
    return state;
  };
  const pick = (context: ProxyContext): ProxyProvider => {
    const state = stateOf(context);
    const usePrimary = fallbacks.length === 0 || (!state.out && state.primary < primaryAttempts && isAvailable(primary, context));
    return usePrimary ? primary : firstAvailable(fallbacks, state.fallback, context);
  };
  return {
    name: `fallback(${primary.name}→${fallbacks.map((p) => p.name).join(',')})`,
    extracts: primary.extracts || fallbacks.some((p) => p.extracts),
    zyteActions: primary.zyteActions || fallbacks.some((p) => p.zyteActions),
    resolve(context) {
      const child = pick(context);
      context.path?.push(child.name);
      remember(chosen, attemptKey(context), child);
      return child.resolve(context) as Resolved<EndpointOf<P | F>>;
    },
    available: (context) => isAvailable(primary, context) || fallbacks.some((p) => isAvailable(p, context)),
    report(context, outcome) {
      const key = attemptKey(context);
      const child = chosen.get(key);
      chosen.delete(key);
      if (!child) return;
      const state = stateOf(context);
      if (child === primary) {
        // Passed over (it can't serve this request) or an account problem: done with it here.
        if (outcome.result === 'aborted' || outcome.fatal) state.out = true;
        else state.primary++;
      } else state.fallback++;
      child.report?.(context, outcome);
    },
  };
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

/** Options of `healthy()`, the circuit breaker. */
export interface HealthyOptions {
  /**
   * Consecutive failed attempts (proxy or network errors, not bans) that open the circuit. Default
   * 5. An account problem (a bad key, a suspended account) opens it at once.
   */
  failures?: number;
  /** Seconds the circuit stays open. Then one attempt is let through: a failure reopens it. Default 60. */
  cooldown?: number;
  /** Called when the circuit opens (`true`) or closes again (`false`). */
  onChange?: (open: boolean, provider: string) => void;
  /** Shared state: a circuit one instance opens is open for all of them. Default: this process only. */
  store?: StateStore;
  /** The circuit's key in the store. Default: the provider's name. */
  key?: string;
}

/** How often a shared circuit's state is re-read (in the background, never on the request path). */
const SHARED_REFRESH_MS = 2000;

/**
 * A circuit breaker: after `failures` consecutive proxy/network errors (a 407 on every login, a
 * gateway outage), the provider is reported unavailable for `cooldown` seconds, and `rotate()`,
 * `weighted()` and `adaptive()` go straight to the others instead of losing an attempt on it.
 * Bans don't count: they say the site blocked an IP, not that the provider is down. Used alone,
 * an open circuit doesn't block requests (there is nothing to fall back to).
 * The circuit belongs to the instance: use one instance everywhere it appears, and every use
 * shares the circuit (in `rotate([h, h, h, x])`, `h` has one), or with a shared `store`, one key.
 */
export function healthy<P extends ProxyProvider>(provider: P, options: HealthyOptions = {}): ProxyProvider<EndpointOf<P>> {
  const failures = options.failures ?? 5;
  const cooldown = options.cooldown ?? 60;
  const shared = options.store ? resilient(options.store) : undefined;
  const sharedKey = `circuit:${options.key ?? provider.name}`;
  let errors = 0;
  let openUntil = 0;
  let tripped = false;
  let sharedOpen = false;
  let sharedReadAt = 0;
  return {
    name: provider.name,
    extracts: provider.extracts,
    zyteActions: provider.zyteActions,
    resolve: (context) => provider.resolve(context) as Resolved<EndpointOf<P>>,
    available(context) {
      if (shared && Date.now() - sharedReadAt > SHARED_REFRESH_MS) {
        sharedReadAt = Date.now();
        void shared.get(sharedKey).then((value) => {
          sharedOpen = value === 'open';
        });
      }
      return Date.now() >= openUntil && !sharedOpen && isAvailable(provider, context);
    },
    report(context, outcome) {
      if (outcome.result === 'error') {
        errors++;
        // Half-open after the cooldown: a single failure reopens the circuit. An account problem
        // (a suspended account) opens it at once: the next requests would all fail the same way.
        if (tripped || errors >= failures || outcome.fatal) {
          if (!tripped) options.onChange?.(true, provider.name);
          openUntil = Date.now() + cooldown * 1000;
          tripped = true;
          errors = 0;
          void shared?.set(sharedKey, 'open', cooldown);
        }
      } else if (outcome.result === 'ok' || outcome.result === 'ban') {
        if (tripped) {
          options.onChange?.(false, provider.name);
          sharedOpen = false;
          void shared?.set(sharedKey, 'closed', 1);
        }
        errors = 0;
        tripped = false;
      }
      provider.report?.(context, outcome);
    },
  };
}

/** Options of `budget()`. */
export interface BudgetOptions {
  /** Attempts allowed per window. */
  max: number;
  /** The window: seconds, or `minute`, `hour`, `day`. Windows are fixed (they start on the clock). */
  per: number | 'minute' | 'hour' | 'day';
  /** Shared state: every instance spends from one budget. Default: this process only. */
  store?: StateStore;
  /** The budget's key in the store. Default: the provider's name. */
  key?: string;
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
  const windowSeconds = typeof options.per === 'number' ? options.per : WINDOWS[options.per];
  const store = options.store ? resilient(options.store) : memoryStore();
  const name = options.key ?? provider.name;
  const windowKey = () => `budget:${name}:${Math.floor(Date.now() / (windowSeconds * 1000))}`;
  // The last count this process saw, for the synchronous available().
  let seen = { key: '', used: 0 };
  const charged = new Map<string, string>();
  return {
    name: provider.name,
    extracts: provider.extracts,
    zyteActions: provider.zyteActions,
    async resolve(context) {
      const key = windowKey();
      const used = await store.incr(key, 1, windowSeconds);
      seen = { key, used };
      if (used > options.max) {
        seen = { key, used: await store.incr(key, -1, windowSeconds) };
        throw new XyteError({
          status: 429,
          type: '/limits/over-user-limit',
          title: 'Budget Exceeded',
          detail: `the ${options.max} attempts per ${options.per}${typeof options.per === 'number' ? ' s' : ''} budget for "${name}" is spent`,
        });
      }
      remember(charged, attemptKey(context), key);
      return provider.resolve(context) as Resolved<EndpointOf<P>>;
    },
    available: (context) => (seen.key === windowKey() ? seen.used : 0) < options.max && isAvailable(provider, context),
    report(context, outcome) {
      const key = charged.get(attemptKey(context));
      charged.delete(attemptKey(context));
      // Network failures and aborted attempts aren't billed: give them back.
      if (key && (outcome.result === 'error' || outcome.result === 'aborted')) {
        void store.incr(key, -1, windowSeconds).then((used) => {
          if (seen.key === key) seen = { key, used };
        });
      }
      provider.report?.(context, outcome);
    },
  };
}

/** What a provider check found: whether to use the provider, and why. */
export interface CheckResult {
  available: boolean;
  /** Human-readable state, e.g. `820/1000 credits used`. */
  detail?: string;
  /** What's left, in the check's own unit (credits, requests, GB), when it knows. */
  remaining?: number;
}

/** Asks a provider's API or status page how it is. Built-in ones are in `checks`. */
export type ProviderCheck = (signal: AbortSignal) => Promise<CheckResult>;

/** Options of `watch()`. */
export interface WatchOptions {
  /** One or more checks; the provider is available while all of them say so. */
  check: ProviderCheck | readonly ProviderCheck[];
  /** Seconds between checks. Default 60. */
  every?: number;
  /** Seconds a check may take. Default 10. */
  timeout?: number;
  /** Shared state: one instance checks, the others reuse its answer until it's `every` old. */
  store?: StateStore;
  /** The result's key in the store. Default: the provider's name. */
  key?: string;
  /** Called when availability changes (and on a first result that is unavailable). */
  onChange?: (result: CheckResult, provider: string) => void;
  /** Called when a check itself fails; the last result stays in place. */
  onError?: (error: unknown, provider: string) => void;
}

/** What `watch()` returns: a provider that also exposes its last check. */
export type WatchedProvider<E extends ProxyEndpoint | ApiEndpoint> = ProxyProvider<E> & {
  /** The last check's result; undefined before the first one finished. */
  status(): CheckResult | undefined;
  /** Checks now (e.g. at startup, to know before the first request) and resolves with the result. */
  refresh(): Promise<CheckResult | undefined>;
};

/**
 * Asks a provider how it is, ahead of requests: its usage API (credits left) or status page. An
 * exhausted or down provider is reported unavailable, so `rotate()`, `route()`, `weighted()` and
 * `adaptive()` skip it before an attempt is wasted on it. Checks run in the background every
 * `every` seconds, never on the request path; until the first one answers, the provider counts as
 * available. Used alone, an unavailable provider is still used (there is nothing to fall back to).
 */
export function watch<P extends ProxyProvider>(provider: P, options: WatchOptions): WatchedProvider<EndpointOf<P>> {
  const checks: readonly ProviderCheck[] = typeof options.check === 'function' ? [options.check] : options.check;
  const every = options.every ?? 60;
  const timeoutMs = (options.timeout ?? 10) * 1000;
  const store = options.store ? resilient(options.store) : undefined;
  const sharedKey = `watch:${options.key ?? provider.name}`;
  let last: CheckResult | undefined;
  let checkedAt = 0;
  let inflight: Promise<CheckResult | undefined> | undefined;

  const apply = (result: CheckResult) => {
    const changed = last === undefined ? !result.available : last.available !== result.available;
    last = result;
    if (changed) options.onChange?.(result, provider.name);
  };
  const run = async (): Promise<CheckResult> => {
    const cached = await store?.get(sharedKey);
    if (cached) {
      const result = JSON.parse(cached) as CheckResult;
      apply(result);
      return result;
    }
    const results = await Promise.all(checks.map((check) => check(AbortSignal.timeout(timeoutMs))));
    const remaining = results.flatMap((r) => (r.remaining === undefined ? [] : [r.remaining]));
    const result: CheckResult = {
      available: results.every((r) => r.available),
      detail: results.flatMap((r) => (r.detail ? [r.detail] : [])).join('; ') || undefined,
      remaining: remaining.length > 0 ? Math.min(...remaining) : undefined,
    };
    apply(result);
    await store?.set(sharedKey, JSON.stringify(result), every);
    return result;
  };
  const start = (): Promise<CheckResult | undefined> =>
    (inflight ??= run()
      .catch((error: unknown) => {
        options.onError?.(error, provider.name);
        return last;
      })
      .finally(() => {
        checkedAt = Date.now();
        inflight = undefined;
      }));
  // An explicit refresh wants the state as of now: wait out a check already running, then check.
  const refresh = async (): Promise<CheckResult | undefined> => {
    await inflight;
    return start();
  };
  const refreshIfStale = () => {
    if (!inflight && Date.now() - checkedAt >= every * 1000) void start();
  };

  return {
    name: provider.name,
    extracts: provider.extracts,
    zyteActions: provider.zyteActions,
    resolve(context) {
      refreshIfStale();
      return provider.resolve(context) as Resolved<EndpointOf<P>>;
    },
    available(context) {
      refreshIfStale();
      return (last?.available ?? true) && isAvailable(provider, context);
    },
    report: (context, outcome) => provider.report?.(context, outcome),
    status: () => last,
    refresh,
  };
}

/** Options of `adaptive()`. */
export interface AdaptiveOptions {
  /** A provider is used for a site while its success score there is at least this. Default 0.5. */
  minSuccess?: number;
  /** Share of requests that re-test a cheaper provider the site had stopped working on. Default 0.05. */
  explore?: number;
  /** How fast scores follow recent outcomes, 0–1. Default 0.2. */
  learningRate?: number;
  /** The key scores are kept by. Default: the host without `www.`. */
  keyOf?: (url: URL) => string;
  /**
   * Shared state: every instance learns from every other's outcomes. Updates go to the store as
   * they happen; each instance re-reads a site's scores in the background every `syncEvery`
   * seconds. Default: this process only.
   */
  store?: StateStore;
  /** The scores' key prefix in the store. Default: the adaptive provider's name. */
  key?: string;
  /** Seconds between background re-reads of a site's shared scores. Default 5. */
  syncEvery?: number;
}

/** Shared adaptive scores are dropped after a week without updates. */
const SCORES_TTL = 7 * 86_400;

/** What `adaptive()` returns: a provider that also reports its learned scores. */
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
  const name = `adaptive(${providers.map((p) => p.name).join(',')})`;
  const store = options.store ? resilient(options.store) : undefined;
  const storeKey = (site: string) => `adaptive:${options.key ?? name}:${site}`;
  const syncMs = (options.syncEvery ?? 5) * 1000;
  const readAt = new Map<string, number>();
  const learn = (score: number | undefined, result: AttemptOutcome['result']) => {
    const s = score ?? 1;
    return result === 'ok' ? s + rate * (1 - s) : s * (1 - rate);
  };
  /** Shared scores by provider name, into the local list. */
  const adopt = (site: string, shared: Record<string, number>) => {
    const list = scoresFor(site);
    providers.forEach((provider, i) => {
      if (typeof shared[provider.name] === 'number') list[i] = shared[provider.name];
    });
  };
  const sync = (site: string) => {
    if (!store || Date.now() - (readAt.get(site) ?? 0) < syncMs) return;
    remember(readAt, site, Date.now());
    void store.get(storeKey(site)).then((value) => value && adopt(site, JSON.parse(value) as Record<string, number>));
  };
  /** Applies an outcome to the shared scores (read, update this provider, write), then adopts them. */
  const share = (site: string, index: number, result: AttemptOutcome['result']) => {
    if (!store) return;
    void store.get(storeKey(site)).then(async (value) => {
      const shared = value ? (JSON.parse(value) as Record<string, number>) : {};
      const provider = providers[index]!.name;
      shared[provider] = learn(shared[provider] ?? scoresFor(site)[index], result);
      await store.set(storeKey(site), JSON.stringify(shared), SCORES_TTL);
      adopt(site, shared);
    });
  };

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
      sync(keyOf(context.url));
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
    name,
    extracts: providers.some((p) => p.extracts),
    zyteActions: providers.some((p) => p.zyteActions),
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
        const site = keyOf(context.url);
        const list = scoresFor(site);
        list[index] = learn(list[index], outcome.result);
        share(site, index, outcome.result);
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
