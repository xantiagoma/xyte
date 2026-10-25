import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createSecureContext, TLSSocket, type SecureContext } from 'node:tls';
import type { Duplex } from 'node:stream';
import { createCertificateAuthority, issueCertificate, type CertificateAuthority } from './ca.ts';
import type { RequestReport, Xyte } from './client.ts';
import { XyteError, type XyteProblem } from './errors.ts';
import { isPrivateTarget } from './server.ts';
import type { ExtractRequest } from './types.ts';
import { toBase64 } from './util.ts';

/**
 * Zyte API's proxy mode (https://docs.zyte.com/zyte-api/usage/proxy-mode.html), served by xyte:
 * clients use it as an HTTP proxy (`curl -x xyte:8012 -U key: --cacert ca.crt https://site`),
 * options go in `Zyte-*` request headers, and the answer is the site's own response. HTTPS is
 * decrypted with a certificate signed by the proxy's CA, which clients must trust, as with Zyte's.
 */
export interface ProxyModeOptions {
  /** Accepted keys, as the proxy username (`Proxy-Authorization: Basic base64(key:)`). Empty: anyone. */
  apiKeys?: readonly string[];
  /** The CA that signs per-site certificates. Default: a new one (clients must trust it, so keep one). */
  ca?: CertificateAuthority;
  /** Reject targets on loopback, private and metadata addresses. */
  blockPrivateTargets?: boolean;
  /** Each request's report (for stats or logs). */
  onReport?: (report: RequestReport) => void;
}

/** Headers Zyte's proxy mode rejects with a 400. */
const FORBIDDEN = new Set(
  [
    'client-ip', 'cluster-client-ip', 'forwarded-for', 'true-client-ip', 'via', 'x-client-ip', 'x-forwarded', 'x-forwarded-for',
    'x-forwarded-host', 'x-host', 'x-original-url', 'x-originating-ip', 'x-proxyuser-io', 'x-proxyuser-ip', 'x-remote-addr', 'x-remote-ip',
  ],
);
/** Not forwarded to the site: connection-level, the proxy's own, or set by the fetch. */
const HOP = new Set(['connection', 'keep-alive', 'proxy-authorization', 'proxy-connection', 'te', 'trailer', 'transfer-encoding', 'upgrade', 'host', 'content-length', 'cookie']);
/** Zyte sends its own of these unless the request names them in Zyte-Override-Headers. */
const OVERRIDABLE = ['accept', 'accept-encoding', 'user-agent'];
/** Not passed back: the body arrives decoded and whole. */
const RESPONSE_HOP = new Set(['content-encoding', 'content-length', 'transfer-encoding', 'connection', 'keep-alive']);

export class ProxyModeError extends XyteError {}

/** The Zyte request a proxied request stands for: its URL, method, body, headers and `Zyte-*` options. */
export function proxiedRequest(url: string, method: string, headers: IncomingMessage['headers'], body: Buffer): ExtractRequest {
  const header = (name: string) => {
    const value = headers[name];
    return Array.isArray(value) ? value[0] : value;
  };
  for (const name of Object.keys(headers)) {
    if (FORBIDDEN.has(name)) throw new ProxyModeError({ status: 400, type: '/request/invalid', title: 'Invalid Request', detail: `the ${name} header isn't allowed` });
  }
  const overrides = new Set((header('zyte-override-headers') ?? '').split(',').map((h) => h.trim().toLowerCase()).filter(Boolean));
  const browser = header('zyte-browser-html')?.toLowerCase() === 'true';
  const request: ExtractRequest = { url, ...(browser ? { browserHtml: true } : { httpResponseBody: true }), httpResponseHeaders: true };
  if (!browser && method !== 'GET') request.httpRequestMethod = method as ExtractRequest['httpRequestMethod'];
  if (!browser && body.length > 0) request.httpRequestBody = toBase64(body);
  const custom = Object.entries(headers)
    .filter(([name]) => !HOP.has(name) && !name.startsWith('zyte-') && (!OVERRIDABLE.includes(name) || overrides.has(name)))
    .flatMap(([name, value]) => (Array.isArray(value) ? value : [value ?? '']).map((v) => ({ name, value: v })));
  if (!browser && custom.length > 0) request.customHttpRequestHeaders = custom;
  // Cookies apply to the target's domain only, as in Zyte's proxy mode.
  const cookie = header('cookie');
  if (cookie) {
    const domain = new URL(url).hostname;
    request.requestCookies = cookie
      .split(';')
      .map((pair) => pair.trim())
      .filter(Boolean)
      .map((pair) => {
        const at = pair.indexOf('=');
        return { name: at === -1 ? pair : pair.slice(0, at), value: at === -1 ? '' : pair.slice(at + 1), domain };
      });
  }
  const geolocation = header('zyte-geolocation');
  if (geolocation) request.geolocation = geolocation as ExtractRequest['geolocation'];
  const device = header('zyte-device');
  if (device) request.device = device as ExtractRequest['device'];
  const ipType = header('zyte-iptype');
  if (ipType) request.ipType = ipType as ExtractRequest['ipType'];
  const session = header('zyte-session-id');
  if (session) request.session = { id: session };
  const cookieManagement = header('zyte-cookie-management');
  if (cookieManagement) request.cookieManagement = cookieManagement as ExtractRequest['cookieManagement'];
  if (header('zyte-disable-follow-redirect')?.toLowerCase() === 'true') request.followRedirect = false;
  const jobId = header('zyte-jobid');
  if (jobId) request.jobId = jobId;
  const tags = header('zyte-tags');
  if (tags) {
    try {
      request.tags = JSON.parse(tags) as ExtractRequest['tags'];
    } catch {
      throw new ProxyModeError({ status: 400, type: '/request/invalid', title: 'Invalid Request', detail: 'Zyte-Tags must be a JSON object' });
    }
  }
  return request;
}

