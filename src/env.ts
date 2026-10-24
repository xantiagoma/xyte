import {
  brightData,
  decodo,
  direct,
  iproyal,
  oxylabs,
  proxyUrl,
  rotate,
  scraperApi,
  scrapingBee,
  template,
  zenrows,
  type ProxyProvider,
} from './proxy.ts';
import type { Extractor } from './client.ts';
import type { BrowserOptions, BrowserTypeLike } from './engines/browser.ts';
import { llmExtractors, openAICompatible } from './llm.ts';
import type { ExtractionField } from './types.ts';
import * as long from './providers.ts';
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
 *   docs/providers.md.
 *
 * Neither set: no proxy.
 */
export function proxyFromEnv(env: Env = process.env): ProxyProvider {
  if (env.XYTE_PROXY_TEMPLATE) {
    return template(env.XYTE_PROXY_TEMPLATE, { insecure: env.XYTE_PROXY_INSECURE === 'true' });
  }
  if (env.XYTE_PROXY_URL) {
    return proxyUrl(
      env.XYTE_PROXY_URL.split(',').map((url) => url.trim()).filter(Boolean),
      { insecure: env.XYTE_PROXY_INSECURE === 'true' },
    );
  }
  const names = (env.XYTE_PROVIDER ?? '').split(',').map((name) => name.trim().toLowerCase()).filter(Boolean);
  if (names.length === 0) return direct();

  const providers = names.map((name) => {
    const make = PROVIDERS[name];
    if (!make) throw new Error(`xyte: unknown XYTE_PROVIDER "${name}" (one of ${Object.keys(PROVIDERS).join(', ')})`);
    return make(env);
  });
  return providers.length === 1 ? providers[0]! : rotate(providers);
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
    options.connect = async (context) => ({ endpoint: (await endpoint.resolve(context))!.url, protocol });
  }
  if (env.XYTE_BLOCK_RESOURCES) options.blockResources = list(env.XYTE_BLOCK_RESOURCES);
  if (env.XYTE_BROWSER_TIME_LIMIT) options.timeLimit = Number(env.XYTE_BROWSER_TIME_LIMIT);
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
