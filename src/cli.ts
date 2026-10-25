#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { Xyte } from './client.ts';
import { browserFromEnv, cacheFromEnv, extractorsFromEnv, proxyFromEnv, rateLimitsFromEnv, ratesFromEnv, sessionsFromEnv } from './env.ts';
import { doctor, formatDoctor } from './doctor.ts';
import { XyteError } from './errors.ts';
import { createHandler, serve } from './server.ts';
import { decodeBody } from './util.ts';

const HELP = `xyte: a Zyte API-compatible /v1/extract on any proxy

Usage:
  xyte serve [--port 8011] [--host 127.0.0.1]
  xyte extract <url> [--browser] [--country US] [--raw]
  xyte extract --json '{"url": "…", "httpResponseBody": true}'
  xyte doctor [--providers oxylabs,zyte-api] [--country US] [--url https://ipinfo.io/json]
      checks each configured provider: credentials, a real request (exit IP and country), quota

Proxy (environment):
  XYTE_PROXY_URL=http://user:pass@host:port[,…]
  XYTE_PROXY_TEMPLATE='http://user[-country-{country:lower}]-session-{session}:pass@host:port'
  XYTE_PROVIDER=oxylabs|brightdata|decodo|iproyal|zenrows|scrapingbee|scraperapi[,…]
    with its credentials, e.g. OXYLABS_USERNAME / OXYLABS_PASSWORD, ZENROWS_API_KEY
  XYTE_ROUTES=wolt.com=direct,doordash.com=zyte-api,…   a provider per site (+ rotates: oxylabs+zyte-api)
  XYTE_ADAPTIVE=direct,oxylabs,zyte-api          learn per site the cheapest provider that works
  XYTE_BROWSER_PROVIDER=oxylabs                  a different provider for browser renders
  XYTE_CIRCUIT_BREAKER=5,60                      skip a provider for 60 s after 5 straight failures
  XYTE_BUDGET=zyte-api=500/hour                  cap attempts per provider (then 429 / skipped)
  XYTE_API_KEYS=key1,key2   accepted keys for "serve" (required off-loopback, unless XYTE_ALLOW_ANONYMOUS=true)
  XYTE_ALLOW_PRIVATE_TARGETS=true   let "serve" fetch localhost / private IPs (blocked by default)
  XYTE_RETRIES, XYTE_TIMEOUT (seconds), XYTE_CONCURRENCY

Browser (environment):
  XYTE_BROWSER=playwright|patchright|<package>   XYTE_BROWSER_CHANNEL=chrome
  XYTE_BROWSER_WS=wss://…{country:lower}…       remote browser per request (CDP)
  XYTE_BLOCK_RESOURCES=image,media,font          XYTE_BROWSER_ARGS, XYTE_BROWSER_HEADLESS
  XYTE_BROWSER_SETTLE=3                          seconds to wait for network idle after load
  XYTE_BROWSER_FALLBACK=true                     retry a banned plain GET in the browser
  XYTE_LOG_REQUESTS=true                         one JSON line per request (attempts, providers, bytes)
  XYTE_CACHE_TTL=3600 | wolt.com=600,*=3600      answer repeats from a cache (Redis with XYTE_REDIS_URL)
  XYTE_RATE_LIMITS=yelp.co.uk=2/s,*=10/s         per-site pacing
  XYTE_RATES=oxylabs=6/GB,zyte-api=0.0013/request   your prices: costUsd in reports and logs
  XYTE_WATCH=true                                check providers' usage APIs / status pages
  XYTE_REDIS_URL=redis://…                       share budgets, circuits and checks across instances
  XYTE_BROWSER_SETTLE=3                          seconds to wait for network idle after load

AI extraction (product, article, customAttributes…) via any OpenAI-compatible API:
  XYTE_LLM_MODEL=gpt-5-mini  XYTE_LLM_BASE_URL=https://openrouter.ai/api/v1  XYTE_LLM_API_KEY=…
`;

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    port: { type: 'string' },
    host: { type: 'string' },
    browser: { type: 'boolean' },
    country: { type: 'string' },
    json: { type: 'string' },
    raw: { type: 'boolean' },
    providers: { type: 'string' },
    url: { type: 'string' },
    help: { type: 'boolean', short: 'h' },
  },
});

