import type { ProxyEndpoint } from '../proxy.ts';
import type { Transport } from '../transport.ts';
import type { ExtractRequest, ExtractResponse, HttpHeader } from '../types.ts';
import { CookieJar, defaultHeaders, fromBase64, MAX_BODY_BYTES, toBase64 } from '../util.ts';

export interface EngineAttempt {
  request: ExtractRequest;
  proxy: ProxyEndpoint | null;
  jar: CookieJar;
  signal: AbortSignal;
}

/** What an engine hands back: the Zyte response plus what ban detection and extractors read. */
export interface EngineResult {
  response: ExtractResponse;
  statusCode: number;
  headers: HttpHeader[];
  /** The page as text: decoded HTTP body, or browser HTML. */
  html?: string;
}

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

  for (let hop = 0; ; hop++) {
    const headers = new Headers(baseHeaders);
    const cookie = jar.header(url);
    if (cookie) headers.set('cookie', cookie);

    const res = await transport({
      url: url.toString(),
      method,
      headers,
      body: method === 'GET' || method === 'HEAD' ? undefined : body,
      proxy: attempt.proxy,
      signal: attempt.signal,
    });

    if (res.status === 407) {
      await res.body?.cancel();
      throw new ProxyError(`proxy rejected the credentials (407)${proxyLabel(attempt.proxy)}`);
    }

    jar.setFromHeaders(res.headers.getSetCookie(), url);

    const location = res.headers.get('location');
    if (request.followRedirect !== false && isRedirect(res.status) && location && hop < MAX_REDIRECTS) {
      await res.body?.cancel();
      url = new URL(location, url);
      // 301/302/303 turn into GET, 307/308 keep method and body (as browsers do).
      if (res.status === 303 || ((res.status === 301 || res.status === 302) && method === 'POST')) {
        method = 'GET';
        body = undefined;
        baseHeaders.delete('content-type');
        baseHeaders.delete('content-length');
      }
      continue;
    }

    const bytes = new Uint8Array(await res.arrayBuffer());
    const truncated = bytes.byteLength > MAX_BODY_BYTES ? bytes.subarray(0, MAX_BODY_BYTES) : bytes;
    const headerList = toHeaderList(res.headers);

    const response: ExtractResponse = { url: url.toString(), statusCode: res.status };
    if (request.httpResponseBody) response.httpResponseBody = toBase64(truncated);
    if (request.httpResponseHeaders) response.httpResponseHeaders = headerList;

    return {
      response,
      statusCode: res.status,
      headers: headerList,
      html: new TextDecoder().decode(truncated),
    };
  }
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

const isRedirect = (status: number) => status === 301 || status === 302 || status === 303 || status === 307 || status === 308;

function toHeaderList(headers: Headers): HttpHeader[] {
  const list: HttpHeader[] = [];
  headers.forEach((value, name) => {
    if (name !== 'set-cookie') list.push({ name, value });
  });
  for (const value of headers.getSetCookie()) list.push({ name: 'set-cookie', value });
  return list;
}
