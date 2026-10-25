import { memoryStore, resilient, type StateStore } from './state.ts';
import type { RequestReport } from './client.ts';

/**
 * Usage stats in the shape of Zyte's Stats API (https://docs.zyte.com/zyte-api/usage/stats/),
 * built from request reports: so a dashboard or a billing check written for Zyte reads xyte's
 * numbers by changing its base URL. `record()` takes `RequestReport`s (`onRequest`); `query()`
 * answers `/api/stats` and `/api/v1/stats` parameters.
 */
export interface StatsOptions {
  /** Where hourly buckets are kept. Default: this process's memory. Redis adds up every instance. */
  store?: StateStore;
  /** Days of stats kept. Default 31. */
  retentionDays?: number;
  /** The `organization_id` reported. Default 0; a query's own is echoed back. */
  organizationId?: number;
}

/** Histogram bucket edges: seconds for response times, micro-USD for costs. Values past the last edge go in the last bucket. */
const TIME_EDGES = [0.1, 0.2, 0.5, 1, 2, 3, 5, 8, 13, 20, 30, 45, 60, 90, 120, 180, 300];
const COST_EDGES = [0, 10, 50, 100, 250, 500, 1000, 1500, 2000, 3000, 5000, 10_000, 20_000, 50_000, 100_000, 1_000_000];

/** One domain × tag set × hour. */
interface Bucket {
  domain: string;
  tags: Record<string, string | null>;
  requests: number;
  codes: Record<string, number>;
  bytes: number;
  costMicro: number;
  timeSum: number;
  timeHist: number[];
  costHist: number[];
}

const histIndex = (edges: readonly number[], value: number) => {
  const i = edges.findIndex((edge) => value <= edge);
  return i === -1 ? edges.length - 1 : i;
};

const tagKey = (tags: Record<string, string | null>) =>
  JSON.stringify(Object.keys(tags).sort().map((k) => [k, tags[k]]));

const hourOf = (date: Date) => {
  const d = new Date(date);
  d.setUTCMinutes(0, 0, 0);
  return d;
};

export interface StatsQuery {
  organization_id?: string | number;
  start_time?: string;
  end_time?: string;
  page?: string | number;
  page_size?: string | number;
  /** Comma-separated hosts. */
  domains?: string;
  /** Comma-separated codes (`200,404`). */
  response_codes?: string;
  /** Comma-separated `tag:value` (that value) or `tag` (present), all required. */
  tags?: string;
  groupby_time?: 'hour' | 'day' | 'month' | 'year' | null;
  groupby_domain?: string | boolean;
  include_domain_health?: string | boolean;
}

