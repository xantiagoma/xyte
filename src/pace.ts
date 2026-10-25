/**
 * Per-site pacing: how fast, and how many at once, attempts go out to each site. Hammering one
 * site is the fastest way to get banned; `concurrency` on the client is global, this is per site.
 */

/** `rate` attempts per `per` seconds, at most `concurrency` at once. */
export interface SiteLimit {
  rate?: number;
  /** Seconds. Default 1. */
  per?: number;
  concurrency?: number;
}

/**
 * Keyed by host (subdomains included, the longest key wins), `'*'` for every other site, each on
 * its own (`'*': '10/s'` is 10 per second per site). Values: `'2/s'`, `'120/m'`, `'1000/h'`,
 * `'5/10s'`, or a `SiteLimit`.
 */
export type RateLimits = Readonly<Record<string, string | SiteLimit>>;

const UNITS: Record<string, number> = { s: 1, m: 60, h: 3600 };

export function parseLimit(value: string | SiteLimit): SiteLimit {
  if (typeof value !== 'string') return value;
  const match = /^\s*(\d+(?:\.\d+)?)\s*\/\s*(\d*)\s*([smh])\s*$/.exec(value);
  if (!match) throw new Error(`xyte: rate limit "${value}" is not like 2/s, 120/m or 5/10s`);
  return { rate: Number(match[1]), per: Number(match[2] || 1) * UNITS[match[3]!]! };
}

interface Bucket {
  intervalMs: number;
  nextAt: number;
  concurrency: number;
  active: number;
  waiting: (() => void)[];
}

export class Pacer {
  private readonly rules: [string, SiteLimit][];
  private readonly buckets = new Map<string, Bucket>();

  constructor(limits: RateLimits) {
    this.rules = Object.entries(limits).map(([host, limit]) => [host.toLowerCase(), parseLimit(limit)]);
  }

  private bucketFor(host: string): Bucket | undefined {
    const match = this.rules
      .filter(([key]) => key !== '*' && (host === key || host.endsWith(`.${key}`)))
      .sort(([a], [b]) => b.length - a.length)[0];
    const [key, limit] = match ?? this.rules.find(([key]) => key === '*') ?? [];
    if (!limit || key === undefined) return undefined;
    // A listed site shares one bucket with its subdomains; under '*' each host has its own.
    const id = key === '*' ? `*:${host}` : key;
    let bucket = this.buckets.get(id);
    if (!bucket) {
      const intervalMs = limit.rate ? ((limit.per ?? 1) * 1000) / limit.rate : 0;
      bucket = { intervalMs, nextAt: 0, concurrency: limit.concurrency ?? Number.POSITIVE_INFINITY, active: 0, waiting: [] };
      this.buckets.set(id, bucket);
    }
    return bucket;
  }

  /** Waits for this site's turn; resolves with the function that frees the slot. */
  async acquire(url: string, signal?: AbortSignal): Promise<() => void> {
    let host: string;
    try {
      host = new URL(url).hostname.toLowerCase();
    } catch {
      return () => {};
    }
    const bucket = this.bucketFor(host);
    if (!bucket) return () => {};
    if (bucket.active >= bucket.concurrency) {
      await new Promise<void>((resolve, reject) => {
        bucket.waiting.push(resolve);
        // A cancelled waiter leaves the queue, so the next release wakes someone still waiting.
        signal?.addEventListener(
          'abort',
          () => {
            const index = bucket.waiting.indexOf(resolve);
            if (index >= 0) bucket.waiting.splice(index, 1);
            reject(signal.reason);
          },
          { once: true },
        );
      });
    }
    bucket.active++;
    const slot = Math.max(Date.now(), bucket.nextAt);
    bucket.nextAt = slot + bucket.intervalMs;
    const wait = slot - Date.now();
    if (wait > 0) {
      try {
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(resolve, wait);
          signal?.addEventListener('abort', () => (clearTimeout(timer), reject(signal.reason)), { once: true });
        });
      } catch (error) {
        release(bucket);
        throw error;
      }
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      release(bucket);
    };
  }
}

function release(bucket: Bucket): void {
  bucket.active--;
  bucket.waiting.shift()?.();
}
