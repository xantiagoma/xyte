import { Xyte } from './client.ts';
import type { CheckResult } from './combinators.ts';
import { checkFor, configuredProviderNames, providerFromName } from './env.ts';
import { XyteError } from './errors.ts';
import { proxyUrl, template, type ProxyProvider } from './proxy.ts';
import { decodeBody } from './util.ts';

/** What `doctor()` found for one provider. */
export interface DoctorResult {
  provider: string;
  ok: boolean;
  /** The exit the probe saw (with the default probe URL, ipinfo.io's answer). */
  ip?: string;
  country?: string;
  city?: string;
  org?: string;
  ms?: number;
  /** Why it failed: missing credentials, rejected credentials, unreachable… */
  error?: string;
  /** A note that doesn't fail it, e.g. the exit country isn't the one asked for. */
  note?: string;
  /** Its usage API or status page, where it has one. */
  quota?: CheckResult | { error: string };
}

/** Options of `doctor()`: what to check, and how. */
export interface DoctorOptions {
  env?: Record<string, string | undefined>;
  /** Provider names (`XYTE_PROVIDER` names, or `direct`). Default: `direct` plus every one the environment configures. */
  providers?: readonly string[];
  /** What to fetch through each. Default `https://ipinfo.io/json`, which reports the exit IP and country. */
  url?: string;
  /** `geolocation` for the probe, to check providers apply it. */
  country?: string;
  /** Seconds per probe. Default 30. */
  timeout?: number;
}

/** Plain-language reasons for the usual failures. */
function explain(error: unknown): string {
  const text = error instanceof XyteError ? `${error.status} ${error.detail ?? error.title}` : String(error instanceof Error ? error.message : error);
  if (/\b407\b/.test(text)) return 'credentials rejected by the proxy (407)';
  if (/\b401\b|unauthori[sz]ed|invalid api key/i.test(text)) return 'credentials rejected (401)';
  if (/ENOTFOUND|getaddrinfo|name.*not.*resolve/i.test(text)) return 'gateway host not found';
  if (/ECONNREFUSED|ECONNRESET|socket/i.test(text)) return 'connection to the provider failed';
  if (/timed? ?out|aborted/i.test(text)) return 'timed out';
  return text.replace(/^xyte: /, '');
}

/**
 * Checks each provider end to end: its credentials are there, a request through it works (and
 * exits where it should), and its quota or status, where it has a usage API or status page.
 */
export async function doctor(options: DoctorOptions = {}): Promise<DoctorResult[]> {
  const env = options.env ?? process.env;
  const url = options.url ?? 'https://ipinfo.io/json';
  const names = options.providers ?? [
    'direct',
    ...configuredProviderNames(env),
    ...(env.XYTE_PROXY_URL ? ['XYTE_PROXY_URL'] : []),
    ...(env.XYTE_PROXY_TEMPLATE ? ['XYTE_PROXY_TEMPLATE'] : []),
  ];
  return Promise.all(
    [...new Set(names)].map(async (name): Promise<DoctorResult> => {
      let provider: ProxyProvider;
      try {
        if (name === 'XYTE_PROXY_URL') provider = proxyUrl(env.XYTE_PROXY_URL!.split(',').map((u) => u.trim()), { insecure: env.XYTE_PROXY_INSECURE === 'true' });
        else if (name === 'XYTE_PROXY_TEMPLATE') provider = template(env.XYTE_PROXY_TEMPLATE!, { insecure: env.XYTE_PROXY_INSECURE === 'true' });
        else provider = providerFromName(name, env);
      } catch (error) {
        return { provider: name, ok: false, error: explain(error) };
      }
      const result: DoctorResult = { provider: name, ok: false };
      const check = checkFor(name, env);
      const quota = check
        ? check(AbortSignal.timeout(15_000)).catch((error: unknown) => ({ error: explain(error) }))
        : Promise.resolve(undefined);
      const xyte = new Xyte({ proxy: provider, retries: 0, timeout: options.timeout ?? 30, isBan: false, onWarning: () => {} });
      const started = Date.now();
      try {
        const res = await xyte.extract({ url, httpResponseBody: true, ...(options.country && { geolocation: options.country.toUpperCase() as never }) });
        result.ms = Date.now() - started;
        result.ok = (res.statusCode ?? 200) < 400;
        if (!result.ok) result.error = `the probe URL answered ${res.statusCode}`;
        try {
          const info = JSON.parse(decodeBody(res.httpResponseBody ?? '')) as Record<string, unknown>;
          result.ip = typeof info.ip === 'string' ? info.ip : undefined;
          result.country = typeof info.country === 'string' ? info.country : undefined;
          result.city = typeof info.city === 'string' ? info.city : undefined;
          result.org = typeof info.org === 'string' ? info.org : undefined;
        } catch {
          // Not JSON: a custom probe URL. The status says enough.
        }
        if (options.country && result.country && result.country.toUpperCase() !== options.country.toUpperCase()) {
          result.note = `exits from ${result.country}, not ${options.country.toUpperCase()}: geolocation isn't applied`;
        }
      } catch (error) {
        result.ms = Date.now() - started;
        result.error = explain(error);
      } finally {
        await xyte.close();
      }
      const q = await quota;
      if (q) result.quota = q;
      return result;
    }),
  );
}

/** The results as a table for a terminal. */
export function formatDoctor(results: readonly DoctorResult[]): string {
  const rows = results.map((r) => {
    const exit = r.error ?? [r.ip, r.country, r.city, r.org].filter(Boolean).join(' · ');
    const quota = !r.quota ? '' : 'error' in r.quota ? `check failed: ${r.quota.error}` : `${r.quota.available ? '' : 'UNAVAILABLE: '}${r.quota.detail ?? ''}`;
    return [r.provider, r.ok ? 'ok' : 'FAIL', exit, r.ms === undefined ? '' : `${r.ms} ms`, [quota, r.note].filter(Boolean).join(' · ')];
  });
  const head = ['provider', 'status', 'exit / error', 'time', 'quota / notes'];
  const widths = head.map((h, i) => Math.max(h.length, ...rows.map((row) => row[i]!.length)));
  return [head, ...rows].map((row) => row.map((cell, i) => cell.padEnd(widths[i]!)).join('  ').trimEnd()).join('\n');
}
