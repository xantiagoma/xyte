import {
  brightData,
  decodo,
  direct,
  iproyal,
  oxylabs,
  proxyUrl,
  scraperApi,
  scrapingBee,
  template,
  zenrows,
  type ProxyProvider,
} from './proxy.ts';
import type { Extractor, Rate, Rates } from './client.ts';
import { adaptive, budget, byKind, healthy, rotate, route, watch, type BudgetOptions, type ProviderCheck } from './combinators.ts';
import { oxylabsUsage, scraperApiUsage, scrapingBeeUsage, STATUS_PAGES, statusPage, zenrowsUsage } from './checks.ts';
import type { CacheOptions } from './cache.ts';
import { parseLimit, type RateLimits } from './pace.ts';
import type { JobsOptions } from './jobs.ts';
import type { SessionPoolOptions } from './sessions.ts';
import { StatsRecorder } from './stats.ts';
import { redisStoreFromUrl, type StateStore } from './state.ts';
import type { BrowserOptions, BrowserTypeLike } from './engines/browser.ts';
import { llmExtractors, openAICompatible } from './llm.ts';
import type { ExtractionField } from './types.ts';
import * as long from './providers.ts';
import { scrapingBot, scrappey, zyteApi } from './apis.ts';
import { brightDataBrowser, browserless, nodeMavenBrowser, oxylabsBrowser, zenrowsBrowser } from './browsers.ts';

type Env = Record<string, string | undefined>;

const required = (env: Env, name: string): string => {
  const value = env[name];
  if (!value) throw new Error(`xyte: ${name} is required`);
  return value;
};

const PROVIDERS: Record<string, (env: Env) => ProxyProvider> = {
  direct: () => direct(),
  none: () => direct(),
  oxylabs: (env) => oxylabs({ username: required(env, 'OXYLABS_USERNAME'), password: required(env, 'OXYLABS_PASSWORD') }),
  'oxylabs-datacenter': (env) =>
    oxylabs({
      type: 'datacenter',
      username: required(env, 'OXYLABS_DC_USERNAME'),
      password: required(env, 'OXYLABS_DC_PASSWORD'),
    }),
  brightdata: (env) =>
    brightData({
      customerId: required(env, 'BRIGHTDATA_CUSTOMER_ID'),
      zone: required(env, 'BRIGHTDATA_ZONE'),
      password: required(env, 'BRIGHTDATA_PASSWORD'),
      insecure: env.BRIGHTDATA_INSECURE === 'true',
    }),
  decodo: (env) => decodo({ username: required(env, 'DECODO_USERNAME'), password: required(env, 'DECODO_PASSWORD') }),
  iproyal: (env) => iproyal({ username: required(env, 'IPROYAL_USERNAME'), password: required(env, 'IPROYAL_PASSWORD') }),
  zenrows: (env) => zenrows({ apiKey: required(env, 'ZENROWS_API_KEY') }),
  scrapingbee: (env) => scrapingBee({ apiKey: required(env, 'SCRAPINGBEE_API_KEY') }),
  scraperapi: (env) => scraperApi({ apiKey: required(env, 'SCRAPERAPI_API_KEY') }),
  ...userPass('nodemaven', long.nodeMaven),
  ...userPass('netnut', long.netNut),
  ...userPass('webshare', long.webshare),
  ...userPass('rayobyte', long.rayobyte),
  ...userPass('packetstream', long.packetStream),
  ...userPass('evomi', long.evomi),
  ...userPass('dataimpulse', long.dataImpulse),
  ...userPass('massive', long.massive),
  ...userPass('proxyseller', long.proxySeller),
  ...userPass('anyip', long.anyIp),
  ...userPass('thordata', long.thordata),
  ...userPass('abcproxy', long.abcProxy),
  ...userPass('proxyempire', long.proxyEmpire),
  ...userPass('rapidproxy', long.rapidProxy),
  ...userPass('swiftproxy', long.swiftProxy),
  soax: (env) => long.soax({ packageId: required(env, 'SOAX_PACKAGE_ID'), packageKey: required(env, 'SOAX_PACKAGE_KEY') }),
  crawlbase: (env) => long.crawlbase({ token: required(env, 'CRAWLBASE_TOKEN') }),
  scrapedo: (env) => long.scrapeDo({ token: required(env, 'SCRAPEDO_TOKEN') }),
  scrapingant: (env) => long.scrapingAnt({ apiKey: required(env, 'SCRAPINGANT_API_KEY') }),
  scrapeops: (env) => long.scrapeOps({ apiKey: required(env, 'SCRAPEOPS_API_KEY') }),
  scrapfly: (env) => long.scrapfly({ apiKey: required(env, 'SCRAPFLY_API_KEY') }),
  zyte: (env) => long.zyteProxy({ apiKey: required(env, 'ZYTE_API_KEY') }),
  'zyte-api': (env) => zyteApi({ apiKey: required(env, 'ZYTE_API_KEY') }),
  scrappey: (env) => scrappey({ apiKey: required(env, 'SCRAPPEY_API_KEY') }),
  scrapingbot: (env) => scrapingBot({ username: required(env, 'SCRAPINGBOT_USERNAME'), apiKey: required(env, 'SCRAPINGBOT_API_KEY') }),
  'oxylabs-unblocker': (env) =>
    long.oxylabsUnblocker({ username: required(env, 'OXYLABS_UNBLOCKER_USERNAME'), password: required(env, 'OXYLABS_UNBLOCKER_PASSWORD') }),
};

