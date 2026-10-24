import type { Xyte } from './client.ts';
import { XyteError } from './errors.ts';
import type { ExtractRequest } from './types.ts';

export interface HandlerOptions {
  /**
   * Accepted API keys, sent like Zyte's: HTTP basic auth with the key as the username. When
   * empty or omitted, any (or no) key is accepted.
   */
  apiKeys?: readonly string[];
}

/**
 * A Web-standard handler serving Zyte's HTTP API: `POST /v1/extract`. Mount it with `Bun.serve`,
 * Deno, Hono, a Cloudflare Worker… then point existing Zyte code at it by changing only the base
 * URL (`https://api.zyte.com/v1/extract` → `http://localhost:8011/v1/extract`).
 */
export function createHandler(xyte: Xyte, options: HandlerOptions = {}): (request: Request) => Promise<Response> {
  const keys = new Set(options.apiKeys ?? []);

  return async (request) => {
    const { pathname } = new URL(request.url);
    if (pathname === '/healthz') return new Response('ok');
    if (pathname !== '/v1/extract') {
      return problem({ status: 404, type: '/request/not-found', title: 'Not Found', detail: `no route ${pathname}` });
    }
    if (request.method !== 'POST') {
      return problem({ status: 405, type: '/request/invalid', title: 'Method Not Allowed', detail: 'use POST' });
    }
    if (keys.size > 0 && !keys.has(apiKeyOf(request) ?? '')) {
      return problem({ status: 401, type: '/auth/key-not-found', title: 'Authentication Key Not Found' });
    }

    let body: ExtractRequest;
    try {
      body = (await request.json()) as ExtractRequest;
    } catch {
      return problem({ status: 400, type: '/request/invalid-json', title: 'Invalid JSON' });
    }
    if (body == null || typeof body !== 'object' || Array.isArray(body)) {
      return problem({ status: 400, type: '/request/invalid', title: 'Invalid Request', detail: 'body must be an object' });
    }

    try {
      return Response.json(await xyte.extract(body));
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
 * Serves `handler` on Bun (`Bun.serve`) or Node.js (`node:http`). Returns a function that stops
 * the server.
 */
export async function serve(
  handler: (request: Request) => Promise<Response>,
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
  const server = http.createServer(async (req, res) => {
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      const headers = new Headers();
      for (const [name, value] of Object.entries(req.headers)) {
        if (typeof value === 'string') headers.set(name, value);
        else if (Array.isArray(value)) for (const v of value) headers.append(name, v);
      }
      const request = new Request(`http://${req.headers.host ?? `${hostname}:${port}`}${req.url ?? '/'}`, {
        method: req.method,
        headers,
        body: req.method === 'GET' || req.method === 'HEAD' ? undefined : Buffer.concat(chunks),
      });
      const response = await handler(request);
      res.writeHead(response.status, Object.fromEntries(response.headers));
      res.end(Buffer.from(await response.arrayBuffer()));
    } catch (error) {
      res.writeHead(500, { 'content-type': 'text/plain' });
      res.end(String(error));
    }
  });
  server.requestTimeout = 0;
  await new Promise<void>((resolve) => server.listen(port, hostname, resolve));
  const { port: boundPort } = server.address() as { port: number };
  return {
    url: `http://${hostname}:${boundPort}/`,
    stop: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
