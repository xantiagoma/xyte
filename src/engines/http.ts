import { brotliCompressSync, constants as zlibConstants, deflateSync, gzipSync } from 'node:zlib';
import type { ActionHandlers, ZyteOnlyAction } from '../actions.ts';
import type { CaptchaOutcome } from '../captcha.ts';
import type { ProxyContext, ProxyEndpoint } from '../proxy.ts';
import type { Transport } from '../transport.ts';
import type { ExtractRequest, ExtractResponse, HttpHeader } from '../types.ts';
import { CookieJar, defaultHeaders, fromBase64, MAX_BODY_BYTES, toBase64 } from '../util.ts';

export interface EngineAttempt {
  request: ExtractRequest;
  /** What the proxy was resolved from (country, session, attempt…). */
  context: ProxyContext;
  proxy: ProxyEndpoint | null;
  jar: CookieJar;
  signal: AbortSignal;
  /** Handlers for Zyte's own actions in a browser, and what to do when one has none. */
  actions?: { handlers: ActionHandlers; onMissing: (action: ZyteOnlyAction) => void };
}

/** What an engine hands back: the Zyte response plus what ban detection and extractors read. */
export interface EngineResult {
  response: ExtractResponse;
  statusCode: number;
  headers: HttpHeader[];
  /** The page as text: decoded HTTP body, or browser HTML. */
  html?: string;
  /**
   * Bytes that crossed the wire for this attempt, both ways: request and response headers plus
   * bodies as transferred (compressed), every redirect hop and, in a browser, every sub-request.
   * TLS and tunnel overhead aren't included, so per-GB bills run a few percent higher.
   */
  transferBytes?: number;
  /** Captchas found on the page and what solving them gave (browser renders with `browser.captcha`). */
  captchas?: CaptchaOutcome[];
}

/**
 * A compressed body sent without Content-Length (chunked) is decoded by fetch before we see it:
 * estimate what crossed the wire by compressing it again the same way (within a few percent of
 * typical server settings).
 */
function compressedSize(body: Uint8Array, encoding: string): number {
  try {
    switch (encoding.trim().toLowerCase()) {
      case 'br':
        return brotliCompressSync(body, { params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 5 } }).byteLength;
      case 'deflate':
        return deflateSync(body).byteLength;
      default: // gzip, and zstd, whose ratio is close to gzip's
        return gzipSync(body).byteLength;
    }
  } catch {
    return body.byteLength;
  }
}

/** Headers the transport adds itself: Host, Connection, Accept-Encoding, and the proxy's auth. */
function transportHeaderBytes(url: URL, proxy: ProxyEndpoint | null): number {
  let size = `Host: ${url.host}\r\nConnection: keep-alive\r\nAccept-Encoding: gzip, deflate, br, zstd\r\n`.length;
  if (proxy) {
    const { username, password } = new URL(proxy.url);
    const credentials = decodeURIComponent(username) + ':' + decodeURIComponent(password);
    size += 'Proxy-Connection: Keep-Alive\r\nProxy-Authorization: Basic \r\n'.length + Math.ceil(credentials.length / 3) * 4;
  }
  return size;
}

/** Wire size of a header block (`name: value\r\n` per header, plus the blank line). */
export const headerBytes = (headers: Iterable<[string, string]>): number => {
  let size = 2;
  for (const [name, value] of headers) size += name.length + value.length + 4;
  return size;
};

const MAX_REDIRECTS = 10;

