import type { ExtractRequest } from './types.ts';
import { CookieJar, randomSessionId } from './util.ts';

/**
 * Zyte's server-managed sessions (`sessionContext`): requests with the same context share a
 * small pool of sessions, each initialized once with `sessionContextParameters` (a sticky exit
 * plus the cookies the init actions produced). Sessions expire after 4 hours or 3 bans.
 */
export interface SessionPoolOptions {
  /** Sessions per context. Default 8. */
  size?: number;
  /** Seconds before a session is retired. Default 4 h (Zyte's). */
  maxAge?: number;
  /** Bans (or failed attempts) before a session is retired. Default 3 (Zyte's). */
  maxBans?: number;
}

export interface PooledSession {
  readonly id: string;
  jar: CookieJar;
  readonly createdAt: number;
  bans: number;
  inFlight: number;
  /** Resolves once the init actions ran; undefined until started. */
  ready?: Promise<void>;
}

/** Session contexts kept per process; the least recently used are dropped first. */
const MAX_CONTEXTS = 1_000;

export class SessionPool {
  private readonly pools = new Map<string, PooledSession[]>();
  private readonly size: number;
  private readonly maxAgeMs: number;
  private readonly maxBans: number;

  constructor(options: SessionPoolOptions = {}) {
    this.size = options.size ?? 8;
    this.maxAgeMs = (options.maxAge ?? 4 * 3600) * 1000;
    this.maxBans = options.maxBans ?? 3;
  }

  static key(context: NonNullable<ExtractRequest['sessionContext']>): string {
    return JSON.stringify([...context].map(({ name, value }) => [name, value]).sort());
  }

  /**
   * The least busy live session of the context, or a new one while the pool has room. Sessions
   * in `exclude` (failed earlier in the same request) are skipped; if only they remain, one of
   * them is replaced, so a retry never goes back through the exit that was just banned.
   */
  acquire(key: string, exclude: ReadonlySet<string> = new Set()): PooledSession {
    const now = Date.now();
    const pool = (this.pools.get(key) ?? []).filter((s) => s.bans < this.maxBans && now - s.createdAt < this.maxAgeMs);
    this.pools.delete(key);
    this.pools.set(key, pool); // most recently used context last
    while (this.pools.size > MAX_CONTEXTS) this.pools.delete(this.pools.keys().next().value!);

    const usable = pool.filter((s) => !exclude.has(s.id));
    let session = usable.reduce<PooledSession | undefined>((best, s) => (!best || s.inFlight < best.inFlight ? s : best), undefined);
    if (!session || (session.inFlight > 0 && pool.length < this.size)) {
      if (pool.length >= this.size) {
        // Full: retire the worst excluded (or busiest) session to make room.
        const victim = [...pool].sort((a, b) => Number(exclude.has(b.id)) - Number(exclude.has(a.id)) || b.bans - a.bans)[0];
        if (victim) pool.splice(pool.indexOf(victim), 1);
      }
      session = { id: randomSessionId(), jar: new CookieJar(), createdAt: now, bans: 0, inFlight: 0 };
      pool.push(session);
    }
    session.inFlight++;
    return session;
  }

  release(session: PooledSession, outcome: 'ok' | 'ban'): void {
    session.inFlight = Math.max(0, session.inFlight - 1);
    if (outcome === 'ban') session.bans++;
  }

  /** Drops a session whose initialization failed. */
  discard(key: string, session: PooledSession): void {
    this.pools.set(key, (this.pools.get(key) ?? []).filter((s) => s !== session));
  }
}
