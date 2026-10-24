import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Xyte } from './client.ts';
import { XyteError } from './errors.ts';
import type { ExtractRequest } from './types.ts';

export interface HandlerOptions {
  /**
   * Accepted API keys, sent like Zyte's: HTTP basic auth with the key as the username. When
   * empty or omitted, any (or no) key is accepted.
   */
  apiKeys?: readonly string[];
  /**
   * Where the routes live, e.g. `/zyte` for `/zyte/v1/extract`. Default: any path ending in
   * `/v1/extract` (or `/healthz`), so the handler works mounted under a prefix whether or not the
   * framework strips it.
   */
  basePath?: string;
  /** Largest accepted request body. Default 10 MB. */
  maxBodyBytes?: number;
  /**
   * Reject targets on loopback, private, link-local and cloud-metadata addresses (IP literals,
   * `localhost`, `*.local`, `*.internal`), so a public endpoint can't be aimed at your internal
   * network. Hostnames that *resolve* to private IPs are not caught; with a proxy provider, the
   * proxy's network is what's reachable anyway. Default false; `xyte serve` turns it on.
   */
  blockPrivateTargets?: boolean;
}

const DEFAULT_MAX_BODY = 10 * 1024 * 1024;

export type FetchHandler = (request: Request) => Promise<Response>;

/**
 * A Web-standard handler serving Zyte's HTTP API: `POST /v1/extract`. Mount it with `Bun.serve`,
 * Deno, Hono, a Cloudflare Worker… then point existing Zyte code at it by changing only the base
 * URL (`https://api.zyte.com/v1/extract` → `http://localhost:8011/v1/extract`).
 */
