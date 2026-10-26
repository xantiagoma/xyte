import { createHash } from 'node:crypto';
import { memoryStore, resilient, type StateStore } from './state.ts';
import type { ExtractRequest, ExtractResponse } from './types.ts';

/** The `cache` option: keep responses for a while and answer repeated requests from them. */
export interface CacheOptions {
  /**
   * Seconds a response stays fresh: one value for every site, or per site keyed by host
   * (subdomains included, the longest key wins) with `'*'` for the rest. 0 doesn't cache.
   */
  ttl: number | Readonly<Record<string, number>>;
  /** Where responses are kept. Default: this process's memory (1,000 responses). Redis shares them across instances. */
  store?: StateStore;
  /** Which responses to keep. Default: the target answered below 400, or 404 / 410 (gone stays gone). */
  cacheable?: (response: ExtractResponse) => boolean;
  /** The cache key. Default: a hash of the request without `tags`, `jobId` and `echoData`, which don't change the page. */
  key?: (request: ExtractRequest) => string;
}

/** Fields that label a request without changing what comes back; re-applied on a hit. */
const LABELS = ['tags', 'jobId', 'echoData'] as const;

/** JSON with sorted keys, so the same request always hashes the same. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value)
      .filter((k) => (value as Record<string, unknown>)[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

/**
 * The cache's default key: a hash of the request without its labels (`tags`, `jobId`, `echoData`),
 * so the same request with different tags is a hit.
 */
export function requestKey(request: ExtractRequest): string {
  const rest: Record<string, unknown> = { ...request };
  for (const label of LABELS) delete rest[label];
  return createHash('sha256').update(canonical(rest)).digest('base64url');
}

const defaultCacheable = (response: ExtractResponse): boolean => {
  const status = response.statusCode ?? 200;
  return status < 400 || status === 404 || status === 410;
};

/** A response cache in front of `extract()`, with concurrent identical requests sharing one run. */
export class ResponseCache {
  private readonly store: StateStore;
  private readonly inflight = new Map<string, Promise<ExtractResponse>>();

  constructor(private readonly options: CacheOptions) {
    this.store = options.store ? resilient(options.store) : memoryStore({ maxEntries: 1000 });
  }

  /** Seconds to keep this request's response; 0 when it shouldn't be cached at all. */
  ttlFor(request: ExtractRequest): number {
    // A session carries state (cookies, a login): an earlier response isn't this one.
    if (request.session || request.sessionContext) return 0;
    const { ttl } = this.options;
    if (typeof ttl === 'number') return ttl;
    let host: string;
    try {
      host = new URL(request.url).hostname.toLowerCase();
    } catch {
      return 0;
    }
    const match = Object.keys(ttl)
      .filter((key) => key !== '*' && (host === key.toLowerCase() || host.endsWith(`.${key.toLowerCase()}`)))
      .sort((a, b) => b.length - a.length)[0];
    return (match !== undefined ? ttl[match] : ttl['*']) ?? 0;
  }

  key(request: ExtractRequest): string {
    return `cache:${(this.options.key ?? requestKey)(request)}`;
  }

  /**
   * The cached response, a run another caller already started for the same request, or a new
   * run (stored when cacheable). `how` says which.
   */
  async through(
    request: ExtractRequest,
    ttl: number,
    run: () => Promise<ExtractResponse>,
  ): Promise<{ response: ExtractResponse; how: 'hit' | 'shared' | 'miss' }> {
    const key = this.key(request);
    const stored = await this.store.get(key);
    if (stored) return { response: relabel(JSON.parse(stored) as ExtractResponse, request), how: 'hit' };
    const running = this.inflight.get(key);
    if (running) return { response: relabel(await running, request), how: 'shared' };
    const fresh = run();
    this.inflight.set(key, fresh);
    try {
      const response = await fresh;
      if ((this.options.cacheable ?? defaultCacheable)(response)) {
        const { echoData: _echo, jobId: _job, ...kept } = response;
        await this.store.set(key, JSON.stringify(kept), ttl);
      }
      return { response, how: 'miss' };
    } finally {
      this.inflight.delete(key);
    }
  }
}

/** A cached response with this request's own labels (`echoData`, `jobId`). */
function relabel(response: ExtractResponse, request: ExtractRequest): ExtractResponse {
  const { echoData: _echo, jobId: _job, ...rest } = response;
  return {
    ...rest,
    ...(request.echoData !== undefined && { echoData: request.echoData }),
    ...(request.jobId != null && { jobId: request.jobId }),
  };
}