export class StatsRecorder {
  private readonly store: StateStore;
  private readonly retention: number;
  /** Not yet written: hour → bucket key → bucket. Flushed in the background. */
  private pending = new Map<string, Map<string, Bucket>>();
  private flushing: Promise<void> | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly options: StatsOptions = {}) {
    this.store = options.store ? resilient(options.store) : memoryStore();
    this.retention = (options.retentionDays ?? 31) * 86_400;
  }

  /** Adds a request; flushed to the store within a second. */
  record(report: RequestReport, at: Date = new Date()): void {
    const hour = hourOf(at).toISOString();
    const tags = report.tags ?? {};
    const key = `${report.host}|${tagKey(tags)}`;
    let hourBuckets = this.pending.get(hour);
    if (!hourBuckets) this.pending.set(hour, (hourBuckets = new Map()));
    let bucket = hourBuckets.get(key);
    if (!bucket) {
      bucket = { domain: report.host, tags, requests: 0, codes: {}, bytes: 0, costMicro: 0, timeSum: 0, timeHist: TIME_EDGES.map(() => 0), costHist: COST_EDGES.map(() => 0) };
      hourBuckets.set(key, bucket);
    }
    // The target's status for an answer, the problem's for a failure, none when cancelled (as Zyte's null).
    const code = report.outcome === 'ok' ? (report.statusCode ?? 200) : report.outcome === 'error' ? (report.error?.status ?? null) : null;
    const costMicro = Math.round((report.costUsd ?? 0) * 1e6);
    const seconds = report.ms / 1000;
    bucket.requests++;
    bucket.codes[String(code)] = (bucket.codes[String(code)] ?? 0) + 1;
    bucket.bytes += report.transferBytes;
    bucket.costMicro += costMicro;
    bucket.timeSum += seconds;
    bucket.timeHist[histIndex(TIME_EDGES, seconds)]!++;
    bucket.costHist[histIndex(COST_EDGES, costMicro)]!++;
    this.timer ??= setTimeout(() => void this.flush(), 1000);
    (this.timer as { unref?: () => void }).unref?.();
  }

  /** Writes pending counts to the store (read, add, write per hour). */
  async flush(): Promise<void> {
    clearTimeout(this.timer);
    this.timer = undefined;
    await this.flushing;
    const pending = this.pending;
    this.pending = new Map();
    this.flushing = (async () => {
      for (const [hour, buckets] of pending) {
        const key = `stats:${hour}`;
        const stored = await this.store.get(key);
        const merged = new Map<string, Bucket>(stored ? (JSON.parse(stored) as [string, Bucket][]) : []);
        for (const [id, bucket] of buckets) {
          const into = merged.get(id);
          if (!into) {
            merged.set(id, bucket);
            continue;
          }
          into.requests += bucket.requests;
          into.bytes += bucket.bytes;
          into.costMicro += bucket.costMicro;
          into.timeSum += bucket.timeSum;
          for (const [code, count] of Object.entries(bucket.codes)) into.codes[code] = (into.codes[code] ?? 0) + count;
          bucket.timeHist.forEach((n, i) => (into.timeHist[i] = (into.timeHist[i] ?? 0) + n));
          bucket.costHist.forEach((n, i) => (into.costHist[i] = (into.costHist[i] ?? 0) + n));
        }
        await this.store.set(key, JSON.stringify([...merged]), this.retention);
      }
    })();
    await this.flushing;
  }

  /**
   * Stats in Zyte's shape. `currencies: 'v1'` gives `/api/v1/stats`'s per-currency `cost_micro_*`
   * arrays; otherwise `/api/stats`'s `cost_microusd_*` strings. Throws a 422-style Error for an
   * invalid query.
   */
  async query(query: StatsQuery, format: 'usd' | 'v1' = 'usd'): Promise<StatsResponse> {
    await this.flush();
    const truthy = (value: unknown) => value === true || value === 'true' || value === '1';
    const groupDomain = truthy(query.groupby_domain);
    if (truthy(query.include_domain_health) && !groupDomain) throw new StatsQueryError('include_domain_health requires groupby_domain=true');
    const groupTime = query.groupby_time ?? null;
    if (groupTime !== null && !['hour', 'day', 'month', 'year'].includes(groupTime)) throw new StatsQueryError('groupby_time must be hour, day, month or year');
    const end = query.end_time ? new Date(query.end_time) : new Date();
    const start = query.start_time ? new Date(query.start_time) : new Date(end.getTime() - 7 * 86_400_000);
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) throw new StatsQueryError('start_time and end_time must be ISO 8601 date-times');
    const page = Math.max(1, Number(query.page ?? 1) || 1);
    const pageSize = Math.min(500, Math.max(1, Number(query.page_size ?? 500) || 500));
    const domains = query.domains ? new Set(query.domains.split(',').map((d) => d.trim().toLowerCase()).filter(Boolean)) : undefined;
    const codes = query.response_codes ? new Set(query.response_codes.split(',').map((c) => c.trim())) : undefined;
    const tagFilters = (query.tags ?? '')
      .split(',')
      .map((t) => t.trim())
      .filter(Boolean)
      .map((t) => {
        const at = t.indexOf(':');
        return at === -1 ? { tag: t } : { tag: t.slice(0, at), value: t.slice(at + 1) };
      });

    const groups = new Map<string, { time?: string; domain?: string; buckets: Bucket[] }>();
    for (let hour = hourOf(start); hour <= end; hour = new Date(hour.getTime() + 3_600_000)) {
      const stored = await this.store.get(`stats:${hour.toISOString()}`);
      if (!stored) continue;
      for (const [, bucket] of JSON.parse(stored) as [string, Bucket][]) {
        if (domains && !domains.has(bucket.domain.toLowerCase())) continue;
        if (!tagFilters.every(({ tag, value }) => (value === undefined ? tag in bucket.tags : bucket.tags[tag] === value))) continue;
        // With response_codes, the count is of those codes; times and costs stay the bucket's (they aren't kept per code).
        const kept = codes ? Object.fromEntries(Object.entries(bucket.codes).filter(([c]) => codes.has(c))) : bucket.codes;
        const filtered = codes ? { ...bucket, codes: kept, requests: Object.values(kept).reduce((a, b) => a + b, 0) } : bucket;
        if (codes && filtered.requests === 0) continue;
        const time = groupTime ? truncate(hour, groupTime) : undefined;
        const id = `${time ?? ''}|${groupDomain ? bucket.domain : ''}`;
        let group = groups.get(id);
        if (!group) groups.set(id, (group = { time, ...(groupDomain && { domain: bucket.domain }), buckets: [] }));
        group.buckets.push(filtered);
      }
    }

    const organization_id = Number(query.organization_id ?? this.options.organizationId ?? 0);
    const results = [...groups.values()]
      .sort((a, b) => (a.time ?? '').localeCompare(b.time ?? '') || (a.domain ?? '').localeCompare(b.domain ?? ''))
      .map((group) => summarize(group, organization_id, groupTime, format, truthy(query.include_domain_health)));
    return {
      page,
      page_size: pageSize,
      results: results.slice((page - 1) * pageSize, page * pageSize),
      total_result_count: results.length,
    };
  }
}

