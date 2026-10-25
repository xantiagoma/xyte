// Runs the same Zyte requests through several providers and compares them: how often each one
// gets the real page (not a challenge), how fast, and how many bytes (what per-GB proxies bill).
//
//   bun scripts/bench.ts cases.json [--providers zyte-api,direct,scrapingbee] [--repeat 3] [--out results.json] [--save dir]
//
// --save writes every page that failed the check to dir/, to see what the provider got instead.
//
// cases.json: [{ "name": "…", "request": { …Zyte request… }, "expect": "regex the page must match",
//                "providers": ["…"] (optional, overrides --providers for this case) }]
// Provider names are XYTE_PROVIDER names, credentials from the environment (.env); "direct" is no proxy.
import { parseArgs } from 'node:util';
import { browserFromEnv, decodeBody, proxyFromEnv, Xyte, XyteError, type ExtractRequest } from '../src/index.ts';

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
const client = (provider: string): Xyte => {
  let xyte = clients.get(provider);
  if (!xyte) {
    const env = { ...process.env, XYTE_PROVIDER: provider === 'direct' ? '' : provider, XYTE_PROXY_URL: '', XYTE_PROXY_TEMPLATE: '' };
    xyte = new Xyte({ proxy: proxyFromEnv(env), browser: browserFromEnv(env), onWarning: () => {} });
    clients.set(provider, xyte);
  }
  return xyte;
};

async function runOnce(c: Case, provider: string): Promise<Run> {
  const started = performance.now();
  const base = { case: c.name, provider };
  try {
    const res = await client(provider).extract(c.request);
    const ms = Math.round(performance.now() - started);
    const page = res.browserHtml ?? (res.httpResponseBody ? decodeBody(res.httpResponseBody) : '');
    const bytes = new TextEncoder().encode(page).byteLength;
    const ok = res.statusCode === 200 && new RegExp(c.expect).test(page);
    if (!ok && values.save) {
      await Bun.write(`${values.save}/${c.name.replace(/\W+/g, '-')}.${provider}.${Date.now()}.html`, page);
    }
    return { ...base, ok, ms, bytes, outcome: ok ? 'ok' : `${res.statusCode}, ${bytes} B, no match` };
  } catch (error) {
    const ms = Math.round(performance.now() - started);
    const outcome = error instanceof XyteError ? `${error.status} ${error.type}` : String(error).slice(0, 80);
    return { ...base, ok: false, ms, bytes: 0, outcome };
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
    return `| ${c.name} | ${provider} | ${good.length}/${mine.length} | ${median(good.map((r) => r.ms)) || '–'} | ${good.length ? Math.round(median(good.map((r) => r.bytes)) / 1024) : '–'} | ${failures} |`;
  }),
);
console.log(['| Case | Provider | Real page | Median ms | Median KB | Failures |', '| --- | --- | --- | --- | --- | --- |', ...rows].join('\n'));

if (values.out) await Bun.write(values.out, JSON.stringify(runs, null, 2));
