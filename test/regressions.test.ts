// Regression tests for issues found in code review (one block per issue).
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { createHandler, decodeBody, proxyUrl, template, toNodeHandler, Xyte, isPrivateTarget } from '../src/index.ts';
import { SessionPool } from '../src/sessions.ts';
import { CookieJar, parseSetCookie, sessionToken } from '../src/util.ts';
import http from 'node:http';
import { startTarget } from './fixtures.ts';

setDefaultTimeout(30_000);
let target: ReturnType<typeof startTarget>;
const xyte = new Xyte({ retries: 1 });
beforeAll(() => {
  target = startTarget();
});
afterAll(async () => {
  await xyte.close();
  target.stop();
});

test('browser requests send the session cookies', async () => {
  const session = { id: 'browser-cookies' };
  await xyte.extract({ url: `${target.base}/set-cookie`, httpResponseBody: true, session });
  const res = await xyte.extract({ url: `${target.base}/echo`, browserHtml: true, session });
  expect(res.browserHtml).toMatch(/"cookie":"visit=\d+"/);
});

test('a proxy host that does not resolve is retried (520), not a 421 for the target', async () => {
  const error = await new Xyte({ retries: 1, proxy: proxyUrl('http://u:p@no-such-proxy.invalid:8080') })
    .extract({ url: `${target.base}/html`, httpResponseBody: true })
    .catch((e) => e);
  expect(error.status).toBe(520);
});

test('sessionContext retries avoid the session that was just banned', () => {
  const pool = new SessionPool({ size: 8 });
  const failed = new Set<string>();
  const ids: string[] = [];
  for (let attempt = 0; attempt < 4; attempt++) {
    const s = pool.acquire('k', failed);
    ids.push(s.id);
    pool.release(s, 'ban');
    failed.add(s.id);
  }
  expect(new Set(ids).size).toBe(4);
});

test('sessionContext: a full pool replaces an excluded session instead of reusing it', () => {
  const pool = new SessionPool({ size: 1 });
  const first = pool.acquire('k');
  pool.release(first, 'ban');
  expect(pool.acquire('k', new Set([first.id])).id).not.toBe(first.id);
});

describe('cookie jar', () => {
  test('host-only cookies are not sent to subdomains', () => {
    const jar = new CookieJar();
    jar.setFromHeaders(['a=1'], new URL('https://example.com/'));
    expect(jar.header(new URL('https://example.com/'))).toBe('a=1');
    expect(jar.header(new URL('https://sub.example.com/'))).toBeUndefined();
  });

  test('Domain for another site or a bare TLD is rejected', () => {
    const url = new URL('https://evil.example/');
    expect(parseSetCookie('x=1; Domain=bank.example', url)).toBeUndefined();
    expect(parseSetCookie('x=1; Domain=example', url)).toBeUndefined();
    expect(parseSetCookie('x=1; Domain=evil.example', url)?.hostOnly).toBe(false);
  });

  test('default path is the request directory', () => {
    expect(parseSetCookie('x=1', new URL('https://a.example/shop/cart/view'))?.cookie.path).toBe('/shop/cart');
    expect(parseSetCookie('x=1', new URL('https://a.example/index'))?.cookie.path).toBe('/');
  });

  test('end to end: planted cookies are dropped', async () => {
    const res = await xyte.extract({ url: `${target.base}/evil-cookies`, httpResponseBody: true, responseCookies: true });
    expect(res.responseCookies?.map((c) => c.name)).toEqual(['mine']);
  });

  test('merge keeps both sides', () => {
    const a = new CookieJar([{ name: 'a', value: '1', domain: 'x.example' }]);
    const b = new CookieJar([{ name: 'b', value: '2', domain: 'x.example' }]);
    a.merge(b);
    expect(a.header(new URL('https://x.example/'))).toBe('a=1; b=2');
  });
});

test('Authorization does not follow a redirect to another origin', async () => {
  const res = await xyte.extract({
    url: `${target.base}/to-localhost`,
    httpResponseBody: true,
    customHttpRequestHeaders: [
      { name: 'Authorization', value: 'Bearer secret' },
      { name: 'X-Keep', value: 'yes' },
    ],
  });
  const echo = JSON.parse(decodeBody(res.httpResponseBody!));
  expect(echo.headers.authorization).toBeUndefined();
  expect(echo.headers['x-keep']).toBe('yes');
});

