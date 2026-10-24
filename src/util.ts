import type { Cookie } from './types.ts';

/** Zyte truncates bodies and browser HTML beyond 10 MB. */
export const MAX_BODY_BYTES: number = 10 * 1024 * 1024;

export const sleep = (ms: number): Promise<void> => new Promise<void>((resolve) => setTimeout(resolve, ms));

export function toBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('base64');
}

export function fromBase64(value: string): Uint8Array<ArrayBuffer> {
  return new Uint8Array(Buffer.from(value, 'base64'));
}

/** Decodes an `httpResponseBody` (or captured body) as UTF-8 text. */
export function decodeBody(base64: string): string {
  return Buffer.from(base64, 'base64').toString('utf8');
}

export function randomSessionId(): string {
  return crypto.randomUUID().replaceAll('-', '');
}

/**
 * Folds an arbitrary session id into what a provider accepts (alphanumeric, bounded length, or
 * an integer below `max`), deterministically, so the same Zyte session keeps the same exit IP.
 */
export function sessionToken(sessionId: string, length = 12): string {
  const clean = sessionId.replace(/[^a-zA-Z0-9]/g, '');
  if (clean.length >= length) return clean.slice(0, length);
  return (clean + hash(sessionId).toString(36).repeat(4)).slice(0, length);
}

export function sessionNumber(sessionId: string, max = 1_000_000): number {
  return (hash(sessionId) % (max - 1)) + 1;
}

function hash(value: string): number {
  // FNV-1a
  let h = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) {
    h ^= value.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export type MatchType = 'startsWith' | 'endsWith' | 'contains' | 'exact';

export function matchUrl(url: string, pattern: string, matchType: MatchType = 'exact'): boolean {
  switch (matchType) {
    case 'startsWith':
      return url.startsWith(pattern);
    case 'endsWith':
      return url.endsWith(pattern);
    case 'contains':
      return url.includes(pattern);
    case 'exact':
      return url === pattern;
  }
}

const DESKTOP_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';
const MOBILE_UA =
  'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36';

/** Browser-like defaults; Zyte also sends a realistic header set on HTTP requests. */
export function defaultHeaders(device: 'desktop' | 'mobile' = 'desktop'): Record<string, string> {
  const mobile = device === 'mobile';
  return {
    'user-agent': mobile ? MOBILE_UA : DESKTOP_UA,
    accept:
      'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
    'accept-language': 'en-US,en;q=0.9',
    'sec-ch-ua': '"Google Chrome";v="141", "Not?A_Brand";v="8", "Chromium";v="141"',
    'sec-ch-ua-mobile': mobile ? '?1' : '?0',
    'sec-ch-ua-platform': mobile ? '"Android"' : '"Windows"',
    'upgrade-insecure-requests': '1',
  };
}

export function userAgent(device: 'desktop' | 'mobile' = 'desktop'): string {
  return device === 'mobile' ? MOBILE_UA : DESKTOP_UA;
}

/**
 * A minimal RFC 6265 cookie jar: enough to carry cookies across redirects and across requests
 * that share a Zyte `session.id`.
 */
export class CookieJar {
  private cookies: Cookie[] = [];

  constructor(initial: readonly Cookie[] = []) {
    for (const cookie of initial) this.set(cookie);
  }

  set(cookie: Cookie): void {
    const domain = cookie.domain.toLowerCase();
    const path = cookie.path ?? '/';
    this.cookies = this.cookies.filter(
      (c) => !(c.name === cookie.name && c.domain.toLowerCase() === domain && (c.path ?? '/') === path),
    );
    const expired = cookie.expires != null && cookie.expires * 1000 <= Date.now();
    if (!expired) this.cookies.push({ ...cookie, path });
  }

  /** Applies the `Set-Cookie` headers of a response to `url`. */
  setFromHeaders(setCookies: readonly string[], url: URL): void {
    for (const header of setCookies) {
      const cookie = parseSetCookie(header, url);
      if (cookie) this.set(cookie);
    }
  }

  /** The `Cookie` header value for `url`, or undefined. */
  header(url: URL): string | undefined {
    const now = Date.now();
    const host = url.hostname.toLowerCase();
    const matching = this.cookies.filter((c) => {
      if (c.expires != null && c.expires * 1000 <= now) return false;
      if (c.secure && url.protocol !== 'https:') return false;
      const domain = c.domain.toLowerCase().replace(/^\./, '');
      if (host !== domain && !host.endsWith(`.${domain}`)) return false;
      const path = c.path ?? '/';
      return url.pathname === path || url.pathname.startsWith(path.endsWith('/') ? path : `${path}/`);
    });
    if (matching.length === 0) return undefined;
    return matching.map((c) => `${c.name}=${c.value}`).join('; ');
  }

  all(): Cookie[] {
    return this.cookies.map((c) => ({ ...c }));
  }
}

export function parseSetCookie(header: string, url: URL): Cookie | undefined {
  const [pair, ...attributes] = header.split(';');
  const eq = pair?.indexOf('=') ?? -1;
  if (!pair || eq <= 0) return undefined;

  const cookie: Cookie = {
    name: pair.slice(0, eq).trim(),
    value: pair.slice(eq + 1).trim(),
    domain: url.hostname,
    path: '/',
  };
  let hostOnly = true;

  for (const attribute of attributes) {
    const [rawKey = '', ...rest] = attribute.split('=');
    const key = rawKey.trim().toLowerCase();
    const value = rest.join('=').trim();
    if (key === 'domain' && value) {
      cookie.domain = `.${value.replace(/^\./, '')}`;
      hostOnly = false;
    } else if (key === 'path' && value.startsWith('/')) cookie.path = value;
    else if (key === 'expires') {
      const time = Date.parse(value);
      if (!Number.isNaN(time) && cookie.expires == null) cookie.expires = Math.floor(time / 1000);
    } else if (key === 'max-age') {
      const seconds = Number(value);
      if (Number.isFinite(seconds)) cookie.expires = Math.floor(Date.now() / 1000) + seconds;
    } else if (key === 'secure') cookie.secure = true;
    else if (key === 'httponly') cookie.httpOnly = true;
    else if (key === 'samesite') {
      const v = value.toLowerCase();
      cookie.sameSite = v === 'strict' ? 'Strict' : v === 'none' ? 'None' : 'Lax';
    }
  }
  if (hostOnly) cookie.domain = url.hostname;
  return cookie;
}