/** `NAME_USERNAME` / `NAME_PASSWORD` (and optional `NAME_HOST` / `NAME_PORT`) for a user+password preset. */
function userPass(
  name: string,
  make: (options: { username: string; password: string; host?: string; port?: number }) => ProxyProvider,
): Record<string, (env: Env) => ProxyProvider> {
  const prefix = name.toUpperCase().replace(/-/g, '_');
  return {
    [name]: (env) =>
      make({
        username: required(env, `${prefix}_USERNAME`),
        password: required(env, `${prefix}_PASSWORD`),
        host: env[`${prefix}_HOST`],
        port: env[`${prefix}_PORT`] ? Number(env[`${prefix}_PORT`]) : undefined,
      }),
  };
}

const REMOTE_BROWSERS: Record<string, (env: Env) => NonNullable<BrowserOptions['connect']>> = {
  brightdata: (env) =>
    brightDataBrowser({
      customerId: required(env, 'BRIGHTDATA_CUSTOMER_ID'),
      zone: required(env, 'BRIGHTDATA_BROWSER_ZONE'),
      password: required(env, 'BRIGHTDATA_BROWSER_PASSWORD'),
    }),
  browserless: (env) => browserless({ token: required(env, 'BROWSERLESS_TOKEN'), region: env.BROWSERLESS_REGION }),
  zenrows: (env) => zenrowsBrowser({ apiKey: required(env, 'ZENROWS_API_KEY') }),
  oxylabs: (env) =>
    oxylabsBrowser({ username: required(env, 'OXYLABS_BROWSER_USERNAME'), password: required(env, 'OXYLABS_BROWSER_PASSWORD') }),
  nodemaven: (env) =>
    nodeMavenBrowser({ username: required(env, 'NODEMAVEN_USERNAME'), password: required(env, 'NODEMAVEN_PASSWORD') }),
};

/**
 * Builds the proxy from environment variables:
 *
 * - `XYTE_PROXY_URL`: one or more proxy URLs, comma-separated (rotated across retries), or
 * - `XYTE_PROXY_TEMPLATE`: a `template()` format, e.g.
 *   `http://user-{env:MY_USER}[-country-{country:lower}]-session-{session}:{env:MY_PASS}@host:7000`, or
 * - `XYTE_PROVIDER`: one or more provider names, comma-separated (a retry moves to the next one),
 *   each with its credentials (`OXYLABS_USERNAME`, `ZENROWS_API_KEY`, …). See `PROVIDER_NAMES` and
 *   docs/providers.md, or
 * - `XYTE_ADAPTIVE`: provider names, cheapest first, for `adaptive()`.
 *
 * Neither set: no proxy. On top of that:
 *
 * - `XYTE_ROUTES=doordash.com=zyte-api,wolt.com=direct,restaurantguru.com=oxylabs+zyte-api`: a
 *   provider per site (`route()`), `+` rotating; other sites use the above.
 * - `XYTE_BROWSER_PROVIDER`: provider names for browser renders (`byKind()`).
 * - `XYTE_CIRCUIT_BREAKER=5,60`: wraps every named provider in `healthy()` (failures, cooldown s).
 * - `XYTE_BUDGET=zyte-api=500/hour,scrapingbee=1000/day`: wraps those providers in `budget()`.
 * - `XYTE_WATCH=true`: wraps providers that have a usage API or status page in `watch()`
 *   (`XYTE_WATCH_EVERY` seconds, default 60). Oxylabs needs `OXYLABS_LIMIT_GB` (and, if the
 *   proxy user isn't the account's main one, `OXYLABS_API_USERNAME` / `OXYLABS_API_PASSWORD`).
 * - `XYTE_REDIS_URL=redis://…`: budgets, circuits and checks are shared by every instance.
 *
 * A provider named in several places is one instance, so its budget and circuit are shared.
 */
