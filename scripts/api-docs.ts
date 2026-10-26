/**
 * Generates docs/api.md from the built declarations (dist/index.d.mts): every export with its doc
 * comment and its declaration, grouped below. `bun run docs:api` writes it; `--check` fails when
 * the file is out of date, an export has no group, or an export has no doc comment.
 */
import { parseSync } from 'oxc-parser';

interface Group {
  title: string;
  intro: string;
  names: string[];
}

const GROUPS: Group[] = [
  {
    "title": "Client",
    "intro": "`new Xyte(options)` and its methods. Topic pages: [configuration](configuration.md), [the client's lifecycle](lifecycle.md).",
    "names": [
      "Xyte",
      "createXyte",
      "XyteOptions",
      "ExtractOptions",
      "BatchResult",
      "decodeBody",
      "Transport",
      "TransportRequest",
      "SessionPoolOptions"
    ]
  },
  {
    "title": "Requests, responses and errors",
    "intro": "Zyte's request and response bodies, generated from Zyte's OpenAPI spec, and the errors `extract()` rejects with. Field by field: [coverage](coverage.md); errors: [the README](../README.md#errors-and-retries).",
    "names": [
      "ExtractRequest",
      "ExtractResponse",
      "ExtractionField",
      "EXTRACTION_FIELDS",
      "Action",
      "ActionName",
      "ActionResult",
      "ActionSelector",
      "Cookie",
      "HttpHeader",
      "CapturedResponse",
      "NetworkCaptureFilter",
      "CountryCode",
      "Problem",
      "ZyteSchemas",
      "XyteError",
      "XyteProblem",
      "UpstreamProblem",
      "isLikelyBan",
      "BanCheck"
    ]
  },
  {
    "title": "Providers",
    "intro": "Where requests exit. Every preset's credentials and options: [providers](providers.md).",
    "names": [
      "direct",
      "proxyUrl",
      "template",
      "custom",
      "proxyEndpointUrl",
      "oxylabs",
      "brightData",
      "decodo",
      "smartproxy",
      "iproyal",
      "nodeMaven",
      "soax",
      "netNut",
      "webshare",
      "rayobyte",
      "packetStream",
      "evomi",
      "dataImpulse",
      "massive",
      "proxySeller",
      "anyIp",
      "thordata",
      "abcProxy",
      "proxy922",
      "lunaProxy",
      "proxyEmpire",
      "rapidProxy",
      "swiftProxy",
      "zenrows",
      "scrapingBee",
      "scraperApi",
      "crawlbase",
      "scrapeDo",
      "scrapingAnt",
      "scrapeOps",
      "scrapfly",
      "oxylabsUnblocker",
      "zyteProxy",
      "zyteApi",
      "scrappey",
      "scrapingBot",
      "brightDataBrowser",
      "browserless",
      "zenrowsBrowser",
      "oxylabsBrowser",
      "nodeMavenBrowser",
      "PROVIDER_NAMES",
      "ProxyProvider",
      "ProxyEndpoint",
      "ApiEndpoint",
      "ApiResult",
      "ProxyContext",
      "EndpointOf",
      "AttemptOutcome"
    ]
  },
  {
    "title": "Combining providers",
    "intro": "Providers built from other providers. [Routing](routing.md) explains each, with examples.",
    "names": [
      "rotate",
      "route",
      "adaptive",
      "byKind",
      "byCountry",
      "byIpType",
      "weighted",
      "healthy",
      "budget",
      "watch",
      "AdaptiveOptions",
      "AdaptiveProvider",
      "HealthyOptions",
      "BudgetOptions",
      "WatchOptions",
      "WatchedProvider"
    ]
  },
  {
    "title": "Provider checks",
    "intro": "Checks for `watch()`: [routing](routing.md#watch-check-providers-ahead-of-requests).",
    "names": [
      "scrapingBeeUsage",
      "zenrowsUsage",
      "scraperApiUsage",
      "oxylabsUsage",
      "statusPage",
      "STATUS_PAGES",
      "ProviderCheck",
      "CheckResult"
    ]
  },
  {
    "title": "Shared state",
    "intro": "Where budgets, circuits, checks, `adaptive`, sessions, the cache, jobs and stats keep their state: [routing](routing.md#shared-state-across-instances-redis), [lifecycle](lifecycle.md) for closing a Redis store.",
    "names": [
      "StateStore",
      "memoryStore",
      "redisStore",
      "redisStoreFromUrl",
      "resilient",
      "RedisSend"
    ]
  },
  {
    "title": "Actions",
    "intro": "Zyte's own actions outside Zyte: [actions](actions.md).",
    "names": [
      "ActionHandlers",
      "ActionHandler",
      "ActionHandlerContext",
      "ActionEntry",
      "PerSite",
      "ById",
      "SearchKeywordAction",
      "SetLocationAction",
      "InteractionAction",
      "ZyteOnlyAction",
      "searchBox",
      "isZyteOnlyAction"
    ]
  },
  {
    "title": "Browser",
    "intro": "Renders: launching, stealth presets, remote browsers, captchas. [Browser](browser.md).",
    "names": [
      "patchright",
      "rebrowser",
      "camoufox",
      "cloakBrowser",
      "STEALTH_BROWSERS",
      "capsolver",
      "twoCaptcha",
      "createTaskSolver",
      "CaptchaSolver",
      "CaptchaTask",
      "CaptchaKind",
      "CaptchaOutcome",
      "BrowserOptions",
      "BrowserHookInfo",
      "BrowserTypeLike",
      "RemoteBrowser"
    ]
  },
  {
    "title": "Extraction",
    "intro": "AI extraction fields and Markdown: [extraction](extraction.md).",
    "names": [
      "Extractor",
      "llmExtractors",
      "openAICompatible",
      "Complete",
      "CompletionRequest",
      "Completion",
      "LlmExtractorOptions",
      "parseJson",
      "htmlToMarkdown",
      "MarkdownOptions",
      "OUTPUT_SCHEMAS",
      "OutputSchemaField"
    ]
  },
  {
    "title": "Reports, costs, cache and pacing",
    "intro": "What each request took and cost: [observability](observability.md); the cache and rate limits: [configuration](configuration.md).",
    "names": [
      "RequestReport",
      "AttemptInfo",
      "ProviderUsage",
      "usageByProvider",
      "Rate",
      "Rates",
      "rateFor",
      "attemptCost",
      "CacheOptions",
      "requestKey",
      "RateLimits",
      "SiteLimit",
      "parseLimit"
    ]
  },
  {
    "title": "Server",
    "intro": "Serving Zyte's APIs: [deploy](deploy.md), [mounting](mounting.md), [proxy mode](proxy-mode.md).",
    "names": [
      "createHandler",
      "HandlerOptions",
      "FetchHandler",
      "toNodeHandler",
      "serve",
      "isPrivateTarget",
      "Jobs",
      "Job",
      "JobsOptions",
      "verifyWebhook",
      "StatsRecorder",
      "StatsOptions",
      "StatsQuery",
      "StatsResponse",
      "StatsQueryError",
      "serveProxyMode",
      "attachProxyMode",
      "ProxyModeOptions",
      "proxiedRequest",
      "createCertificateAuthority",
      "issueCertificate",
      "CertificateAuthority"
    ]
  },
  {
    "title": "Configuration from the environment",
    "intro": "What the CLI builds from `process.env`; each takes an `env` to read instead. [Configuration](configuration.md#environment-variables).",
    "names": [
      "proxyFromEnv",
      "browserFromEnv",
      "extractorsFromEnv",
      "cacheFromEnv",
      "rateLimitsFromEnv",
      "ratesFromEnv",
      "sessionsFromEnv",
      "jobsFromEnv",
      "statsFromEnv",
      "caFromEnv",
      "closeSharedStores"
    ]
  },
  {
    "title": "Tools",
    "intro": "`xyte doctor`'s checks, as functions.",
    "names": [
      "doctor",
      "formatDoctor",
      "DoctorOptions",
      "DoctorResult"
    ]
  }
];

