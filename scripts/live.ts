// Live checks against real public sites. Network required.
//
//   bun run test:live                                    # builds, serves dist/ on Node with direct(), checks it
//   XYTE_LIVE_URL=https://xyte.example/v1/extract XYTE_LIVE_KEY=… bun scripts/live.ts   # a deployed xyte
//   XYTE_LIVE_URL=https://api.zyte.com/v1/extract bun scripts/live.ts  # Zyte itself, key from ZYTE_API_KEY (.env)
//   XYTE_LIVE_PROVIDER=oxylabs bun scripts/live.ts       # the local server through a provider (credentials from .env)
//   XYTE_LIVE_HTTP_ONLY=true …                           # skip browser checks (scraping APIs bill every sub-request)
//
// The same requests against xyte and Zyte, so the answers can be compared. Checks of xyte-only
// behaviour (SSRF guard, AI fields without an extractor) are skipped against Zyte.
import { spawn, type ChildProcess } from 'node:child_process';

const PORT = 8099;
let base = process.env.XYTE_LIVE_URL;
const againstZyte = base?.includes('api.zyte.com') ?? false;
const provider = process.env.XYTE_LIVE_PROVIDER ?? '';
const httpOnly = process.env.XYTE_LIVE_HTTP_ONLY === 'true';
const key = process.env.XYTE_LIVE_KEY ?? (againstZyte ? process.env.ZYTE_API_KEY : undefined) ?? 'live-test-key';
let server: ChildProcess | undefined;

