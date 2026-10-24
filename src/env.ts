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
import type { BrowserOptions, BrowserTypeLike } from './engines/browser.ts';

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
};

/**
 * Builds the proxy from environment variables:
 *
 * - `XYTE_PROXY_URL`: one or more proxy URLs, comma-separated (rotated across retries), or
 * - `XYTE_PROXY_TEMPLATE`: a `template()` format, e.g.
 *   `http://user-{env:MY_USER}[-country-{country:lower}]-session-{session}:{env:MY_PASS}@host:7000`, or
 * - `XYTE_PROVIDER`: one or more of `oxylabs`, `oxylabs-datacenter`, `brightdata`, `decodo`,
 *   `iproyal`, `zenrows`, `scrapingbee`, `scraperapi`, `direct`, comma-separated (a retry moves to
 *   the next one), each with its credentials (`OXYLABS_USERNAME`, `ZENROWS_API_KEY`, …).
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

  if (env.XYTE_BROWSER_WS) {
    const endpoint = template(env.XYTE_BROWSER_WS);
    const protocol = env.XYTE_BROWSER_WS_PROTOCOL === 'playwright' ? 'playwright' : 'cdp';
    options.connect = async (context) => ({ endpoint: (await endpoint.resolve(context))!.url, protocol });
  }
  if (env.XYTE_BLOCK_RESOURCES) options.blockResources = list(env.XYTE_BLOCK_RESOURCES);
  if (env.XYTE_BROWSER_TIME_LIMIT) options.timeLimit = Number(env.XYTE_BROWSER_TIME_LIMIT);
  return options;
}
