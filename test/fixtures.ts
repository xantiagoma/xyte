import http from 'node:http';

/** A target site with the behaviours the tests need. */
export function startTarget() {
  const hits = new Map<string, number>();
  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    async fetch(req) {
      const url = new URL(req.url);
      hits.set(url.pathname, (hits.get(url.pathname) ?? 0) + 1);
      const count = hits.get(url.pathname)!;

      switch (url.pathname) {
        case '/html':
          return new Response('<html><body><h1>hello</h1></body></html>', {
            headers: { 'content-type': 'text/html; charset=utf-8', 'x-test': 'yes' },
          });
        case '/echo':
          return Response.json({
            method: req.method,
            headers: Object.fromEntries(req.headers),
            body: await req.text(),
          });
        case '/redirect':
          return new Response(null, {
            status: 302,
            headers: { location: '/landing', 'set-cookie': 'step=1; Path=/' },
          });
        case '/landing':
          return new Response(`cookie=${req.headers.get('cookie') ?? ''}`, {
            headers: { 'set-cookie': 'final=2; Path=/; HttpOnly' },
          });
        case '/set-cookie':
          return new Response('set', { headers: { 'set-cookie': `visit=${count}; Path=/` } });
        case '/missing':
          return new Response('nope', { status: 404 });
        case '/forbidden':
          return new Response('blocked', { status: 403 });
        case '/challenge':
          return new Response('<html><head><title>Just a moment...</title></head></html>', {
            headers: { 'content-type': 'text/html' },
          });
        case '/flaky':
          // Banned twice, then fine.
          return count <= 2 ? new Response('blocked', { status: 403 }) : new Response('finally');
        case '/frames':
          return new Response('<html><body><p>outer</p><iframe src="/html"></iframe></body></html>', {
            headers: { 'content-type': 'text/html' },
          });
        case '/to-localhost':
          // Same server, different origin (127.0.0.1 → localhost).
          return new Response(null, { status: 302, headers: { location: `http://localhost:${url.port}/echo` } });
        case '/bad-location':
          return new Response('moved', { status: 302, headers: { location: 'http://[bad' } });
        case '/evil-cookies':
          return new Response('ok', {
            headers: [
              ['set-cookie', 'other=1; Domain=bank.example'],
              ['set-cookie', 'tld=1; Domain=com'],
              ['set-cookie', 'mine=1'],
            ],
          });
        case '/big':
          return new Response('x'.repeat(12 * 1024 * 1024));
        case '/spb-ok':
          // What ScrapingBee answers after following a redirect itself.
          return new Response('final page', {
            headers: { 'resolved-url': `${url.origin}/landing`, 'spb-cost': '10', 'initial-status-code': '200', 'x-real': '1' },
          });
        case '/spb-error':
          // ScrapingBee's own error (unresolvable domain, target 5xx): unbilled.
          return Response.json({ error: 'Error with your request', reason: 'Server responded with 613' }, { status: 500, headers: { 'spb-cost': '0' } });
        case '/js-challenge':
          // A JavaScript challenge: plain HTTP clients never get past the 403.
          if (req.headers.get('cookie')?.includes('passed=1')) {
            return new Response('<html><body><h1>real page</h1></body></html>', { headers: { 'content-type': 'text/html' } });
          }
          return new Response(
            `<html><head><title>Just a moment...</title></head><body><script>document.cookie = 'passed=1; path=/'; location.reload();</script></body></html>`,
            { status: 403, headers: { 'content-type': 'text/html' } },
          );
        case '/noise':
          // A realistically sized page (~200 KB, uncompressed) whose script fetches more data.
          return new Response(
            `<html><body><pre>${NOISE}</pre><script>fetch('/api/data')</script></body></html>`,
            { headers: { 'content-type': 'text/html' } },
          );
        case '/gzip-chunked': {
          // Compressed and streamed: no Content-Length, as most dynamic pages are served.
          const gz = Bun.gzipSync(`<html><body>${NOISE.slice(0, 50_000)}${'<p>same paragraph again</p>'.repeat(4000)}</body></html>`);
          const stream = new ReadableStream({
            start(controller) {
              controller.enqueue(gz.subarray(0, gz.length >> 1));
              controller.enqueue(gz.subarray(gz.length >> 1));
              controller.close();
            },
          });
          return new Response(stream, { headers: { 'content-type': 'text/html', 'content-encoding': 'gzip' } });
        }
        case '/search-page':
          return new Response(
            `<html><body><header><form action="/results"><input type="search" name="q" placeholder="Search"></form></header><p id="loc"></p></body></html>`,
            { headers: { 'content-type': 'text/html' } },
          );
        case '/search-toggle':
          // The box only appears once the search icon is clicked.
          return new Response(
            `<html><body><button aria-label="Open search" onclick="document.getElementById('f').style.display='block'">🔍</button>
             <form id="f" action="/results" style="display:none"><input name="query" placeholder="What are you looking for?"></form></body></html>`,
            { headers: { 'content-type': 'text/html' } },
          );
        case '/results': {
          const q = url.searchParams.get('q') ?? url.searchParams.get('query') ?? '';
          return new Response(`<html><body><h1>Results for ${q.replace(/[<>&]/g, '')}</h1></body></html>`, { headers: { 'content-type': 'text/html' } });
        }
        case '/ipinfo':
          // Like ipinfo.io/json, for `xyte doctor`.
          return Response.json({ ip: '203.0.113.7', country: 'AR', city: 'Rosario', org: 'AS0 Test Net' });
        case '/gzip':
          // 200 KB of HTML that compresses to a few KB.
          return new Response(Bun.gzipSync(`<html><body>${'<p>same paragraph again</p>'.repeat(8000)}</body></html>`), {
            headers: { 'content-type': 'text/html', 'content-encoding': 'gzip' },
          });
        case '/api/data':
          return Response.json({ secret: 42 });
        case '/api/slow':
          return new Promise<Response>((resolve) => setTimeout(() => resolve(Response.json({ secret: 7 })), 400));
        case '/late-app':
          // Fetches its data only after the load event, from a slow endpoint.
          return new Response(
            `<html><body><script>
              addEventListener('load', () => setTimeout(() => fetch('/api/slow').then(r => r.json()).then(d => {
                const el = document.createElement('p'); el.id = 'late'; el.textContent = 'late ' + d.secret;
                document.body.appendChild(el);
              }), 100));
            </script></body></html>`,
            { headers: { 'content-type': 'text/html' } },
          );
        case '/app':
          return new Response(
            `<html><body><div id="root">loading</div><script>
              fetch('/api/data').then(r => r.json()).then(d => {
                const el = document.createElement('p'); el.id = 'done'; el.textContent = 'secret ' + d.secret;
                document.body.appendChild(el);
              });
            </script></body></html>`,
            { headers: { 'content-type': 'text/html' } },
          );
        default:
          return new Response('not found', { status: 404 });
      }
    },
  });
  const base = `http://127.0.0.1:${server.port}`;
  return { server, base, hits, stop: () => server.stop(true) };
}