const root = new URL('..', import.meta.url).pathname;
const src = await Bun.file(`${root}dist/index.d.mts`).text();
const { program, comments } = parseSync('index.d.mts', src);

interface Entry {
  doc: string;
  code: string;
}
const entries = new Map<string, Entry>();
/** Public class members without a doc comment, as `Class.member`. */
const undocumentedMembers: string[] = [];
const exported = new Set<string>();
type Node = { type: string; start: number; end: number; id?: { name: string }; declarations?: { id: { name: string } }[]; declaration?: Node };
const nameOf = (node: Node) => node.id?.name ?? node.declarations?.[0]?.id.name;

/** The /** comment right before `start`, as Markdown. */
function docBefore(start: number): string {
  const comment = comments.findLast((c) => c.end <= start);
  if (!comment || comment.type !== 'Block' || !comment.value.startsWith('*') || src.slice(comment.end, start).trim() !== '') return '';
  return comment.value
    .slice(1)
    .split('\n')
    .map((line) => line.replace(/^\s*\* ?/, ''))
    .join('\n')
    .trim();
}

type Member = { start: number; end: number; accessibility?: string; key?: { type: string } };

/** Where a node's /** comment starts, else the node itself. */
function startWithDoc(start: number): number {
  const comment = comments.findLast((c) => c.end <= start);
  return comment && comment.type === 'Block' && src.slice(comment.end, start).trim() === '' ? comment.start : start;
}