if (!base) {
  base = `http://127.0.0.1:${PORT}/v1/extract`;
  server = spawn('node', ['dist/cli.mjs', 'serve'], { env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', XYTE_API_KEYS: key, XYTE_PROVIDER: provider, XYTE_PROXY_URL: '', XYTE_PROXY_TEMPLATE: '' }, stdio: 'inherit' });
  for (let i = 0; i < 50; i++) {
    if (await fetch(`http://127.0.0.1:${PORT}/healthz`).then((r) => r.ok, () => false)) break;
    await new Promise((r) => setTimeout(r, 200));
  }
}

const decode = (b64: string): string => Buffer.from(b64, 'base64').toString('utf8');

async function call(body: unknown, opts: { key?: string; raw?: string } = {}): Promise<{ status: number; json: any; ms: number }> {
  const started = performance.now();
  const res = await fetch(base!, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Basic ' + btoa((opts.key ?? key) + ':') },
    body: opts.raw ?? JSON.stringify(body),
  });
  const json: any = await res.json().catch(() => null);
  return { status: res.status, json, ms: Math.round(performance.now() - started) };
}

let passed = 0;
let failed = 0;
async function check(name: string, fn: () => Promise<[boolean, string]>, { xyteOnly = false, browser = false } = {}): Promise<void> {
  if ((xyteOnly && againstZyte) || (browser && httpOnly)) return void console.log(`SKIP  ${name}`);
  const [ok, info] = await fn().catch((e): [boolean, string] => [false, String(e)]);
  ok ? passed++ : failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name} — ${info}`);
}

await check('httpResponseBody', async () => {
  const r = await call({ url: 'https://example.com', httpResponseBody: true });
  const html = decode(r.json.httpResponseBody);
  return [r.status === 200 && r.json.statusCode === 200 && html.includes('Example Domain'), `${r.status}, keys ${Object.keys(r.json)}, ${r.ms} ms`];
});

await check('browserHtml: false + httpResponseBody (JSON API)', async () => {
  const r = await call({ url: 'https://httpbin.org/json', browserHtml: false, httpResponseBody: true });
  return [r.status === 200 && !!JSON.parse(decode(r.json.httpResponseBody)).slideshow, `${r.status}, keys ${Object.keys(r.json)}`];
});

await check('POST with a base64 httpRequestBody', async () => {
  const r = await call({ url: 'https://httpbin.org/post', httpResponseBody: true, httpRequestMethod: 'POST', httpRequestBody: btoa('{"q":"pizza"}'), customHttpRequestHeaders: [{ name: 'Content-Type', value: 'application/json' }] });
  const echoed = JSON.parse(decode(r.json.httpResponseBody)).json;
  return [echoed?.q === 'pizza', `site received ${JSON.stringify(echoed)}`];
});

await check('customHttpRequestHeaders + requestCookies', async () => {
  const r = await call({ url: 'https://httpbin.org/anything', httpResponseBody: true, customHttpRequestHeaders: [{ name: 'X-Test', value: 'abc' }], requestCookies: [{ name: 'sid', value: '42', domain: 'httpbin.org' }] });
  const headers = JSON.parse(decode(r.json.httpResponseBody)).headers;
  return [headers['X-Test'] === 'abc' && /sid=42/.test(headers.Cookie ?? ''), `X-Test=${headers['X-Test']}, Cookie=${headers.Cookie}`];
});

await check('target 404 is HTTP 200 with statusCode 404', async () => {
  const r = await call({ url: 'https://httpbin.org/status/404', httpResponseBody: true });
  return [r.status === 200 && r.json.statusCode === 404, `${r.status}, statusCode ${r.json.statusCode}`];
});

await check('httpResponseHeaders', async () => {
  const r = await call({ url: 'https://example.com', httpResponseBody: true, httpResponseHeaders: true });
  const type = r.json.httpResponseHeaders?.find((h: { name: string }) => h.name.toLowerCase() === 'content-type');
  return [!!type, `${r.json.httpResponseHeaders?.length} headers, content-type ${type?.value}`];
});

await check('redirects are followed and the final url reported', async () => {
  // Not /redirect-to?url=…: Zyte answers a URL carrying another URL in its query with a 520.
  const r = await call({ url: 'https://httpbin.org/redirect/1', httpResponseBody: true });
  return [r.json.url === 'https://httpbin.org/get' && r.json.statusCode === 200, `url ${r.json.url}`];
});

await check('browserHtml renders JavaScript', async () => {
  const http = await call({ url: 'https://quotes.toscrape.com/js/', httpResponseBody: true });
  const r = await call({ url: 'https://quotes.toscrape.com/js/', browserHtml: true });
  const raw = (decode(http.json.httpResponseBody).match(/class="quote"/g) ?? []).length;
  const rendered = (r.json.browserHtml?.match(/class="quote"/g) ?? []).length;
  return [rendered >= 10 && raw === 0, `quotes: ${raw} over HTTP, ${rendered} rendered, ${r.ms} ms`];
}, { browser: true });

await check('actions: waitForSelector, evaluate, onError continue', async () => {
  const r = await call({
    url: 'https://quotes.toscrape.com/js/',
    browserHtml: true,
    actions: [
      { action: 'waitForSelector', selector: { type: 'css', value: '.quote', state: 'visible' }, timeout: 10 },
      { action: 'evaluate', source: 'document.body.setAttribute("data-live","1")' },
      { action: 'waitForSelector', selector: { type: 'css', value: '#missing' }, timeout: 1, onError: 'continue' },
    ],
  });
  const statuses: string[] = r.json.actions?.map((a: { status: string }) => a.status) ?? [];
  const ok = statuses[0] === 'success' && statuses[1] === 'success' && statuses[2] !== 'success' && r.json.browserHtml?.includes('data-live="1"');
  return [r.status === 200 && ok, `action statuses ${statuses}`];
}, { browser: true });

await check('networkCapture of the page’s XHR', async () => {
  const r = await call({ url: 'https://quotes.toscrape.com/scroll', browserHtml: true, networkCapture: [{ filterType: 'url', matchType: 'contains', value: 'api/quotes', httpResponseBody: true }] });
  const capture = r.json.networkCapture?.[0];
  const quotes = capture ? JSON.parse(decode(capture.httpResponseBody)).quotes?.length : 0;
  return [quotes > 0, `${r.json.networkCapture?.length} captures, ${capture?.url}, ${quotes} quotes`];
}, { browser: true });

await check('screenshot: JPEG by default, PNG on request', async () => {
  const jpeg = Buffer.from((await call({ url: 'https://example.com', screenshot: true })).json.screenshot ?? '', 'base64');
  const png = Buffer.from((await call({ url: 'https://example.com', screenshot: true, screenshotOptions: { format: 'png' } })).json.screenshot ?? '', 'base64');
  return [jpeg[0] === 0xff && jpeg[1] === 0xd8 && png.subarray(1, 4).toString() === 'PNG', `jpeg ${jpeg.length} B, png ${png.length} B`];
}, { browser: true });

await check('markdown', async () => {
  const r = await call({ url: 'https://en.wikipedia.org/wiki/Web_scraping', markdown: true });
  // Zyte's and xyte's markdown differ in style (title heading, link titles); compare content.
  return [r.status === 200 && /\[Data scraping\]\(https:\/\/en\.wikipedia\.org\/wiki\/Data_scraping/.test(r.json.markdown ?? ''), `${r.json.markdown?.length} chars`];
});

await check('browserHtml + httpResponseBody is 422 /request/unprocessable', async () => {
  const r = await call({ url: 'https://example.com', browserHtml: true, httpResponseBody: true });
  return [r.status === 422 && r.json.type === '/request/unprocessable', `${r.status} ${r.json?.type}`];
});

await check('a relative url is 400 /request/invalid', async () => {
  const r = await call({ url: '/foo', httpResponseBody: true });
  return [r.status === 400 && r.json.type === '/request/invalid', `${r.status} ${r.json?.type}`];
});

await check('a Cookie header is dropped, other headers kept', async () => {
  const r = await call({ url: 'https://httpbin.org/anything', httpResponseBody: true, customHttpRequestHeaders: [{ name: 'Cookie', value: 'a=b' }, { name: 'X-Kept', value: '1' }] });
  const headers = JSON.parse(decode(r.json.httpResponseBody)).headers;
  return [r.status === 200 && headers.Cookie === undefined && headers['X-Kept'] === '1', `Cookie=${headers.Cookie}, X-Kept=${headers['X-Kept']}`];
});

await check('a wrong key is 401 /auth/key-not-found', async () => {
  const r = await call({ url: 'https://example.com', httpResponseBody: true }, { key: 'wrong-key' });
  return [r.status === 401 && r.json?.type === '/auth/key-not-found', `${r.status} ${r.json?.type}`];
});

await check('invalid JSON is 400 /request/invalid-json', async () => {
  const r = await call(null, { raw: '{oops' });
  return [r.status === 400 && r.json?.type === '/request/invalid-json', `${r.status} ${r.json?.type}`];
});

// Direct connections see the DNS failure (421). Through a proxy it is the provider's error,
// retried like any proxy failure, then a 520.
await check(`an unresolvable domain is ${provider ? '520' : '421 /website/domain-unreachable'}`, async () => {
  const r = await call({ url: 'https://this-domain-does-not-exist-xyte-live.com', httpResponseBody: true });
  const ok = provider ? r.status === 520 : r.status === 421 && r.json?.type === '/website/domain-unreachable';
  return [ok, `${r.status} ${r.json?.type} ${r.ms} ms`];
});

await check('private targets are rejected', async () => {
  const r = await call({ url: 'http://169.254.169.254/latest/meta-data', httpResponseBody: true });
  return [r.status === 400, `${r.status} ${r.json?.detail}`];
}, { xyteOnly: true });

await check('an AI field without an extractor is a 400 that says so', async () => {
  const r = await call({ url: 'https://books.toscrape.com/catalogue/a-light-in-the-attic_1000/index.html', product: true });
  return [r.status === 400 && /extractor/.test(r.json?.detail ?? ''), `${r.status} ${r.json?.detail}`];
}, { xyteOnly: true });

console.log(`\n${passed} passed, ${failed} failed (${base}${provider ? `, provider ${provider}` : ''})`);
server?.kill();
process.exit(failed ? 1 : 0);
