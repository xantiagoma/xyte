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
        case '/api/data':
          return Response.json({ secret: 42 });
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