export function proxyFromEnv(env: Env = process.env): ProxyProvider {
  const named = namedProviders(env);
  let provider = baseProxyFromEnv(env, named);
  if (env.XYTE_BROWSER_PROVIDER) provider = byKind({ http: provider, browser: named.chain(list(env.XYTE_BROWSER_PROVIDER)) });
  if (!env.XYTE_ROUTES) return provider;
  const routes: Record<string, ProxyProvider> = {};
  for (const entry of list(env.XYTE_ROUTES)) {
    const [host, names] = entry.split('=').map((part) => part.trim());
    if (!host || !names) throw new Error(`xyte: XYTE_ROUTES entry "${entry}" is not host=provider`);
    routes[host] = named.chain(names.split('+'));
  }
  return route(routes, provider);
}

function baseProxyFromEnv(env: Env, named: NamedProviders): ProxyProvider {
  if (env.XYTE_PROXY_TEMPLATE) {
    return template(env.XYTE_PROXY_TEMPLATE, { insecure: env.XYTE_PROXY_INSECURE === 'true' });
  }
  if (env.XYTE_PROXY_URL) {
    return proxyUrl(
      env.XYTE_PROXY_URL.split(',').map((url) => url.trim()).filter(Boolean),
      { insecure: env.XYTE_PROXY_INSECURE === 'true' },
    );
  }
  if (env.XYTE_ADAPTIVE) {
    const store = env.XYTE_REDIS_URL ? sharedStore(env.XYTE_REDIS_URL) : undefined;
    return adaptive(list(env.XYTE_ADAPTIVE).map((name) => named.get(name)), { store });
  }
  return named.chain(list(env.XYTE_PROVIDER));
}

interface NamedProviders {
  get(name: string): ProxyProvider;
  /** Several names rotate across attempts. */
  chain(names: readonly string[]): ProxyProvider;
}

/** Providers by name (`XYTE_PROVIDER` names, or `direct`), one instance each, with budgets and breakers applied. */
function namedProviders(env: Env): NamedProviders {
  const budgets = new Map<string, BudgetOptions>();
  for (const entry of list(env.XYTE_BUDGET)) {
    const match = /^([\w-]+)=(\d+)\/(minute|hour|day|\d+)$/.exec(entry.replace(/\s+/g, ''));
    if (!match) throw new Error(`xyte: XYTE_BUDGET entry "${entry}" is not provider=max/minute|hour|day|seconds`);
    const per = /^\d+$/.test(match[3]!) ? Number(match[3]) : (match[3] as 'minute' | 'hour' | 'day');
    budgets.set(match[1]!.toLowerCase(), { max: Number(match[2]), per });
  }
  const [failures, cooldown] = list(env.XYTE_CIRCUIT_BREAKER).map(Number);
  const store: StateStore | undefined = env.XYTE_REDIS_URL ? sharedStore(env.XYTE_REDIS_URL) : undefined;
  const watching = env.XYTE_WATCH === 'true';
  const every = env.XYTE_WATCH_EVERY ? Number(env.XYTE_WATCH_EVERY) : undefined;
  const cache = new Map<string, ProxyProvider>();
  const get = (raw: string): ProxyProvider => {
    const name = raw.trim().toLowerCase();
    let provider = cache.get(name);
    if (provider) return provider;
    if (name === 'direct') provider = direct();
    else {
      const make = PROVIDERS[name];
      if (!make) throw new Error(`xyte: unknown provider "${name}" (one of direct, ${Object.keys(PROVIDERS).join(', ')})`);
      provider = make(env);
    }
    const limit = budgets.get(name);
    if (limit) provider = budget(provider, { ...limit, store });
    if (failures && name !== 'direct') provider = healthy(provider, { failures, cooldown, store });
    const check = watching ? checkFor(name, env) : undefined;
    if (check) provider = watch(provider, { check, every, store, onChange: (result, p) => console.warn(`[xyte] ${p} ${result.available ? 'available' : 'unavailable'}: ${result.detail ?? ''}`) });
    cache.set(name, provider);
    return provider;
  };
  return {
    get,
    chain(names) {
      if (names.length === 0) return get('direct');
      const providers = names.map(get);
      return providers.length === 1 ? providers[0]! : rotate(providers);
    },
  };
}