/**
 * A forward HTTP proxy (absolute-form requests, which is what HTTP clients send for http:// URLs
 * through a proxy) with basic auth. Records the username of every request.
 */
/**
 * A TCP relay in front of a port that counts every byte both ways: the reference for what a
 * per-GB proxy would bill.
 */
const NOISE = Array.from({ length: 25_000 }, (_, i) => ((i * 2654435761) >>> 0).toString(16).padStart(8, '0')).join('');

export async function startByteCounter(port: number) {
  const net = await import('node:net');
  let bytes = 0;
  const server = net.createServer((client) => {
    const upstream = net.connect(port, '127.0.0.1');
    client.on('data', (chunk) => {
      bytes += chunk.length;
      upstream.write(chunk);
    });
    upstream.on('data', (chunk) => {
      bytes += chunk.length;
      client.write(chunk);
    });
    client.on('close', () => upstream.destroy());
    upstream.on('close', () => client.destroy());
    client.on('error', () => upstream.destroy());
    upstream.on('error', () => client.destroy());
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    port: (server.address() as { port: number }).port,
    bytes: () => bytes,
    stop: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

export async function startProxy(options: { password?: string } = {}) {
  const usernames: string[] = [];
  const server = http.createServer((req, res) => {
    const auth = req.headers['proxy-authorization'];
    const [user = '', pass = ''] = auth?.startsWith('Basic ')
      ? Buffer.from(auth.slice(6), 'base64').toString().split(/:(.*)/s)
      : [];
    usernames.push(user);
    if (options.password != null && pass !== options.password) {
      res.writeHead(407, { 'proxy-authenticate': 'Basic realm="test"' });
      res.end();
      return;
    }
    const target = new URL(req.url!);
    const headers = { ...req.headers };
    delete headers['proxy-authorization'];
    delete headers['proxy-connection'];
    const upstream = http.request(
      { host: target.hostname, port: target.port, path: target.pathname + target.search, method: req.method, headers },
      (up) => {
        res.writeHead(up.statusCode ?? 502, { ...up.headers, 'x-via-proxy': '1' });
        up.pipe(res);
      },
    );
    upstream.on('error', () => {
      res.writeHead(502);
      res.end();
    });
    req.pipe(upstream);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as { port: number };
  return {
    port,
    usernames,
    stop: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