/** The declaration as a reader needs it: no `declare`/`export`, and no private class members (nor their comments). */
function codeOf(node: Node): string {
  const members = node.type === 'ClassDeclaration' ? ((node as unknown as { body: { body: Member[] } }).body.body) : [];
  const hidden = members
    .filter((m) => m.accessibility === 'private' || m.key?.type === 'PrivateIdentifier')
    .map((m) => [startWithDoc(m.start), m.end] as const);
  let text = '';
  let at = node.start;
  for (const [from, to] of hidden) {
    text += src.slice(at, from).replace(/[ \t]+$/, '');
    at = to;
    // Drop the rest of the hidden member's line.
    while (src[at] === ';' || src[at] === ' ') at++;
    if (src[at] === '\n') at++;
  }
  text += src.slice(at, node.end);
  return text.replace(/^(export )?(declare )?/, '').replace(/\n\s*\n/g, '\n');
}

for (const statement of program.body as unknown as Node[]) {
  const node = statement.type === 'ExportNamedDeclaration' && statement.declaration ? statement.declaration : statement;
  const name = nameOf(node);
  if (name) entries.set(name, { doc: docBefore(statement.start), code: codeOf(node) });
  if (name && node.type === 'ClassDeclaration') {
    for (const member of (node as unknown as { body: { body: (Member & { kind?: string; key?: { name?: string } })[] } }).body.body) {
      if (member.accessibility === 'private' || member.key?.type === 'PrivateIdentifier' || member.kind === 'constructor') continue;
      if (!docBefore(member.start)) undocumentedMembers.push(`${name}.${member.key?.name ?? src.slice(member.start, member.end).split('(')[0]!.trim()}`);
    }
  }
  if (statement.type === 'ExportNamedDeclaration') {
    if (statement.declaration && name) exported.add(name);
    for (const specifier of (statement as unknown as { specifiers: { exported: { name: string } }[] }).specifiers ?? []) exported.add(specifier.exported.name);
  }
}

const grouped = new Set(GROUPS.flatMap((g) => g.names));
const problems = [
  ...[...exported].filter((name) => !grouped.has(name)).map((name) => `${name}: exported but in no group (add it to GROUPS in scripts/api-docs.ts)`),
  ...[...grouped].filter((name) => !exported.has(name)).map((name) => `${name}: in a group but not exported`),
  ...[...exported].filter((name) => !entries.get(name)?.doc).map((name) => `${name}: no doc comment`),
  ...undocumentedMembers.filter((member) => exported.has(member.split('.')[0]!)).map((member) => `${member}: no doc comment`),
];

const anchor = (title: string) => title.toLowerCase().replace(/[^a-z0-9 -]/g, '').replace(/ /g, '-');
const lines: string[] = [
  '# API reference',
  '',
  '<!-- Generated by scripts/api-docs.ts from the doc comments in src/: edit those, then run `bun run docs:api`. -->',
  '',
  "Everything `xyte` exports, with its doc comment and its TypeScript declaration (fields and",
  "parameters are documented inside it). Types are TypeScript-only (`import type`).",
  '',
  '```ts',
  "import { Xyte, oxylabs, decodeBody } from 'xytejs';",
  '```',
  '',
  ...GROUPS.map((g) => `- [${g.title}](#${anchor(g.title)}): ${g.names.map((n) => `\`${n}\``).join(', ')}`),
  '',
];
for (const group of GROUPS) {
  lines.push(`## ${group.title}`, '', group.intro, '');
  for (const name of group.names) {
    const entry = entries.get(name);
    if (!entry) continue;
    lines.push(`### \`${name}\``, '');
    if (entry.doc) lines.push(entry.doc, '');
    lines.push('```ts', entry.code, '```', '');
  }
}
const markdown = `${lines.join('\n').trimEnd()}\n`;
const target = `${root}docs/api.md`;

if (process.argv.includes('--check')) {
  if ((await Bun.file(target).text()) !== markdown) problems.push('docs/api.md is out of date: run `bun run build && bun run docs:api`');
  if (problems.length > 0) {
    console.error(problems.join('\n'));
    process.exit(1);
  }
  console.log(`docs/api.md: ${exported.size} exports, up to date`);
} else {
  await Bun.write(target, markdown);
  if (problems.length > 0) console.warn(problems.join('\n'));
  console.log(`docs/api.md: ${exported.size} exports`);
}