/**
 * The response cache from `XYTE_CACHE_TTL`: seconds for every site (`3600`), or per site
 * (`wolt.com=600,*=3600`). Shared through `XYTE_REDIS_URL` when set. Unset: no cache.
 */
export function cacheFromEnv(env: Env = process.env): CacheOptions | undefined {
  const value = env.XYTE_CACHE_TTL?.trim();
  if (!value) return undefined;
  let ttl: CacheOptions['ttl'];
  if (/^\d+$/.test(value)) ttl = Number(value);
  else {
    const table: Record<string, number> = {};
    for (const entry of list(value)) {
      const [host, seconds] = entry.split('=').map((part) => part.trim());
      if (!host || !seconds || !/^\d+$/.test(seconds)) throw new Error(`xyte: XYTE_CACHE_TTL entry "${entry}" is not host=seconds`);
      table[host] = Number(seconds);
    }
    ttl = table;
  }
  return { ttl, ...(env.XYTE_REDIS_URL && { store: sharedStore(env.XYTE_REDIS_URL) }) };
}

/**
 * Your prices from `XYTE_RATES`: `oxylabs=6/GB,zyte-api=0.0013/request,scrapingbee=0.0005/success`,
 * `+` to combine units for one provider (`x=2/GB+0.001/request`).
 */
export function ratesFromEnv(env: Env = process.env): Rates | undefined {
  if (!env.XYTE_RATES?.trim()) return undefined;
  const rates: Record<string, Rate> = {};
  const units = { gb: 'perGB', request: 'perRequest', success: 'perSuccess' } as const;
  for (const entry of list(env.XYTE_RATES)) {
    const at = entry.indexOf('=');
    if (at <= 0) throw new Error(`xyte: XYTE_RATES entry "${entry}" is not provider=price/unit`);
    const rate: Rate = {};
    for (const part of entry.slice(at + 1).split('+')) {
      const match = /^\s*(\d+(?:\.\d+)?)\s*\/\s*(gb|request|success)\s*$/i.exec(part);
      if (!match) throw new Error(`xyte: XYTE_RATES price "${part.trim()}" is not like 6/GB, 0.001/request or 0.001/success`);
      rate[units[match[2]!.toLowerCase() as keyof typeof units]] = Number(match[1]);
    }
    rates[entry.slice(0, at).trim()] = rate;
  }
  return rates;
}

/** Per-site pacing from `XYTE_RATE_LIMITS`: `yelp.co.uk=2/s,doordash.com=30/m,*=10/s`. */
export function rateLimitsFromEnv(env: Env = process.env): RateLimits | undefined {
  if (!env.XYTE_RATE_LIMITS?.trim()) return undefined;
  const limits: Record<string, string> = {};
  for (const entry of list(env.XYTE_RATE_LIMITS)) {
    const at = entry.indexOf('=');
    if (at <= 0) throw new Error(`xyte: XYTE_RATE_LIMITS entry "${entry}" is not host=rate`);
    const rate = entry.slice(at + 1).trim();
    parseLimit(rate); // fail now on a bad value, not on the first request
    limits[entry.slice(0, at).trim()] = rate;
  }
  return limits;
}

/** The `sessionContext` pool from the environment: shared through `XYTE_REDIS_URL` when set. */
export function sessionsFromEnv(env: Env = process.env): SessionPoolOptions | undefined {
  return env.XYTE_REDIS_URL ? { store: sharedStore(env.XYTE_REDIS_URL) } : undefined;
}

