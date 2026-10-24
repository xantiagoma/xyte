import { serverError } from './errors.ts';
import type { ProxyEndpoint } from './proxy.ts';

export interface TransportRequest {
  url: string;
  method: string;
  headers: Headers;
  body?: Uint8Array<ArrayBuffer>;
  proxy: ProxyEndpoint | null;
  signal: AbortSignal;
}

/** Sends one HTTP request, never following redirects (the HTTP engine does that itself). */
export type Transport = (request: TransportRequest) => Promise<Response>;

const isBun = typeof (globalThis as { Bun?: unknown }).Bun !== 'undefined';

/**
 * Bun's `fetch` takes `proxy` and `tls` natively. On Node, `undici` (an optional peer
 * dependency) provides the proxy agent; without a proxy, the global `fetch` is enough.
 */
export const defaultTransport: Transport = isBun ? bunTransport : nodeTransport;

function bunTransport(request: TransportRequest): Promise<Response> {
  return fetch(request.url, {
    method: request.method,
    headers: request.headers,
    body: request.body,
    redirect: 'manual',
    signal: request.signal,
    // Bun-specific options.
    proxy: request.proxy ? bunProxy(request.proxy.url) : undefined,
    tls: request.proxy?.insecure ? { rejectUnauthorized: false } : undefined,
  } as RequestInit);
}

/**
 * Bun misparses a proxy URL with a username but no password (`http://key:@host` becomes host
 * `key@host`), which is how Crawlbase and Zyte take their API key. Send those credentials as a
 * `Proxy-Authorization` header instead.
 */
function bunProxy(url: string): string | { url: string; headers: Record<string, string> } {
  const parsed = new URL(url);
  if (parsed.username === '' || parsed.password !== '') return url;
  const credentials = `${decodeURIComponent(parsed.username)}:`;
  return {
    url: `${parsed.protocol}//${parsed.host}`,
    headers: { 'Proxy-Authorization': `Basic ${Buffer.from(credentials).toString('base64')}` },
  };
}

type Undici = typeof import('undici');
let undici: Promise<Undici> | undefined;
const agents = new Map<string, unknown>();
const MAX_AGENTS = 64;

async function nodeTransport(request: TransportRequest): Promise<Response> {
  const init = {
    method: request.method,
    headers: request.headers,
    body: request.body,
    redirect: 'manual' as const,
    signal: request.signal,
  };
  if (!request.proxy) return fetch(request.url, init);

  undici ??= import('undici').catch((error) => {
    undici = undefined;
    throw serverError('proxies on Node.js need the "undici" package (npm i undici)', error);
  });
  const { ProxyAgent, fetch: undiciFetch } = await undici;

  const key = `${request.proxy.insecure ? 'insecure ' : ''}${request.proxy.url}`;
  let agent = agents.get(key) as InstanceType<Undici['ProxyAgent']> | undefined;
  if (!agent) {
    const proxy = new URL(request.proxy.url);
    const token =
      proxy.username !== ''
        ? `Basic ${Buffer.from(`${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`).toString('base64')}`
        : undefined;
    proxy.username = '';
    proxy.password = '';
    agent = new ProxyAgent({
      uri: proxy.toString(),
      token,
      requestTls: request.proxy.insecure ? { rejectUnauthorized: false } : undefined,
    });
    agents.set(key, agent);
    // Session ids live in the proxy username, so keys churn: keep only the most recent agents.
    if (agents.size > MAX_AGENTS) {
      const [oldestKey, oldest] = agents.entries().next().value!;
      agents.delete(oldestKey);
      void (oldest as { close(): Promise<void> }).close().catch(() => {});
    }
  } else {
    agents.delete(key);
    agents.set(key, agent);
  }
  return (await undiciFetch(request.url, { ...init, dispatcher: agent })) as unknown as Response;
}