export function createHandler(xyte: Xyte, options: HandlerOptions = {}): FetchHandler {
  const keys = new Set(options.apiKeys ?? []);
  const base = options.basePath?.replace(/\/+$/, '');
  const maxBody = options.maxBodyBytes ?? DEFAULT_MAX_BODY;
  const route = (pathname: string, path: string) =>
    base != null ? pathname === `${base}${path}` : pathname === path || pathname.endsWith(path);

  return async (request) => {
    const { pathname } = new URL(request.url);
    if (route(pathname, '/healthz')) return new Response('ok');
    if (!route(pathname, '/v1/extract')) {
      return problem({ status: 404, type: '/request/not-found', title: 'Not Found', detail: `no route ${pathname}` });
    }
    if (request.method !== 'POST') {
      return problem({ status: 405, type: '/request/invalid', title: 'Method Not Allowed', detail: 'use POST' });
    }
    if (keys.size > 0 && !keys.has(apiKeyOf(request) ?? '')) {
      return problem({ status: 401, type: '/auth/key-not-found', title: 'Authentication Key Not Found' });
    }

    const text = await readText(request, maxBody);
    if (text == null) {
      return problem({ status: 413, type: '/request/too-large', title: 'Payload Too Large', detail: `limit is ${maxBody} bytes` });
    }
    let body: ExtractRequest;
    try {
      body = JSON.parse(text) as ExtractRequest;
    } catch {
      return problem({ status: 400, type: '/request/invalid-json', title: 'Invalid JSON' });
    }
    if (body == null || typeof body !== 'object' || Array.isArray(body)) {
      return problem({ status: 400, type: '/request/invalid', title: 'Invalid Request', detail: 'body must be an object' });
    }
    if (options.blockPrivateTargets && typeof body.url === 'string' && isPrivateTarget(body.url)) {
      return problem({ status: 400, type: '/request/invalid', title: 'Invalid Request', detail: 'private and internal addresses are not allowed' });
    }

    try {
      // A caller that hangs up cancels the scrape.
      return Response.json(await xyte.extract(body, { signal: request.signal }));
    } catch (error) {
      if (error instanceof XyteError) return problem(error.toJSON());
      return problem({
        status: 500,
        type: '/server/internal',
        title: 'Internal Server Error',
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  };
}

/** The body as text, or undefined past `max` bytes. */
async function readText(request: Request, max: number): Promise<string | undefined> {
  const declared = Number(request.headers.get('content-length') ?? NaN);
  if (Number.isFinite(declared) && declared > max) return undefined;
  if (!request.body) return '';
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel().catch(() => {});
      return undefined;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** Loopback, RFC 1918, link-local (incl. 169.254.169.254), CGNAT, ULA, and internal names. */
export function isPrivateTarget(target: string): boolean {
  let host: string;
  try {
    host = new URL(target).hostname.toLowerCase().replace(/^\[|\]$/g, '');
  } catch {
    return false;
  }
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) return true;
  if (host === 'metadata.google.internal') return true;
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    return (
      a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127)
    );
  }
  if (host.includes(':')) {
    return host === '::1' || host === '::' || /^f[cd]/.test(host) || /^fe[89ab]/.test(host) || host.startsWith('::ffff:');
  }
  return false;
}

function problem(body: { status: number; type: string; title: string; detail?: string }): Response {
  return Response.json(body, { status: body.status, headers: { 'content-type': 'application/problem+json' } });
}

function apiKeyOf(request: Request): string | undefined {
  const header = request.headers.get('authorization');
  if (!header?.toLowerCase().startsWith('basic ')) return undefined;
  try {
    return atob(header.slice(6).trim()).split(':')[0];
  } catch {
    return undefined;
  }
}

/**
 * Adapts a fetch handler to Node's `(req, res)` signature, for `node:http`, Express, Fastify
 * (`reply.hijack()` first) or Next.js API routes:
 *
 *     app.use('/zyte', toNodeHandler(createHandler(xyte)));
 *
 * A body already parsed by middleware (e.g. `express.json()`) is re-serialized.
 */
export function toNodeHandler(
  handler: FetchHandler,
  options: { maxBodyBytes?: number } = {},
): (req: IncomingMessage & { body?: unknown }, res: ServerResponse) => Promise<void> {
  const maxBody = options.maxBodyBytes ?? DEFAULT_MAX_BODY;
  return async (req, res) => {
    const abort = new AbortController();
    res.on('close', () => {
      if (!res.writableFinished) abort.abort();
    });
    try {
      const headers = new Headers();
      for (const [name, value] of Object.entries(req.headers)) {
        if (typeof value === 'string') headers.set(name, value);
        else if (Array.isArray(value)) for (const v of value) headers.append(name, v);
      }
      const hasBody = req.method !== 'GET' && req.method !== 'HEAD';
      let body: Buffer | undefined;
      if (hasBody && req.body !== undefined) {
        body = Buffer.isBuffer(req.body)
          ? req.body
          : Buffer.from(typeof req.body === 'string' ? req.body : JSON.stringify(req.body));
        headers.delete('content-length');
      } else if (hasBody) {
        const chunks: Buffer[] = [];
        let size = 0;
        for await (const chunk of req) {
          size += (chunk as Buffer).byteLength;
          if (size > maxBody) {
            res.writeHead(413, { 'content-type': 'application/problem+json' });
            res.end(JSON.stringify({ status: 413, type: '/request/too-large', title: 'Payload Too Large' }));
            req.destroy();
            return;
          }
          chunks.push(chunk as Buffer);
        }
        body = Buffer.concat(chunks);
      }
      const request = new Request(`http://${req.headers.host ?? 'localhost'}${req.url ?? '/'}`, {
        method: req.method,
        headers,
        body: body ? new Uint8Array(body) : undefined,
        signal: abort.signal,
      });
      const response = await handler(request);
      res.writeHead(response.status, Object.fromEntries(response.headers));
      res.end(Buffer.from(await response.arrayBuffer()));
    } catch (error) {
      if (res.headersSent) return void res.end();
      res.writeHead(500, { 'content-type': 'text/plain' });
      res.end(String(error));
    }
  };
}

/**
 * Serves `handler` on Bun (`Bun.serve`) or Node.js (`node:http`). Returns a function that stops
 * the server.
 */
export async function serve(
  handler: FetchHandler,
  options: { port?: number; hostname?: string } = {},
): Promise<{ url: string; stop: () => Promise<void> }> {
  const port = options.port ?? 8011;
  const hostname = options.hostname ?? '127.0.0.1';
  const bun = (globalThis as { Bun?: typeof import('bun') }).Bun;

  if (bun) {
    // Scrapes outlive Bun's default 10s idle timeout.
    const server = bun.serve({ port, hostname, fetch: handler, idleTimeout: 255 });
    return { url: server.url.toString(), stop: () => server.stop() };
  }

  const http = await import('node:http');
  const server = http.createServer(toNodeHandler(handler));
  server.requestTimeout = 0;
  await new Promise<void>((resolve) => server.listen(port, hostname, resolve));
  const { port: boundPort } = server.address() as { port: number };
  return {
    url: `http://${hostname}:${boundPort}/`,
    stop: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