export class StatsQueryError extends Error {}

export interface StatsResponse {
  page: number;
  page_size: number;
  results: Record<string, unknown>[];
  total_result_count: number;
}

function truncate(hour: Date, unit: 'hour' | 'day' | 'month' | 'year'): string {
  const d = new Date(hour);
  if (unit !== 'hour') d.setUTCHours(0);
  if (unit === 'month' || unit === 'year') d.setUTCDate(1);
  if (unit === 'year') d.setUTCMonth(0);
  return d.toISOString();
}

/** The value at the 80th percentile of a histogram: the upper edge of the bucket that reaches it. */
function p80(hist: readonly number[], edges: readonly number[]): number {
  const total = hist.reduce((a, b) => a + b, 0);
  if (total === 0) return 0;
  let seen = 0;
  for (let i = 0; i < hist.length; i++) {
    seen += hist[i]!;
    if (seen / total >= 0.8) return edges[i]!;
  }
  return edges[edges.length - 1]!;
}

function summarize(
  group: { time?: string; domain?: string; buckets: Bucket[] },
  organizationId: number,
  groupTime: string | null,
  format: 'usd' | 'v1',
  domainHealth: boolean,
): Record<string, unknown> {
  const sum = (pick: (b: Bucket) => number) => group.buckets.reduce((total, b) => total + pick(b), 0);
  const requests = sum((b) => b.requests);
  const add = (hists: number[][]) => hists.reduce((acc, h) => acc.map((n, i) => n + (h[i] ?? 0)));
  const timeHist = add(group.buckets.map((b) => b.timeHist));
  const costHist = add(group.buckets.map((b) => b.costHist));
  const codes = new Map<string, number>();
  for (const b of group.buckets) for (const [c, n] of Object.entries(b.codes)) codes.set(c, (codes.get(c) ?? 0) + n);
  const costTotal = sum((b) => b.costMicro);
  const costAvg = requests ? costTotal / requests : 0;
  const costP80 = p80(costHist, COST_EDGES);
  const result: Record<string, unknown> = {
    organization_id: organizationId,
    request_count: requests,
    billed_traffic_bytes: sum((b) => b.bytes),
    response_time_sec_avg: (requests ? sum((b) => b.timeSum) / requests : 0).toFixed(2),
    response_time_sec_p80: p80(timeHist, TIME_EDGES).toFixed(2),
    status_codes: [...codes]
      .map(([code, count]) => ({ code: code === 'null' ? null : Number(code), count }))
      .sort((a, b) => (a.code ?? -1) - (b.code ?? -1)),
  };
  if (format === 'v1') {
    result.cost_micro_total = [{ currency: 'USD', value: costTotal }];
    result.cost_micro_avg = [{ currency: 'USD', value: Math.round(costAvg) }];
    result.cost_micro_p80 = [{ currency: 'USD', value: costP80 }];
  } else {
    result.cost_microusd_total = costTotal.toFixed(2);
    result.cost_microusd_avg = costAvg.toFixed(2);
    result.cost_microusd_p80 = costP80.toFixed(2);
  }
  if (group.time && groupTime) result[groupTime] = group.time;
  if (group.domain !== undefined) result.domain = group.domain;
  // Zyte's domain health compares you with all its customers: there is no equivalent here.
  if (domainHealth) result.domain_health = null;
  return result;
}
