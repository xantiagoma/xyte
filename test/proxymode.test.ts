import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { X509Certificate } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCertificateAuthority, issueCertificate, proxiedRequest, serveProxyMode, Xyte } from '../src/index.ts';
import { startTarget } from './fixtures.ts';

setDefaultTimeout(30_000);
let target: ReturnType<typeof startTarget>;
let proxy: Awaited<ReturnType<typeof serveProxyMode>>;
let caFile: string;
beforeAll(async () => {
  target = startTarget();
  proxy = await serveProxyMode(new Xyte({ retries: 0 }), { apiKeys: ['key'], port: 0 });
  caFile = join(mkdtempSync(join(tmpdir(), 'xyte-ca-')), 'ca.pem');
  writeFileSync(caFile, proxy.caCert);
});
afterAll(async () => {
  await proxy.stop();
  target.stop();
});

async function curl(...args: string[]) {
  const proc = Bun.spawn(['curl', '-s', '-D', '-', '-x', `http://127.0.0.1:${proxy.port}`, ...args], { stdout: 'pipe', stderr: 'pipe' });
  const out = await new Response(proc.stdout).text();
  await proc.exited;
  const [head = '', ...body] = out.split('\r\n\r\n').filter((part) => !part.startsWith('HTTP/1.1 200 Connection Established'));
  return { status: Number(/^HTTP\/[\d.]+ (\d+)/.exec(head)?.[1]), head: head.toLowerCase(), body: body.join('\r\n\r\n') };
}

describe('certificate authority', () => {
  test('per-site certificates signed by the CA, for names and IPs', () => {
    const ca = createCertificateAuthority();
    const caCert = new X509Certificate(ca.cert);
    expect(caCert.ca).toBe(true);
    for (const host of ['shop.example', '127.0.0.1']) {
      const leaf = new X509Certificate(issueCertificate(ca, host).cert);
      expect(leaf.verify(caCert.publicKey)).toBe(true);
      expect(leaf.ca).toBe(false);
      expect(host.includes('.example') ? leaf.checkHost(host) : leaf.checkIP(host)).toBe(host);
    }
  });
});

describe('proxy mode', () => {
  test('plain http: the site gets the request, the client the site’s response and a Zyte-Request-ID', async () => {
    const res = await curl('-U', 'key:', `${target.base}/echo`, '-H', 'X-Test: 1', '-H', 'Cookie: a=b');
    expect(res.status).toBe(200);
    expect(res.head).toContain('zyte-request-id:');
    const echoed = JSON.parse(res.body).headers;
    expect(echoed['x-test']).toBe('1');
    expect(echoed.cookie).toBe('a=b');
  });

  test('https through CONNECT, trusting only the proxy’s CA', async () => {
    const res = await curl('-U', 'key:', '--cacert', caFile, 'https://example.com/');
    expect(res.status).toBe(200);
    expect(res.body).toContain('Example Domain');
  });

  test('the target’s own status passes through; errors carry Zyte-Error-Type', async () => {
    expect((await curl('-U', 'key:', `${target.base}/missing`)).status).toBe(404);
    const banned = await curl('-U', 'key:', `${target.base}/forbidden`);
    expect(banned.status).toBe(520);
    expect(banned.head).toContain('zyte-error-type: /download/website-ban');
    expect(JSON.parse(banned.body)).toMatchObject({ status: 520 });
  });

  test('a wrong key is a 407; forbidden headers a 400', async () => {
    expect((await curl('-U', 'bad:', `${target.base}/html`)).status).toBe(407);
    const forwarded = await curl('-U', 'key:', `${target.base}/html`, '-H', 'X-Forwarded-For: 1.2.3.4');
    expect(forwarded.status).toBe(400);
  });
});

test('Zyte-* headers become the request', () => {
  const request = proxiedRequest(
    'https://shop.example/p',
    'POST',
    {
      'zyte-geolocation': 'DE',
      'zyte-session-id': 's1',
      'zyte-device': 'mobile',
      'zyte-tags': '{"spider":"yelp"}',
      'zyte-override-headers': 'User-Agent',
      'user-agent': 'mine',
      accept: 'dropped unless overridden',
      'content-type': 'application/json',
      cookie: 'a=b; c=d',
      'proxy-authorization': 'Basic x',
    },
    Buffer.from('{"q":1}'),
  );
  expect(request).toMatchObject({
    url: 'https://shop.example/p',
    httpResponseBody: true,
    httpResponseHeaders: true,
    httpRequestMethod: 'POST',
    httpRequestBody: btoa('{"q":1}'),
    geolocation: 'DE',
    session: { id: 's1' },
    device: 'mobile',
    tags: { spider: 'yelp' },
    requestCookies: [
      { name: 'a', value: 'b', domain: 'shop.example' },
      { name: 'c', value: 'd', domain: 'shop.example' },
    ],
  });
  expect(request.customHttpRequestHeaders).toEqual([
    { name: 'user-agent', value: 'mine' },
    { name: 'content-type', value: 'application/json' },
  ]);
  expect(proxiedRequest('https://x.example/', 'GET', { 'zyte-browser-html': 'true' }, Buffer.alloc(0))).toMatchObject({ browserHtml: true });
});
