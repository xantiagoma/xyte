import type { IncomingMessage, ServerResponse } from 'node:http';
import type { RequestReport, Xyte } from './client.ts';
import { XyteError } from './errors.ts';
import { Jobs, type JobsOptions } from './jobs.ts';
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
  /**
   * `POST /v1/jobs` (a Zyte request plus an optional `callbackUrl`) answers `202 { id, status }`
   * at once; `GET /v1/jobs/{id}` returns the job, with the Zyte response when `done`; the
   * result is POSTed to `callbackUrl` when it finishes. Options: where jobs are kept, for how
   * long, the webhook secret. `false` turns the routes off. On by default, in memory.
   */
  jobs?: JobsOptions | false;
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
  const jobs = options.jobs === false ? undefined : new Jobs(xyte, options.jobs ?? {});
  const jobPath = new RegExp(`${base != null ? `^${escapeRegExp(base)}` : ''}/v1/jobs/([\\w-]+)$`);
  const notFound = (pathname: string) => problem({ status: 404, type: '/request/not-found', title: 'Not Found', detail: `no route ${pathname}` });
  const methodNotAllowed = (method: string) => problem({ status: 405, type: '/request/invalid', title: 'Method Not Allowed', detail: `use ${method}` });

  /** The request's Zyte JSON body, validated; or the problem response to send instead. */
  const readBody = async (request: Request): Promise<Record<string, unknown> | Response> => {
    const text = await readText(request, maxBody);
    if (text == null) {
      return problem({ status: 413, type: '/request/too-large', title: 'Payload Too Large', detail: `limit is ${maxBody} bytes` });
    }
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      return problem({ status: 400, type: '/request/invalid-json', title: 'Invalid JSON' });
    }
    if (body == null || typeof body !== 'object' || Array.isArray(body)) {
      return problem({ status: 400, type: '/request/invalid', title: 'Invalid Request', detail: 'body must be an object' });
    }
    const url = (body as { url?: unknown }).url;
    if (options.blockPrivateTargets && typeof url === 'string' && isPrivateTarget(url)) {
      return problem({ status: 400, type: '/request/invalid', title: 'Invalid Request', detail: 'private and internal addresses are not allowed' });
    }
    return body as Record<string, unknown>;
  };

  return async (request) => {
    const { pathname } = new URL(request.url);
    if (route(pathname, '/healthz')) return new Response('ok');
    const jobId = jobs ? jobPath.exec(pathname)?.[1] : undefined;
    const isExtract = route(pathname, '/v1/extract');
    const isJobs = jobs != null && route(pathname, '/v1/jobs');
    if (!isExtract && !isJobs && !jobId) return notFound(pathname);
    if (keys.size > 0 && !keys.has(apiKeyOf(request) ?? '')) {
      return problem({ status: 401, type: '/auth/key-not-found', title: 'Authentication Key Not Found' });
    }

    if (jobId) {
      if (request.method !== 'GET') return methodNotAllowed('GET');
      const job = await jobs!.get(jobId);
      return job ? Response.json(job) : problem({ status: 404, type: '/job/not-found', title: 'Job Not Found', detail: `no job ${jobId} (finished jobs are kept for a while, then dropped)` });
    }
    if (request.method !== 'POST') return methodNotAllowed('POST');
    const body = await readBody(request);
    if (body instanceof Response) return body;

    if (isJobs) {
      // The job API's own field; everything else is the Zyte request.
      const { callbackUrl, ...extract } = body;
      if (callbackUrl !== undefined) {
        let valid = typeof callbackUrl === 'string';
        try {
          valid &&= ['http:', 'https:'].includes(new URL(callbackUrl as string).protocol);
        } catch {
          valid = false;
        }
        if (!valid) return problem({ status: 400, type: '/request/invalid', title: 'Invalid Request', detail: 'callbackUrl must be an http(s) URL' });
        if (options.blockPrivateTargets && isPrivateTarget(callbackUrl as string)) {
          return problem({ status: 400, type: '/request/invalid', title: 'Invalid Request', detail: 'callbackUrl: private and internal addresses are not allowed' });
        }
      }
      const job = await jobs!.submit(extract as ExtractRequest, callbackUrl as string | undefined);
      const location = `${base ?? pathname.slice(0, -'/v1/jobs'.length)}/v1/jobs/${job.id}`;
      return Response.json(job, { status: 202, headers: { location } });
    }

    let report: RequestReport | undefined;
    try {
      // A caller that hangs up cancels the scrape. What it took travels in headers: the body stays Zyte's.
      const result = await xyte.extract(body as ExtractRequest, { signal: request.signal, onReport: (r) => (report = r) });
      return Response.json(result, { headers: reportHeaders(report) });
    } catch (error) {
      const problemBody =
        error instanceof XyteError
          ? error.toJSON()
          : { status: 500, type: '/server/internal', title: 'Internal Server Error', detail: error instanceof Error ? error.message : String(error) };
      return problem(problemBody, reportHeaders(report));
    }
  };
}

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

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

function problem(body: { status: number; type: string; title: string; detail?: string }, headers: Record<string, string> = {}): Response {
  return Response.json(body, { status: body.status, headers: { ...headers, 'content-type': 'application/problem+json' } });
}

const ascii = (value: string) => value.replace(/[^\x20-\x7e]/g, '?');

/**
 * A request's report as response headers: `X-Xyte-Request-Id`, `X-Xyte-Attempts`
 * (`provider:result` per attempt, e.g. `oxylabs-residential:ban,zyte-api:ok`),
 * `X-Xyte-Transfer-Bytes`, `X-Xyte-Cache` (`hit`, `shared`, `miss`), and `X-Xyte-Warning`.
 */
function reportHeaders(report: RequestReport | undefined): Record<string, string> {
  if (!report) return {};
  const headers: Record<string, string> = {
    'x-xyte-request-id': report.requestId,
    'x-xyte-attempts': ascii(report.attempts.map((a) => `${a.provider}:${a.result}`).join(',')),
    'x-xyte-transfer-bytes': String(report.transferBytes),
  };
  if (report.warnings.length > 0) headers['x-xyte-warning'] = ascii(report.warnings.join('; '));
  if (report.cache) headers['x-xyte-cache'] = report.cache;
  return headers;
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
