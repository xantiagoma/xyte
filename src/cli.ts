#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { Xyte } from './client.ts';
import { browserFromEnv, extractorsFromEnv, proxyFromEnv } from './env.ts';
import { XyteError } from './errors.ts';
import { createHandler, serve } from './server.ts';
import { decodeBody } from './util.ts';

const HELP = `xyte: a Zyte API-compatible /v1/extract on any proxy

Usage:
  xyte serve [--port 8011] [--host 127.0.0.1]
  xyte extract <url> [--browser] [--country US] [--raw]
  xyte extract --json '{"url": "…", "httpResponseBody": true}'

Proxy (environment):
  XYTE_PROXY_URL=http://user:pass@host:port[,…]
  XYTE_PROXY_TEMPLATE='http://user[-country-{country:lower}]-session-{session}:pass@host:port'
  XYTE_PROVIDER=oxylabs|brightdata|decodo|iproyal|zenrows|scrapingbee|scraperapi[,…]
    with its credentials, e.g. OXYLABS_USERNAME / OXYLABS_PASSWORD, ZENROWS_API_KEY
  XYTE_API_KEYS=key1,key2   accepted keys for "serve" (default: any)
  XYTE_RETRIES, XYTE_TIMEOUT (seconds), XYTE_CONCURRENCY

Browser (environment):
  XYTE_BROWSER=playwright|patchright|<package>   XYTE_BROWSER_CHANNEL=chrome
  XYTE_BROWSER_WS=wss://…{country:lower}…       remote browser per request (CDP)
  XYTE_BLOCK_RESOURCES=image,media,font          XYTE_BROWSER_ARGS, XYTE_BROWSER_HEADLESS

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
    help: { type: 'boolean', short: 'h' },
  },
});

const env = process.env;
const num = (value: string | undefined) => (value ? Number(value) : undefined);

const xyte = new Xyte({
  proxy: proxyFromEnv(env),
  browser: browserFromEnv(env),
  extractors: extractorsFromEnv(env),
  retries: num(env.XYTE_RETRIES),
  timeout: num(env.XYTE_TIMEOUT),
  concurrency: num(env.XYTE_CONCURRENCY),
  onRetry: ({ attempt, url, reason }) => console.error(`[xyte] retry ${attempt} ${url}: ${reason}`),
});

const [command, target] = positionals;

if (values.help || !command) {
  console.log(HELP);
  process.exit(command || values.help ? 0 : 1);
}

if (command === 'serve') {
  const server = await serve(
    createHandler(xyte, { apiKeys: env.XYTE_API_KEYS?.split(',').map((k) => k.trim()).filter(Boolean) }),
    { port: num(values.port ?? env.PORT), hostname: values.host ?? env.HOST },
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
} else {
  console.error(`unknown command "${command}"\n\n${HELP}`);
  process.exit(1);
}
