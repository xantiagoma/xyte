/**
 * Where `budget()`, `healthy()` and `watch()` keep their state. In memory (the default) each
 * process counts on its own; with a shared store (Redis) every instance of a deployment sees the
 * same budget, the same open circuits and the same provider checks.
 */
export interface StateStore {
  /** Adds `by` (negative to give back) to a counter that expires `ttl` seconds after it's created. */
  incr(key: string, by: number, ttl: number): Promise<number>;
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttl: number): Promise<void>;
  /**
   * Releases what the store holds open, such as a Redis connection (which, with some clients, keeps
   * the process from exiting). Optional: memory stores and `redisStore(send)` have nothing to close.
   */
  close?(): Promise<void>;
}

/** State in this process. `maxEntries` caps it, dropping the least recently written first. */
export function memoryStore(options: { maxEntries?: number } = {}): StateStore {
  const entries = new Map<string, { value: string; expires: number }>();
  const put = (key: string, entry: { value: string; expires: number }) => {
    entries.delete(key);
    entries.set(key, entry);
    if (options.maxEntries !== undefined && entries.size > options.maxEntries) entries.delete(entries.keys().next().value!);
  };
  const live = (key: string) => {
    const entry = entries.get(key);
    if (entry && entry.expires <= Date.now()) {
      entries.delete(key);
      return undefined;
    }
    return entry;
  };
  return {
    async incr(key, by, ttl) {
      const entry = live(key);
      const value = Number(entry?.value ?? 0) + by;
      put(key, { value: String(value), expires: entry?.expires ?? Date.now() + ttl * 1000 });
      return value;
    },
    async get(key) {
      return live(key)?.value ?? null;
    },
    async set(key, value, ttl) {
      put(key, { value, expires: Date.now() + ttl * 1000 });
    },
  };
}

/** Sends one Redis command, e.g. `['INCRBY', 'key', '1']`, and resolves with its reply. */
export type RedisSend = (command: string[]) => Promise<unknown>;

/**
 * State in Redis, through any client: pass how to send a raw command.
 *
 * ```ts
 * redisStore((c) => bunRedis.send(c[0]!, c.slice(1)));   // Bun.redis / new Bun.RedisClient(url)
 * redisStore((c) => ioredis.call(c[0]!, ...c.slice(1))); // ioredis
 * redisStore((c) => nodeRedis.sendCommand(c));           // node-redis
 * ```
 *
 * Or `redisStoreFromUrl(url)`, which picks one of those.
 */
export function redisStore(send: RedisSend, options: { prefix?: string } = {}): StateStore {
  const prefix = options.prefix ?? 'xyte:';
  return {
    async incr(key, by, ttl) {
      const value = Number(await send(['INCRBY', prefix + key, String(by)]));
      // The first increment created the key: start its clock.
      if (value === by) await send(['EXPIRE', prefix + key, String(Math.max(1, Math.ceil(ttl)))]);
      return value;
    },
    async get(key) {
      const value = await send(['GET', prefix + key]);
      return value == null ? null : String(value);
    },
    async set(key, value, ttl) {
      await send(['SET', prefix + key, value, 'EX', String(Math.max(1, Math.ceil(ttl)))]);
    },
  };
}

/**
 * Redis at `url` (`redis://…`) with the client at hand: Bun's built-in one, else the `ioredis` or
 * `redis` package if installed. The connection opens on first use; `close()` (or `await using`)
 * closes it, which on Node with `ioredis` or `redis` is what lets the process exit.
 */
export function redisStoreFromUrl(url: string, options: { prefix?: string } = {}): StateStore & { close(): Promise<void> } & AsyncDisposable {
  type Client = { send: RedisSend; close: () => Promise<unknown> };
  let client: Promise<Client> | undefined;
  const connect = async (): Promise<Client> => {
    const bun = (globalThis as { Bun?: { RedisClient?: new (url: string) => { send(command: string, args: string[]): Promise<unknown>; close(): void } } }).Bun;
    if (bun?.RedisClient) {
      const redis = new bun.RedisClient(url);
      return { send: (command) => redis.send(command[0]!, command.slice(1)), close: async () => redis.close() };
    }
    const load = (name: string): Promise<Record<string, unknown>> => import(name);
    const ioredis = await load('ioredis').catch(() => undefined);
    if (ioredis) {
      const Redis = (ioredis.default ?? ioredis) as new (url: string) => { call(command: string, ...args: string[]): Promise<unknown>; quit(): Promise<unknown> };
      const redis = new Redis(url);
      return { send: (command) => redis.call(command[0]!, ...command.slice(1)), close: () => redis.quit() };
    }
    const nodeRedis = await load('redis').catch(() => undefined);
    if (nodeRedis) {
      const createClient = nodeRedis.createClient as (options: { url: string }) => {
        connect(): Promise<unknown>;
        sendCommand(command: string[]): Promise<unknown>;
        quit(): Promise<unknown>;
      };
      const redis = createClient({ url });
      await redis.connect();
      return { send: (command) => redis.sendCommand(command), close: () => redis.quit() };
    }
    throw new Error('xyte: a Redis store needs Bun, or the "ioredis" or "redis" package');
  };
  const store = redisStore((command) => (client ??= connect()).then((c) => c.send(command)), options);
  // Closes the connection if one was opened; the next operation opens a new one.
  const close = async () => {
    const opened = client;
    client = undefined;
    if (opened) await (await opened.catch(() => undefined))?.close().catch(() => {});
  };
  return { ...store, close, [Symbol.asyncDispose]: close };
}

/**
 * A store that never fails a request: when the shared store errors (Redis down), the operation
 * falls back to process memory and `onError` hears about it once per outage.
 */
export function resilient(store: StateStore, onError: (error: unknown) => void = (error) => console.warn('[xyte] state store unavailable, using memory:', error)): StateStore {
  const fallback = memoryStore();
  let failing = false;
  const guard =
    <A extends unknown[], R>(op: (store: StateStore) => (...args: A) => Promise<R>) =>
    async (...args: A): Promise<R> => {
      try {
        const result = await op(store)(...args);
        failing = false;
        return result;
      } catch (error) {
        if (!failing) onError(error);
        failing = true;
        return op(fallback)(...args);
      }
    };
  return {
    incr: guard((s) => s.incr.bind(s)),
    get: guard((s) => s.get.bind(s)),
    set: guard((s) => s.set.bind(s)),
    close: async () => store.close?.(),
  };
}
