// Runs the built package (dist/) on Node.js: `node --test test/node/smoke.mjs`. No Bun anywhere.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import http from 'node:http';
import { after, before, describe, test } from 'node:test';
import { promisify } from 'node:util';
import { createHandler, decodeBody, proxyUrl, serve, serveProxyMode, Xyte } from '../../dist/index.mjs';

const run = promisify(execFile);
let target;
let proxy;
const proxyUsers = [];

const listen = (server) =>
  new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));

before(async () => {
  const targetServer = http.createServer((req, res) => {
    if (req.url === '/redirect') {
      res.writeHead(302, { location: '/html', 'set-cookie': 'a=1; Path=/' });
      return res.end();
    }
    if (req.url === '/forbidden') {
      res.writeHead(403);
      return res.end('blocked');
    }
    res.writeHead(200, { 'content-type': 'text/html', 'x-cookie': req.headers.cookie ?? '' });
    res.end('<html><body><h1>hello node</h1></body></html>');
  });
  target = { server: targetServer, base: `http://127.0.0.1:${await listen(targetServer)}` };

  const proxyServer = http.createServer((req, res) => {
    const auth = req.headers['proxy-authorization'] ?? '';
    const [user, pass] = Buffer.from(auth.replace(/^Basic /, ''), 'base64').toString().split(':');
    proxyUsers.push(user);
    if (pass !== 'secret') {
      res.writeHead(407);
      return res.end();
    }
    const url = new URL(req.url);
    const upstream = http.request(
      { host: url.hostname, port: url.port, path: url.pathname, method: req.method, headers: req.headers },
      (up) => {
        res.writeHead(up.statusCode, { ...up.headers, 'x-via-proxy': '1' });
        up.pipe(res);
      },
    );
    req.pipe(upstream);
  });
  proxy = { server: proxyServer, port: await listen(proxyServer) };
});

after(() => {
  target.server.close();
  proxy.server.close();
});

describe('xyte on Node.js', () => {
  test('direct HTTP request, redirects and cookies', async () => {
    const res = await new Xyte().extract({ url: `${target.base}/redirect`, httpResponseBody: true, httpResponseHeaders: true });
    assert.equal(res.statusCode, 200);
    assert.equal(res.url, `${target.base}/html`);
    assert.match(decodeBody(res.httpResponseBody), /hello node/);
    assert.ok(res.httpResponseHeaders.some((h) => h.name === 'x-cookie' && h.value === 'a=1'));
  });

  test('through an authenticated proxy (undici ProxyAgent)', async () => {
    const xyte = new Xyte({ proxy: proxyUrl(`http://nodeuser:secret@127.0.0.1:${proxy.port}`) });
    const res = await xyte.extract({ url: `${target.base}/html`, httpResponseBody: true, httpResponseHeaders: true });
    assert.ok(res.httpResponseHeaders.some((h) => h.name === 'x-via-proxy'));
    assert.equal(proxyUsers.at(-1), 'nodeuser');
  });

  test('proxy 407 becomes a 520 after retries', async () => {
    const xyte = new Xyte({ retries: 1, proxy: proxyUrl(`http://nodeuser:wrong@127.0.0.1:${proxy.port}`) });
    await assert.rejects(xyte.extract({ url: `${target.base}/html`, httpResponseBody: true }), (error) => {
      assert.equal(error.status, 520);
      assert.match(error.detail, /407/);
      return true;
    });
  });

  test('serve() on node:http speaks the Zyte HTTP API', async () => {
    const server = await serve(createHandler(new Xyte({ retries: 0 })), { port: 0 });
    try {
      const base = server.url;
      const ok = await fetch(`${base}v1/extract`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Basic ${btoa('any:')}` },
        body: JSON.stringify({ url: `${target.base}/html`, httpResponseBody: true }),
      });
      assert.equal(ok.status, 200);
      assert.match(decodeBody((await ok.json()).httpResponseBody), /hello node/);

      const banned = await fetch(`${base}v1/extract`, {
        method: 'POST',
        body: JSON.stringify({ url: `${target.base}/forbidden`, httpResponseBody: true }),
      });
      assert.equal(banned.status, 520);
      assert.equal((await banned.json()).type, '/download/website-ban');
    } finally {
      await server.stop();
    }
  });

  test('browser rendering with playwright', { timeout: 60_000 }, async () => {
    const xyte = new Xyte({ retries: 0 });
    try {
      const res = await xyte.extract({
        url: `${target.base}/html`,
        browserHtml: true,
        actions: [{ action: 'evaluate', source: 'document.body.dataset.ran = "yes"' }],
      });
      assert.match(res.browserHtml, /data-ran="yes"/);
      assert.equal(res.actions[0].status, 'success');
    } finally {
      await xyte.close();
    }
  });

  test('proxy mode on node:http: absolute-URL requests, auth, Zyte-Request-ID', async () => {
    const proxyMode = await serveProxyMode(new Xyte({ retries: 0 }), { apiKeys: ['key'], port: 0 });
    try {
      const get = (key) =>
        new Promise((resolve, reject) => {
          const req = http.request(
            { host: '127.0.0.1', port: proxyMode.port, path: `${target.base}/html`, headers: { 'proxy-authorization': `Basic ${Buffer.from(`${key}:`).toString('base64')}` } },
            (res) => {
              let body = '';
              res.on('data', (c) => (body += c));
              res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
            },
          );
          req.on('error', reject);
          req.end();
        });
      const ok = await get('key');
      assert.equal(ok.status, 200);
      assert.match(ok.body, /hello node/);
      assert.ok(ok.headers['zyte-request-id']);
      assert.equal((await get('bad')).status, 407);
    } finally {
      await proxyMode.stop();
    }
  });

  test('CLI: xyte extract --raw', async () => {
    const { stdout } = await run(process.execPath, ['dist/cli.mjs', 'extract', `${target.base}/html`, '--raw']);
    assert.match(stdout, /hello node/);
  });
});