/**
 * Adds proxy mode to a node:http server: absolute-URL requests (http://) and CONNECT tunnels
 * (https://, decrypted with per-site certificates from the CA). Returns the CA's certificate.
 */
export function attachProxyMode(server: Server, xyte: Xyte, options: ProxyModeOptions = {}): { caCert: string } {
  const ca = options.ca ?? createCertificateAuthority();
  const keys = new Set(options.apiKeys ?? []);
  const contexts = new Map<string, SecureContext>();
  const contextFor = (host: string) => {
    let context = contexts.get(host);
    if (!context) {
      context = createSecureContext(issueCertificate(ca, host));
      contexts.set(host, context);
      if (contexts.size > 1000) contexts.delete(contexts.keys().next().value!);
    }
    return context;
  };
  const authorized = (req: IncomingMessage) => {
    if (keys.size === 0) return true;
    const auth = req.headers['proxy-authorization'];
    if (!auth?.startsWith('Basic ')) return false;
    const user = Buffer.from(auth.slice(6), 'base64').toString().split(':')[0] ?? '';
    return keys.has(user);
  };

  const handle = async (req: IncomingMessage, res: ServerResponse, url: string) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    let report: RequestReport | undefined;
    try {
      if (options.blockPrivateTargets && isPrivateTarget(url)) {
        throw new ProxyModeError({ status: 400, type: '/request/invalid', title: 'Invalid Request', detail: 'private and internal addresses are not allowed' });
      }
      const request = proxiedRequest(url, req.method ?? 'GET', req.headers, Buffer.concat(chunks));
      const response = await xyte.extract(request, { onReport: (r) => ((report = r), options.onReport?.(r)) });
      // The site's bytes as they came (binary-safe), or the rendered HTML.
      const raw = response.browserHtml !== undefined ? Buffer.from(response.browserHtml, 'utf8') : Buffer.from(response.httpResponseBody ?? '', 'base64');
      const headers: [string, string][] = (response.httpResponseHeaders ?? [])
        .filter((h) => !RESPONSE_HOP.has(h.name.toLowerCase()))
        .map((h) => [h.name, h.value]);
      res.writeHead(response.statusCode ?? 200, [...headers, ['content-length', String(raw.length)], ['zyte-request-id', report?.requestId ?? '']].flat());
      res.end(req.method === 'HEAD' ? undefined : raw);
    } catch (error) {
      const problem: XyteProblem =
        error instanceof XyteError
          ? error.toJSON()
          : { status: 500, type: '/server/internal', title: 'Internal Server Error', detail: error instanceof Error ? error.message : String(error) };
      const body = JSON.stringify(problem);
      res.writeHead(problem.status, {
        'content-type': 'application/problem+json',
        'content-length': Buffer.byteLength(body),
        'zyte-error-type': problem.type,
        'zyte-error-title': problem.title,
        ...(report && { 'zyte-request-id': report.requestId }),
      });
      res.end(body);
    }
  };

  const deny = (res: ServerResponse) => {
    res.writeHead(407, { 'proxy-authenticate': 'Basic realm="xyte"', 'content-type': 'application/problem+json' });
    res.end(JSON.stringify({ status: 407, type: '/auth/key-not-found', title: 'Authentication Key Not Found' }));
  };

  // Plain-HTTP targets arrive in absolute form: GET http://site/path.
  server.on('request', (req: IncomingMessage, res: ServerResponse) => {
    if (!/^https?:\/\//i.test(req.url ?? '')) {
      res.writeHead(400, { 'content-type': 'text/plain' });
      res.end('this is a proxy: send absolute-URL requests, or CONNECT for https');
      return;
    }
    if (!authorized(req)) return deny(res);
    void handle(req, res, req.url!);
  });

  // HTTPS targets: CONNECT, then TLS with a certificate for the host, then requests inside.
  const inner = createServer((req, res) => {
    const host = (req.socket as TLSSocket & { xyteHost?: string }).xyteHost!;
    void handle(req, res, `https://${req.headers.host ?? host}${req.url}`);
  });
  server.on('connect', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    if (!authorized(req)) {
      socket.end('HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm="xyte"\r\nContent-Length: 0\r\n\r\n');
      return;
    }
    const host = (req.url ?? '').replace(/:\d+$/, '').replace(/^\[|\]$/g, '');
    socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    if (head.length > 0) socket.unshift(head);
    const tls = new TLSSocket(socket, { isServer: true, secureContext: contextFor(host) }) as TLSSocket & { xyteHost?: string };
    tls.xyteHost = host;
    tls.on('error', () => socket.destroy());
    inner.emit('connection', tls);
  });
  return { caCert: ca.cert };
}

/** A proxy-mode server on its own port. */
export async function serveProxyMode(
  xyte: Xyte,
  options: ProxyModeOptions & { port?: number; hostname?: string } = {},
): Promise<{ port: number; caCert: string; stop: () => Promise<void> }> {
  const server = createServer();
  const { caCert } = attachProxyMode(server, xyte, options);
  await new Promise<void>((resolve) => server.listen(options.port ?? 8012, options.hostname ?? '127.0.0.1', resolve));
  const { port } = server.address() as { port: number };
  return {
    port,
    caCert,
    stop: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
