import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { chromium } from 'playwright';
import { decodeBody, proxyUrl, Xyte } from '../src/index.ts';
import { startProxy, startTarget } from './fixtures.ts';

let target: ReturnType<typeof startTarget>;
let proxy: Awaited<ReturnType<typeof startProxy>>;
const xyte = new Xyte({ retries: 0 });
setDefaultTimeout(30_000);

beforeAll(async () => {
  target = startTarget();
  proxy = await startProxy({ password: 'secret' });
});
afterAll(async () => {
  await xyte.close();
  target.stop();
  await proxy.stop();
});

describe('browser requests', () => {
  test('browserHtml is the rendered DOM', async () => {
    const res = await xyte.extract({
      url: `${target.base}/app`,
      browserHtml: true,
      actions: [{ action: 'waitForSelector', selector: { type: 'css', value: '#done' } }],
    });
    expect(res.statusCode).toBe(200);
    expect(res.browserHtml).toContain('<p id="done">secret 42</p>');
    expect(res.actions).toEqual([expect.objectContaining({ action: 'waitForSelector', status: 'success' })]);
  });

  test('evaluate + waitForSelector (the DoorDash lookup shape)', async () => {
    const res = await xyte.extract({
      url: `${target.base}/html`,
      browserHtml: true,
      actions: [
        { action: 'waitForTimeout', timeout: 0.1 },
        {
          action: 'evaluate',
          source: `const out = document.createElement('pre'); out.id = 'zout';
            setTimeout(() => { out.textContent = btoa('{"ok":true}'); document.body.appendChild(out); }, 200);`,
        },
        { action: 'waitForSelector', selector: { type: 'css', value: '#zout' }, timeout: 5, onError: 'continue' },
      ],
    });
    const encoded = res.browserHtml?.match(/<pre id="zout">([^<]*)<\/pre>/)?.[1];
    expect(JSON.parse(atob(encoded!))).toEqual({ ok: true });
    expect(res.actions?.map((a) => a.status)).toEqual(['success', 'success', 'success']);
  });

  test('networkCapture returns matching responses, base64', async () => {
    const res = await xyte.extract({
      url: `${target.base}/app`,
      browserHtml: true,
      networkCapture: [{ filterType: 'url', matchType: 'contains', value: '/api/data', httpResponseBody: true }],
      actions: [{ action: 'waitForSelector', selector: { type: 'css', value: '#done' } }],
    });
    expect(res.networkCapture).toHaveLength(1);
    const [capture] = res.networkCapture!;
    expect(capture!.statusCode).toBe(200);
    expect(JSON.parse(decodeBody(capture!.httpResponseBody!))).toEqual({ secret: 42 });
  });

  test('a failing action stops the sequence by default; onError: continue goes on', async () => {
    const res = await xyte.extract({
      url: `${target.base}/html`,
      browserHtml: true,
      actions: [
        { action: 'waitForSelector', selector: { type: 'css', value: '#never' }, timeout: 0.2, onError: 'continue' },
        { action: 'click', selector: { type: 'css', value: '#never' } },
        { action: 'scrollBottom' },
      ],
    });
    expect(res.actions?.map((a) => a.status)).toEqual(['continued', 'returned', 'notExecuted']);
    expect(res.actions?.[0]?.error).toBeString();
    expect(res.browserHtml).toContain('hello');
  });

  test('screenshot', async () => {
    const res = await xyte.extract({ url: `${target.base}/html`, screenshot: true, screenshotOptions: { format: 'png' } });
    expect(Buffer.from(res.screenshot!, 'base64').subarray(1, 4).toString()).toBe('PNG');
    expect(res.browserHtml).toBeUndefined();
  });

  test('requestCookies and responseCookies', async () => {
    const res = await xyte.extract({
      url: `${target.base}/landing`,
      browserHtml: true,
      responseCookies: true,
      requestCookies: [{ name: 'step', value: 'seed', domain: '127.0.0.1' }],
    });
    expect(res.browserHtml).toContain('cookie=step=seed');
    expect(res.responseCookies?.map((c) => c.name).sort()).toEqual(['final', 'step']);
  });

  test('renders through the proxy', async () => {
    const proxied = new Xyte({
      retries: 0,
      proxy: proxyUrl(`http://carol:secret@127.0.0.1:${proxy.port}`),
      // Chromium never proxies loopback unless told to.
      browser: { launch: () => chromium.launch({ args: ['--proxy-bypass-list=<-loopback>'] }) },
    });
    try {
      const res = await proxied.extract({ url: `${target.base}/html`, browserHtml: true, httpResponseHeaders: true });
      expect(res.browserHtml).toContain('hello');
      expect(res.httpResponseHeaders).toContainEqual({ name: 'x-via-proxy', value: '1' });
      expect(proxy.usernames).toContain('carol');
    } finally {
      await proxied.close();
    }
  });
});