const env = process.env;
const num = (value: string | undefined) => (value ? Number(value) : undefined);

// Built on demand: `doctor` must run even when a provider's credentials are missing.
const makeXyte = () => new Xyte({
  proxy: proxyFromEnv(env),
  browser: browserFromEnv(env),
  extractors: extractorsFromEnv(env),
  retries: num(env.XYTE_RETRIES),
  timeout: num(env.XYTE_TIMEOUT),
  concurrency: num(env.XYTE_CONCURRENCY),
  browserFallback: env.XYTE_BROWSER_FALLBACK === 'true',
  cache: cacheFromEnv(env),
  rateLimits: rateLimitsFromEnv(env),
  rates: ratesFromEnv(env),
  sessions: sessionsFromEnv(env),
  // One JSON line per request, for log pipelines (Cloud Logging → BigQuery, Datadog…).
  onRequest: env.XYTE_LOG_REQUESTS === 'true' ? (report) => console.log(JSON.stringify({ xyte: 'request', ...report })) : undefined,
  onRetry: ({ attempt, url, reason }) => console.error(`[xyte] retry ${attempt} ${url}: ${reason}`),
});

const [command, target] = positionals;

if (values.help || !command) {
  console.log(HELP);
  process.exit(command || values.help ? 0 : 1);
}

if (command === 'serve') {
  const xyte = makeXyte();
  const apiKeys = env.XYTE_API_KEYS?.split(',').map((k) => k.trim()).filter(Boolean) ?? [];
  const hostname = values.host ?? env.HOST ?? '127.0.0.1';
  const loopback = hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '::1';
  // Without keys on a public interface, anyone could spend your proxy bandwidth.
  if (apiKeys.length === 0 && !loopback && env.XYTE_ALLOW_ANONYMOUS !== 'true') {
    console.error(
      `[xyte] refusing to listen on ${hostname} without XYTE_API_KEYS (set XYTE_ALLOW_ANONYMOUS=true to allow anyone)`,
    );
    process.exit(1);
  }
  const server = await serve(
    createHandler(xyte, { apiKeys, blockPrivateTargets: env.XYTE_ALLOW_PRIVATE_TARGETS !== 'true' }),
    { port: num(values.port ?? env.PORT), hostname },
  );
  console.error(`[xyte] listening on ${server.url}v1/extract`);
  const shutdown = async () => {
    await server.stop();
    await xyte.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
} else if (command === 'extract') {
  const xyte = makeXyte();
  const request = values.json
    ? JSON.parse(values.json)
    : {
        url: target,
        ...(values.browser ? { browserHtml: true } : { httpResponseBody: true }),
        ...(values.country ? { geolocation: values.country } : {}),
      };
  try {
    const response = await xyte.extract(request);
    if (values.raw) {
      process.stdout.write(response.browserHtml ?? (response.httpResponseBody ? decodeBody(response.httpResponseBody) : ''));
    } else {
      console.log(JSON.stringify(response, null, 2));
    }
  } catch (error) {
    console.error(error instanceof XyteError ? JSON.stringify(error.toJSON()) : error);
    process.exitCode = 1;
  } finally {
    await xyte.close();
  }
} else if (command === 'doctor') {
  const results = await doctor({
    env,
    providers: values.providers ? values.providers.split(',').map((p) => p.trim()).filter(Boolean) : undefined,
    country: values.country,
    url: values.url,
  });
  console.log(formatDoctor(results));
  if (results.some((r) => !r.ok || (r.quota && (!('available' in r.quota) || !r.quota.available)))) process.exitCode = 1;
} else {
  console.error(`unknown command "${command}"\n\n${HELP}`);
  process.exit(1);
}
