import { createHash } from 'node:crypto';
import { resilient, type StateStore } from './state.ts';
import type { Cookie, ExtractRequest } from './types.ts';
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
  /**
   * Shared state: every instance draws from the same sessions per context, with their cookies,
   * bans and whether they're initialized (a session another instance logged in isn't logged in
   * again). Default: this process only.
   */
  store?: StateStore;
  /** Seconds between re-reads of a context's shared sessions (before an acquire). Default 5. */
  syncEvery?: number;
}

/** A pooled session as kept in a shared store. */
interface SharedSession {
  id: string;
  createdAt: number;
  bans: number;
  cookies: Cookie[];
  ready: boolean;
}

export interface PooledSession {
  readonly id: string;
  /** The context it belongs to (a `SessionPool.key`). */
  readonly context: string;
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

  private readonly store: StateStore | undefined;
  private readonly syncMs: number;
  private readonly pulledAt = new Map<string, number>();

  constructor(options: SessionPoolOptions = {}) {
    this.size = options.size ?? 8;
    this.maxAgeMs = (options.maxAge ?? 4 * 3600) * 1000;
    this.maxBans = options.maxBans ?? 3;
    this.store = options.store ? resilient(options.store) : undefined;
    this.syncMs = (options.syncEvery ?? 5) * 1000;
  }

  static key(context: NonNullable<ExtractRequest['sessionContext']>): string {
    return JSON.stringify([...context].map(({ name, value }) => [name, value]).sort());
  }

  /**
   * The least busy live session of the context, or a new one while the pool has room. Sessions
   * in `exclude` (failed earlier in the same request) are skipped; if only they remain, one of
   * them is replaced, so a retry never goes back through the exit that was just banned.
   */
  async acquire(key: string, exclude: ReadonlySet<string> = new Set()): Promise<PooledSession> {
    if (this.store && Date.now() - (this.pulledAt.get(key) ?? 0) >= this.syncMs) await this.pull(key);
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
      session = { id: randomSessionId(), context: key, jar: new CookieJar(), createdAt: now, bans: 0, inFlight: 0 };
      pool.push(session);
      const created = session;
      this.update(key, (shared) => [...shared, toShared(created, false)]);
    }
    session.inFlight++;
    return session;
  }

  release(session: PooledSession, outcome: 'ok' | 'ban'): void {
    session.inFlight = Math.max(0, session.inFlight - 1);
    if (outcome !== 'ban') return;
    session.bans++;
    this.update(session.context, (shared) => shared.map((s) => (s.id === session.id ? { ...s, bans: Math.max(s.bans + 1, session.bans) } : s)));
  }

  /** After a successful attempt: shares the session's cookies, and that it's initialized. */
  save(session: PooledSession): void {
    this.update(session.context, (shared) =>
      shared.some((s) => s.id === session.id) ? shared.map((s) => (s.id === session.id ? toShared(session, true) : s)) : [...shared, toShared(session, true)],
    );
  }

  /** Drops a session whose initialization failed. */
  discard(key: string, session: PooledSession): void {
    this.pools.set(key, (this.pools.get(key) ?? []).filter((s) => s !== session));
    this.update(key, (shared) => shared.filter((s) => s.id !== session.id));
  }

  private storeKey(key: string): string {
    return `sessions:${createHash('sha256').update(key).digest('base64url')}`;
  }

  /** Brings the shared sessions of a context into this process: new ones, bans, cookies, readiness. */
  private async pull(key: string): Promise<void> {
    this.pulledAt.set(key, Date.now());
    const value = await this.store!.get(this.storeKey(key));
    if (!value) return;
    const pool = this.pools.get(key) ?? [];
    for (const shared of JSON.parse(value) as SharedSession[]) {
      const local = pool.find((s) => s.id === shared.id);
      if (!local) {
        pool.push({
          id: shared.id,
          context: key,
          jar: new CookieJar(shared.cookies),
          createdAt: shared.createdAt,
          bans: shared.bans,
          inFlight: 0,
          ...(shared.ready && { ready: Promise.resolve() }),
        });
        continue;
      }
      local.bans = Math.max(local.bans, shared.bans);
      local.jar.merge(new CookieJar(shared.cookies));
      if (shared.ready) local.ready ??= Promise.resolve();
    }
    this.pools.set(key, pool);
  }

  /** Read, change, write a context's shared sessions, in the background; nothing waits on it. */
  private update(key: string, change: (shared: SharedSession[]) => SharedSession[]): void {
    const store = this.store;
    if (!store) return;
    const storeKey = this.storeKey(key);
    void store.get(storeKey).then((value) => {
      const now = Date.now();
      const next = change(value ? (JSON.parse(value) as SharedSession[]) : []).filter(
        (s) => s.bans < this.maxBans && now - s.createdAt < this.maxAgeMs,
      );
      return store.set(storeKey, JSON.stringify(next), this.maxAgeMs / 1000);
    });
  }
}

function toShared(session: PooledSession, ready: boolean): SharedSession {
  return { id: session.id, createdAt: session.createdAt, bans: session.bans, cookies: session.jar.all(), ready };
}