export async function runHttp(attempt: EngineAttempt, transport: Transport): Promise<EngineResult> {
  const { request, jar } = attempt;

  let url = new URL(request.url);
  let method = request.httpRequestMethod ?? 'GET';
  let body =
    request.httpRequestText != null
      ? new TextEncoder().encode(request.httpRequestText)
      : request.httpRequestBody != null
        ? fromBase64(request.httpRequestBody)
        : undefined;

  const baseHeaders = new Headers(defaultHeaders(request.device));
  if (request.requestHeaders?.referer) baseHeaders.set('referer', request.requestHeaders.referer);
  for (const { name, value } of request.customHttpRequestHeaders ?? []) {
    if (name != null && value != null) baseHeaders.set(name, value);
  }

  let transferred = 0;
  for (let hop = 0; ; hop++) {
    const headers = new Headers(baseHeaders);
    for (const [name, value] of Object.entries(attempt.proxy?.headers ?? {})) headers.set(name, value);
    const cookie = jar.header(url);
    if (cookie) headers.set('cookie', cookie);

    const sentBody = method === 'GET' || method === 'HEAD' ? undefined : body;
    const res = await transport({
      url: url.toString(),
      method,
      headers,
      body: sentBody,
      proxy: attempt.proxy,
      signal: attempt.signal,
    });
    transferred +=
      `${method} ${url.pathname}${url.search} HTTP/1.1\r\n`.length +
      headerBytes(headers) +
      transportHeaderBytes(url, attempt.proxy) +
      (sentBody?.byteLength ?? 0) +
      17 +
      headerBytes(res.headers);
    // fetch decodes the body; Content-Length is what crossed the wire when it was compressed.
    const wireLength = Number(res.headers.get('content-length')) || undefined;

    if (res.status === 407) {
      await res.body?.cancel();
      throw new ProxyError(`proxy rejected the credentials (407)${proxyLabel(attempt.proxy)}`);
    }
    const seen = attempt.proxy?.inspect?.({ status: res.status, headers: res.headers });
    if (seen?.failure) {
      await res.body?.cancel();
      throw new ProxyError(`${seen.failure}${proxyLabel(attempt.proxy)}`);
    }
    if (seen?.url) url = safeUrl(seen.url, url) ?? url;

    jar.setFromHeaders(res.headers.getSetCookie(), url);

    const location = res.headers.get('location');
    const next = location ? safeUrl(location, url) : undefined;
    if (request.followRedirect !== false && isRedirect(res.status) && next && hop < MAX_REDIRECTS) {
      await res.body?.cancel();
      transferred += wireLength ?? 0;
      // As fetch does: credentials don't follow a redirect to another origin.
      if (next.origin !== url.origin) baseHeaders.delete('authorization');
      url = next;
      // 301/302/303 turn into GET, 307/308 keep method and body (as browsers do).
      if (res.status === 303 || ((res.status === 301 || res.status === 302) && method === 'POST')) {
        method = 'GET';
        body = undefined;
        baseHeaders.delete('content-type');
        baseHeaders.delete('content-length');
      }
      continue;
    }

    const truncated = await readCapped(res, MAX_BODY_BYTES);
    const encoding = res.headers.get('content-encoding');
    transferred += !encoding ? truncated.byteLength : wireLength ? Math.min(wireLength, truncated.byteLength) : compressedSize(truncated, encoding);
    const hidden = attempt.proxy?.hiddenHeaders;
    const headerList = toHeaderList(res.headers).filter((h) => !hidden?.test(h.name));

    const response: ExtractResponse = { url: url.toString(), statusCode: res.status };
    if (request.httpResponseBody) response.httpResponseBody = toBase64(truncated);
    if (request.httpResponseHeaders) response.httpResponseHeaders = headerList;

    return {
      response,
      statusCode: res.status,
      headers: headerList,
      html: new TextDecoder().decode(truncated),
      transferBytes: transferred,
    };
  }
}

function safeUrl(location: string, base: URL): URL | undefined {
  try {
    return new URL(location, base);
  } catch {
    return undefined; // a malformed Location: return the redirect response itself
  }
}

/** Reads at most `max` bytes, then stops the download (Zyte truncates bodies at 10 MB). */
async function readCapped(res: Response, max: number): Promise<Uint8Array> {
  if (!res.body) return new Uint8Array();
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (size < max) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    size += value.byteLength;
  }
  if (size >= max) await reader.cancel().catch(() => {});
  const out = new Uint8Array(Math.min(size, max));
  let offset = 0;
  for (const chunk of chunks) {
    const part = chunk.subarray(0, Math.min(chunk.byteLength, out.byteLength - offset));
    out.set(part, offset);
    offset += part.byteLength;
    if (offset >= out.byteLength) break;
  }
  return out;
}

/** The proxy itself failed (auth, tunnel, connection): another exit may work. */
export class ProxyError extends Error {
  override name = 'ProxyError';
}

function proxyLabel(proxy: ProxyEndpoint | null): string {
  if (!proxy) return '';
  try {
    return ` at ${new URL(proxy.url).host}`;
  } catch {
    return '';
  }
}

export const isRedirect = (status: number): boolean => status === 301 || status === 302 || status === 303 || status === 307 || status === 308;

function toHeaderList(headers: Headers): HttpHeader[] {
  const list: HttpHeader[] = [];
  headers.forEach((value, name) => {
    if (name !== 'set-cookie') list.push({ name, value });
  });
  for (const value of headers.getSetCookie()) list.push({ name: 'set-cookie', value });
  return list;
}