/** The server's job options: `XYTE_WEBHOOK_SECRET`, `XYTE_JOBS_TTL` (seconds), kept in `XYTE_REDIS_URL` when set. */
export function jobsFromEnv(env: Env = process.env): JobsOptions {
  return {
    ...(env.XYTE_REDIS_URL && { store: sharedStore(env.XYTE_REDIS_URL) }),
    ...(env.XYTE_WEBHOOK_SECRET && { webhookSecret: env.XYTE_WEBHOOK_SECRET }),
    ...(env.XYTE_JOBS_TTL && { ttl: Number(env.XYTE_JOBS_TTL) }),
  };
}

/** The server's stats: kept in `XYTE_REDIS_URL` when set (every instance adds up), else in memory. */
export function statsFromEnv(env: Env = process.env): StatsRecorder {
  return new StatsRecorder({ ...(env.XYTE_REDIS_URL && { store: sharedStore(env.XYTE_REDIS_URL) }) });
}

const stores = new Map<string, StateStore>();
/** One Redis store per URL, shared by everything built from the environment. */
function sharedStore(url: string): StateStore {
  let store = stores.get(url);
  if (!store) stores.set(url, (store = redisStoreFromUrl(url)));
  return store;
}

/** A provider by its `XYTE_PROVIDER` name (or `direct`), as is: no budget, breaker or watch. */
export function providerFromName(name: string, env: Env = process.env): ProxyProvider {
  const key = name.trim().toLowerCase();
  if (key === 'direct') return direct();
  const make = PROVIDERS[key];
  if (!make) throw new Error(`xyte: unknown provider "${key}" (one of direct, ${Object.keys(PROVIDERS).join(', ')})`);
  return make(env);
}

/** Every provider name the environment configures (XYTE_PROVIDER, XYTE_ROUTES, XYTE_ADAPTIVE, XYTE_BROWSER_PROVIDER). */
export function configuredProviderNames(env: Env = process.env): string[] {
  const names = [
    ...list(env.XYTE_PROVIDER),
    ...list(env.XYTE_ADAPTIVE),
    ...list(env.XYTE_BROWSER_PROVIDER),
    ...list(env.XYTE_ROUTES).flatMap((entry) => (entry.split('=')[1] ?? '').split('+')),
  ].map((name) => name.trim().toLowerCase());
  return [...new Set(names.filter(Boolean))];
}

/** The usage API or status page `XYTE_WATCH` uses for a provider name, if there is one. */
export function checkFor(name: string, env: Env): ProviderCheck | undefined {
  switch (name) {
    case 'scrapingbee':
      return env.SCRAPINGBEE_API_KEY ? scrapingBeeUsage({ apiKey: env.SCRAPINGBEE_API_KEY }) : undefined;
    case 'zenrows':
      return env.ZENROWS_API_KEY ? zenrowsUsage({ apiKey: env.ZENROWS_API_KEY }) : undefined;
    case 'scraperapi':
      return env.SCRAPERAPI_API_KEY ? scraperApiUsage({ apiKey: env.SCRAPERAPI_API_KEY }) : undefined;
    case 'oxylabs': {
      const username = env.OXYLABS_API_USERNAME ?? env.OXYLABS_USERNAME;
      const password = env.OXYLABS_API_PASSWORD ?? env.OXYLABS_PASSWORD;
      if (!env.OXYLABS_LIMIT_GB || !username || !password) return undefined;
      return oxylabsUsage({ username, password, limitGB: Number(env.OXYLABS_LIMIT_GB) });
    }
    default:
      return STATUS_PAGES[name] ? statusPage(STATUS_PAGES[name]) : undefined;
  }
}

const list = (value: string | undefined) => (value ?? '').split(',').map((v) => v.trim()).filter(Boolean);

/**
 * Browser settings from environment variables:
 *
 * - `XYTE_BROWSER`: `playwright` (default) or `patchright`, or any installed Playwright-compatible
 *   package name exporting `chromium` (e.g. `rebrowser-playwright`).
 * - `XYTE_BROWSER_CHANNEL`: e.g. `chrome` to use installed Google Chrome.
 * - `XYTE_BROWSER_HEADLESS=false`: headed (needs a display, e.g. xvfb).
 * - `XYTE_BROWSER_ARGS`: extra Chromium flags, comma-separated.
 * - `XYTE_REMOTE_BROWSER`: a hosted browser preset: `brightdata`, `browserless`, `zenrows`, `oxylabs`,
 *   `nodemaven` (with its credentials, see docs/browser.md), or
 * - `XYTE_BROWSER_WS`: render in a remote browser at this CDP endpoint instead; accepts the same
 *   placeholders as `XYTE_PROXY_TEMPLATE` (e.g. `{country:lower}`, `{session}`).
 *   `XYTE_BROWSER_WS_PROTOCOL=playwright` for a Playwright server.
 * - `XYTE_BLOCK_RESOURCES`: resource types to abort, e.g. `image,media,font`.
 * - `XYTE_BROWSER_TIME_LIMIT`: seconds per request (default 60).
 * - `XYTE_BROWSER_SETTLE`: seconds to wait for the network to go quiet after load (default 3, 0 to skip).
 */