test('a malformed Location returns the redirect instead of failing', async () => {
  const res = await xyte.extract({ url: `${target.base}/bad-location`, httpResponseBody: true });
  expect(res.statusCode).toBe(302);
});

test('bodies are capped at 10 MB while downloading', async () => {
  const res = await xyte.extract({ url: `${target.base}/big`, httpResponseBody: true });
  expect(Buffer.from(res.httpResponseBody!, 'base64').byteLength).toBe(10 * 1024 * 1024);
});

describe('server hardening', () => {
  test('oversized request bodies get a 413', async () => {
    const handler = createHandler(xyte, { maxBodyBytes: 100 });
    const res = await handler(new Request('http://x/v1/extract', { method: 'POST', body: JSON.stringify({ url: 'https://a.example/', pad: 'x'.repeat(200) }) }));
    expect(res.status).toBe(413);
  });

  test('the Node adapter caps bodies too', async () => {
    const server = http.createServer(toNodeHandler(createHandler(xyte), { maxBodyBytes: 100 }));
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const { port } = server.address() as { port: number };
    try {
      const res = await fetch(`http://127.0.0.1:${port}/v1/extract`, { method: 'POST', body: 'x'.repeat(500) });
      expect(res.status).toBe(413);
    } finally {
      server.close();
    }
  });

  test('blockPrivateTargets rejects internal addresses', async () => {
    const handler = createHandler(xyte, { blockPrivateTargets: true });
    const res = await handler(new Request('http://x/v1/extract', { method: 'POST', body: JSON.stringify({ url: 'http://169.254.169.254/latest/meta-data/', httpResponseBody: true }) }));
    expect(res.status).toBe(400);
    for (const url of ['http://localhost/', 'http://10.1.2.3/', 'http://192.168.0.1/', 'http://[::1]/', 'http://db.internal/']) {
      expect(isPrivateTarget(url)).toBe(true);
    }
    expect(isPrivateTarget('https://example.com/')).toBe(false);
  });

  test('xyte serve refuses a public interface without API keys', async () => {
    const proc = Bun.spawn(['bun', 'src/cli.ts', 'serve', '--host', '0.0.0.0', '--port', '0'], {
      env: { ...process.env, XYTE_API_KEYS: '', XYTE_ALLOW_ANONYMOUS: '' },
      stderr: 'pipe',
    });
    expect(await proc.exited).toBe(1);
    expect(await new Response(proc.stderr).text()).toContain('refusing to listen');
  });
});

test('session ids sharing a prefix get different tokens', () => {
  expect(sessionToken('customer-session-1')).not.toBe(sessionToken('customer-session-2'));
  expect(sessionToken('customer-session-1')).toBe(sessionToken('customer-session-1'));
});

describe('client input errors are 400s, config errors 500s, neither retried', () => {
  test('an invalid header value', async () => {
    const error = await xyte
      .extract({ url: `${target.base}/html`, httpResponseBody: true, customHttpRequestHeaders: [{ name: 'X-A', value: 'a\r\nb' }] })
      .catch((e) => e);
    expect(error.status).toBe(400);
  });

  test('a provider that cannot build its endpoint', async () => {
    const retries: number[] = [];
    const error = await new Xyte({ proxy: template('http://u-{country}:p@h:1'), onRetry: ({ attempt }) => retries.push(attempt) })
      .extract({ url: `${target.base}/html`, httpResponseBody: true })
      .catch((e) => e);
    expect(error.status).toBe(500);
    expect(retries).toEqual([]);
  });
});

test('template() keeps IPv6 hosts', async () => {
  const endpoint = await template('http://u[-{country}]:p@[::1]:8080').resolve({
    url: new URL('https://a.example/'),
    sessionId: 's',
    attempt: 0,
    browser: false,
  });
  expect(endpoint!.url).toBe('http://u:p@[::1]:8080');
});
