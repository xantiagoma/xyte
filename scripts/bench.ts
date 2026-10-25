// Runs the same Zyte requests through several providers and compares them: how often each one
// gets the real page (not a challenge), how fast, and what it uses per 1,000 real pages: attempts
// (what per-request APIs bill, retries included) and MB on the wire (what per-GB proxies bill).
// Multiply by your own rates: volume discounts and plans differ too much to bake prices in.
//
//   bun scripts/bench.ts cases.json [--providers zyte-api,direct,scrapingbee] [--repeat 3] [--out results.json] [--save dir]
//
// --save writes every page that failed the check to dir/, to see what the provider got instead.
//
// cases.json: [{ "name": "…", "request": { …Zyte request… }, "expect": "regex the page must match",
//                "providers": ["…"] (optional, overrides --providers for this case) }]
// Provider names are XYTE_PROVIDER names, credentials from the environment (.env); "direct" is no proxy.
import { parseArgs } from 'node:util';
import { browserFromEnv, decodeBody, proxyFromEnv, ratesFromEnv, Xyte, XyteError, type ExtractRequest } from '../src/index.ts';

interface Case {
  name: string;
  request: ExtractRequest;
  expect: string;
  providers?: string[];
}

interface Run {
  case: string;
  provider: string;
  ok: boolean;
  ms: number;
  bytes: number;
  outcome: string;
  /** Attempts the request took (retries included) and bytes they moved on the wire. */
  attempts: number;
  transferBytes: number;
  costUsd: number;
}

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    providers: { type: 'string', default: 'zyte-api,direct' },
    repeat: { type: 'string', default: '3' },
    out: { type: 'string' },
    save: { type: 'string' },
  },
});
if (!positionals[0]) throw new Error('usage: bun scripts/bench.ts cases.json [--providers a,b] [--repeat 3] [--out results.json]');

const cases: Case[] = await Bun.file(positionals[0]).json();
const repeat = Number(values.repeat);
const defaultProviders = values.providers!.split(',').map((p) => p.trim());

const clients = new Map<string, Xyte>();
const current = new Map<string, { attempts: number; transferBytes: number; costUsd: number }>();
// XYTE_RATES (your prices) adds a $ / 1k pages column.
const rates = ratesFromEnv(process.env);
const client = (provider: string): Xyte => {
  let xyte = clients.get(provider);
  if (!xyte) {
    const env = { ...process.env, XYTE_PROVIDER: provider === 'direct' ? '' : provider, XYTE_PROXY_URL: '', XYTE_PROXY_TEMPLATE: '' };
    xyte = new Xyte({
      proxy: proxyFromEnv(env),
      browser: browserFromEnv(env),
      onWarning: () => {},
      rates,
      // Runs per provider are sequential, so the attempts land in the current run.
      onAttempt: (attempt) => {
        const usage = current.get(provider);
        if (!usage) return;
        usage.attempts++;
        usage.transferBytes += attempt.transferBytes ?? 0;
        usage.costUsd += attempt.costUsd ?? 0;
      },
    });
    clients.set(provider, xyte);
  }
  return xyte;
};

async function runOnce(c: Case, provider: string): Promise<Run> {
  const started = performance.now();
  const usage = { attempts: 0, transferBytes: 0, costUsd: 0 };
  current.set(provider, usage);
  try {
    const res = await client(provider).extract(c.request);
    const ms = Math.round(performance.now() - started);
    const page = res.browserHtml ?? (res.httpResponseBody ? decodeBody(res.httpResponseBody) : '');
    const bytes = new TextEncoder().encode(page).byteLength;
    const ok = res.statusCode === 200 && new RegExp(c.expect).test(page);
    if (!ok && values.save) {
      await Bun.write(`${values.save}/${c.name.replace(/\W+/g, '-')}.${provider}.${Date.now()}.html`, page);
    }
    return { case: c.name, provider, ...usage, ok, ms, bytes, outcome: ok ? 'ok' : `${res.statusCode}, ${bytes} B, no match` };
  } catch (error) {
    const ms = Math.round(performance.now() - started);
    const outcome = error instanceof XyteError ? `${error.status} ${error.type}` : String(error).slice(0, 80);
    return { case: c.name, provider, ...usage, ok: false, ms, bytes: 0, outcome };
  }
}

// Providers run in parallel; each provider's runs are sequential, so no provider is rate-limited
// by the benchmark itself.
const providers = [...new Set(cases.flatMap((c) => c.providers ?? defaultProviders))];
const runs = (
  await Promise.all(
    providers.map(async (provider) => {
      const mine: Run[] = [];
      for (const c of cases.filter((c) => (c.providers ?? defaultProviders).includes(provider))) {
        for (let i = 0; i < repeat; i++) {
          const run = await runOnce(c, provider);
          mine.push(run);
          console.error(`${run.ok ? 'ok  ' : 'FAIL'} ${provider.padEnd(12)} ${c.name.padEnd(28)} ${String(run.ms).padStart(6)} ms  ${run.outcome}`);
        }
      }
      return mine;
    }),
  )
).flat();
await Promise.all([...clients.values()].map((xyte) => xyte.close()));

const median = (xs: number[]): number => {
  const sorted = [...xs].sort((a, b) => a - b);
  return sorted.length ? sorted[Math.floor(sorted.length / 2)]! : 0;
};
const rows = cases.flatMap((c) =>
  (c.providers ?? defaultProviders).map((provider) => {
    const mine = runs.filter((r) => r.case === c.name && r.provider === provider);
    const good = mine.filter((r) => r.ok);
    const failures = [...new Set(mine.filter((r) => !r.ok).map((r) => r.outcome))].join('; ');
    // Everything spent, failed runs included, per page that actually came back.
    const perThousand = (total: number) => (good.length ? (total / good.length) * 1000 : undefined);
    const attempts = perThousand(mine.reduce((sum, r) => sum + r.attempts, 0));
    const megabytes = perThousand(mine.reduce((sum, r) => sum + r.transferBytes, 0) / 1e6);
    const cells = [
      c.name,
      provider,
      `${good.length}/${mine.length}`,
      median(good.map((r) => r.ms)) || '–',
      attempts === undefined ? '–' : Math.round(attempts),
      // API providers (zyteApi) bill per request and move no bytes we can count.
      megabytes === undefined || megabytes === 0 ? '–' : megabytes < 10 ? megabytes.toFixed(1) : Math.round(megabytes),
      ...(rates ? [perThousand(mine.reduce((sum, r) => sum + r.costUsd, 0))?.toFixed(2) ?? '–'] : []),
      failures,
    ];
    return `| ${cells.join(' | ')} |`;
  }),
);
console.log(
  [
    `| Case | Provider | Real page | Median ms | Attempts / 1k pages | MB / 1k pages |${rates ? ' $ / 1k pages |' : ''} Failures |`,
    `| --- | --- | --- | --- | --- | --- |${rates ? ' --- |' : ''} --- |`,
    ...rows,
  ].join('\n'),
);

if (values.out) await Bun.write(values.out, JSON.stringify(runs, null, 2));