export function browserFromEnv(env: Env = process.env): BrowserOptions {
  const options: BrowserOptions = {};
  const name = env.XYTE_BROWSER?.trim();
  if (name && name !== 'playwright') {
    options.browserType = async () => {
      const mod = (await import(name)) as { chromium?: BrowserTypeLike; default?: { chromium?: BrowserTypeLike } };
      const chromium = mod.chromium ?? mod.default?.chromium;
      if (!chromium) throw new Error(`xyte: XYTE_BROWSER="${name}" does not export chromium`);
      return chromium;
    };
  }
  const launchOptions: NonNullable<BrowserOptions['launchOptions']> = {};
  if (env.XYTE_BROWSER_CHANNEL) launchOptions.channel = env.XYTE_BROWSER_CHANNEL;
  if (env.XYTE_BROWSER_HEADLESS === 'false') launchOptions.headless = false;
  if (env.XYTE_BROWSER_ARGS) launchOptions.args = list(env.XYTE_BROWSER_ARGS);
  if (Object.keys(launchOptions).length > 0) options.launchOptions = launchOptions;

  if (env.XYTE_REMOTE_BROWSER) {
    const make = REMOTE_BROWSERS[env.XYTE_REMOTE_BROWSER.toLowerCase()];
    if (!make) {
      throw new Error(`xyte: unknown XYTE_REMOTE_BROWSER "${env.XYTE_REMOTE_BROWSER}" (one of ${Object.keys(REMOTE_BROWSERS).join(', ')})`);
    }
    options.connect = make(env);
  } else if (env.XYTE_BROWSER_WS) {
    const endpoint = template(env.XYTE_BROWSER_WS);
    const protocol = env.XYTE_BROWSER_WS_PROTOCOL === 'playwright' ? 'playwright' : 'cdp';
    options.connect = async (context) => ({ endpoint: ((await endpoint.resolve(context)) as { url: string }).url, protocol });
  }
  if (env.XYTE_BLOCK_RESOURCES) options.blockResources = list(env.XYTE_BLOCK_RESOURCES);
  if (env.XYTE_BROWSER_TIME_LIMIT) options.timeLimit = Number(env.XYTE_BROWSER_TIME_LIMIT);
  if (env.XYTE_BROWSER_SETTLE) options.settleTime = Number(env.XYTE_BROWSER_SETTLE);
  return options;
}

/** Names accepted by `XYTE_PROVIDER`. */
export const PROVIDER_NAMES: readonly string[] = Object.keys(PROVIDERS);

/**
 * AI extraction from environment variables (any OpenAI-compatible API):
 * `XYTE_LLM_MODEL` (required to enable), `XYTE_LLM_BASE_URL` (default OpenAI), `XYTE_LLM_API_KEY`,
 * `XYTE_LLM_RESPONSE_FORMAT=json_object` for servers without JSON-schema output. Unset: no AI
 * extraction (those fields get a 400, as without an extractor).
 */
export function extractorsFromEnv(env: Env = process.env): Partial<Record<ExtractionField, Extractor>> | undefined {
  if (!env.XYTE_LLM_MODEL) return undefined;
  return llmExtractors({
    complete: openAICompatible({
      model: env.XYTE_LLM_MODEL,
      baseURL: env.XYTE_LLM_BASE_URL,
      apiKey: env.XYTE_LLM_API_KEY,
      responseFormat: env.XYTE_LLM_RESPONSE_FORMAT === 'json_object' ? 'json_object' : 'json_schema',
    }),
    maxInputChars: env.XYTE_LLM_MAX_INPUT_CHARS ? Number(env.XYTE_LLM_MAX_INPUT_CHARS) : undefined,
  });
}
