/**
 * Zyte API coverage: every request field, response field and action of the spec, classified.
 *
 * `bun scripts/coverage.ts` regenerates docs/coverage.md. test/coverage.test.ts fails when the
 * spec has an entry missing here (e.g. after `bun run gen:types` picks up a new Zyte field) or
 * when docs/coverage.md is stale.
 */

import { BROWSER_ONLY, BROWSER_OUTPUTS, HTTP_ONLY } from '../src/fields.ts';
import { EXTRACTION_FIELDS } from '../src/types.ts';

export type Status = 'supported' | 'partial' | 'pluggable' | 'accepted' | 'unsupported';

export interface Entry {
  status: Status;
  note?: string;
}

const EXTRACTOR = '`llmExtractors()` with any LLM (Zyte output schema), or your own `extractors.<field>`; 400 without one.';
const EXTRACTOR_OPTIONS = 'Passed to your extractor as `options`; `extractFrom` picks HTTP or browser.';

export const REQUEST: Record<string, Entry> = {
  url: { status: 'supported', note: 'IP-address hosts are accepted too (Zyte rejects them).' },
  requestHeaders: { status: 'supported', note: '`referer`, on HTTP and browser requests.' },
  tags: { status: 'supported', note: 'No Stats API to send them to: they label the `onRequest` / `onAttempt` reports and request logs instead, for your own analytics.' },
  ipType: { status: 'partial', note: 'Reaches the provider as `ctx.ipType`; `byIpType()` routes on it. Presets ignore it.' },
  httpRequestMethod: { status: 'supported' },
  httpRequestBody: { status: 'supported' },
  httpRequestText: { status: 'supported' },
  customHttpRequestHeaders: { status: 'supported', note: 'A `Cookie` header is dropped, as on Zyte: cookies go in `requestCookies` ([authentication](authentication.md)). On a browser request, Zyte answers 422 (checked live).' },
  httpResponseBody: { status: 'supported', note: 'Truncated at 10 MB.' },
  httpResponseHeaders: { status: 'supported', note: 'HTTP and browser (main document) requests.' },
  browserHtml: { status: 'supported', note: 'Playwright Chromium, or your own `browser.launch`.' },
  screenshot: { status: 'supported' },
  screenshotOptions: { status: 'supported', note: '`format`, `fullPage`.' },
  extractFrom: { status: 'pluggable', note: 'Picks HTTP vs browser for extractors; `userHtml` is not supported.' },
  article: { status: 'pluggable', note: EXTRACTOR },
  articleOptions: { status: 'pluggable', note: EXTRACTOR_OPTIONS },
  articleList: { status: 'pluggable', note: EXTRACTOR },
  articleListOptions: { status: 'pluggable', note: EXTRACTOR_OPTIONS },
  articleNavigation: { status: 'pluggable', note: EXTRACTOR },
  articleNavigationOptions: { status: 'pluggable', note: EXTRACTOR_OPTIONS },
  forumThread: { status: 'pluggable', note: EXTRACTOR },
  forumThreadOptions: { status: 'pluggable', note: EXTRACTOR_OPTIONS },
  jobPosting: { status: 'pluggable', note: EXTRACTOR },
  jobPostingOptions: { status: 'pluggable', note: EXTRACTOR_OPTIONS },
  jobPostingNavigation: { status: 'pluggable', note: EXTRACTOR },
  jobPostingNavigationOptions: { status: 'pluggable', note: EXTRACTOR_OPTIONS },
  pageContent: { status: 'pluggable', note: EXTRACTOR },
  pageContentOptions: { status: 'pluggable', note: EXTRACTOR_OPTIONS },
  markdown: {
    status: 'supported',
    note: "Built in and non-AI, like Zyte's: dependency-free converter with heuristic main-content detection. `extractors.markdown` overrides it.",
  },
  markdownOptions: { status: 'supported', note: '`scope` (`mainContent` / `fullPage`), `extractFrom`.' },
  product: { status: 'pluggable', note: EXTRACTOR },
  productOptions: { status: 'pluggable', note: EXTRACTOR_OPTIONS },
  productList: { status: 'pluggable', note: EXTRACTOR },
  productListOptions: { status: 'pluggable', note: EXTRACTOR_OPTIONS },
  productNavigation: { status: 'pluggable', note: EXTRACTOR },
  productNavigationOptions: { status: 'pluggable', note: EXTRACTOR_OPTIONS },
  customAttributes: { status: 'pluggable', note: EXTRACTOR },
  customAttributesOptions: { status: 'pluggable', note: EXTRACTOR_OPTIONS },
  serp: { status: 'pluggable', note: EXTRACTOR },
  serpOptions: { status: 'pluggable', note: EXTRACTOR_OPTIONS },
  geolocation: { status: 'supported', note: 'Encoded into the provider credentials. With `direct()`, plain `proxyUrl()` or a `template()` without `{country}` it can\'t be applied: the request runs with an `X-Xyte-Warning` header / `onWarning`.' },
  javascript: { status: 'supported' },
  actions: { status: 'supported', note: 'All of them; `searchKeyword`, `setLocation` and `interaction` through handlers or `zyteApi()` (see Actions).' },
  jobId: { status: 'supported', note: 'Echoed back.' },
  echoData: { status: 'supported' },
  viewport: { status: 'supported' },
  followRedirect: { status: 'supported', note: 'HTTP requests (browsers always follow, as on Zyte).' },
  sessionContext: {
    status: 'supported',
    note: 'In-process pool per context (default 8 sessions; retired after 4 h or 3 bans, as on Zyte). Not shared across instances.',
  },
  sessionContextParameters: {
    status: 'partial',
    note: '`actions` run once per new session in a browser at the request URL, through the provider resolved for it (an API provider keeps its own sessions: no local init). Zyte\'s own actions run through `actions` handlers; without one, skipped with a warning, or a 400 with `unsupportedActions: \'error\'` (no pass-overs during init).',
  },
  session: { status: 'supported', note: 'Sticky exit IP through the provider, plus a cookie jar kept in memory per process.' },
  networkCapture: { status: 'supported', note: '`url` and `resourceType` filters; max 10 captures / 5 MiB.' },
  device: { status: 'supported', note: 'Mobile user agent and client hints; mobile viewport in the browser.' },
  cookieManagement: { status: 'supported' },
  requestCookies: { status: 'supported' },
  responseCookies: { status: 'supported' },
  includeIframes: {
    status: 'partial',
    note: "Each frame's document is written into its `<iframe>` element; Zyte doesn't document its exact format.",
  },
};

export const RESPONSE: Record<string, Entry> = {
  url: { status: 'supported', note: 'Final URL after redirects.' },
  statusCode: { status: 'supported' },
  httpResponseBody: { status: 'supported' },
  httpResponseHeaders: { status: 'supported' },
  browserHtml: { status: 'supported' },
  markdown: { status: 'supported' },
  session: { status: 'supported', note: 'Echoes the request `session`.' },
  screenshot: { status: 'supported' },
  article: { status: 'pluggable' },
  articleList: { status: 'pluggable' },
  articleNavigation: { status: 'pluggable' },
  forumThread: { status: 'pluggable' },
  jobPosting: { status: 'pluggable' },
  jobPostingNavigation: { status: 'pluggable' },
  pageContent: { status: 'pluggable' },
  product: { status: 'pluggable' },
  productList: { status: 'pluggable' },
  productNavigation: { status: 'pluggable' },
  customAttributes: { status: 'pluggable' },
  echoData: { status: 'supported' },
  jobId: { status: 'supported' },
  actions: { status: 'partial', note: '`action`, `elapsedTime`, `status`, `error`; no `interactionLogs`.' },
  responseCookies: { status: 'supported' },
  networkCapture: { status: 'partial', note: '`url`, `statusCode`, `headers`, `httpResponseBody`, `filter`; no `request` / `interceptionStatus`.' },
  serp: { status: 'pluggable' },
};

export const ACTIONS: Record<string, Entry> = {
  click: { status: 'supported', note: '`button`, `delay`, `waitForNavigationTimeout`.' },
  doubleClick: { status: 'supported' },
  evaluate: { status: 'supported', note: 'Runs as a script without awaiting its promises, like Zyte.' },
  goto: { status: 'supported' },
  hide: { status: 'supported' },
  hover: { status: 'supported' },
  interaction: { status: 'pluggable', note: 'Zyte runs scripts from its cloud IDE by id: with `zyteApi()` it does; elsewhere `actions.interaction` maps ids to your own scripts. Without one: skipped with a warning (or a 400 with `unsupportedActions: \'error\'`).' },
  keyPress: { status: 'supported' },
  reload: { status: 'supported' },
  scrollBottom: { status: 'supported', note: '`timeout`, `maxScrollDelay`, `maxPageHeight`, `maxScrollCount`; `scrollStep` ignored.' },
  scrollTo: { status: 'supported' },
  searchKeyword: { status: 'partial', note: 'Built-in heuristic (`searchBox`: finds the search box, types, presses Enter); per-site handlers in `actions.searchKeyword`; Zyte\'s own with `zyteApi()`.' },
  select: { status: 'supported' },
  setLocation: { status: 'pluggable', note: 'Location forms differ per site: per-site handlers in `actions.setLocation`, Zyte\'s own with `zyteApi()`. Without one: skipped with a warning (or a 400 with `unsupportedActions: \'error\'`).' },
  type: { status: 'supported' },
  waitForNavigation: { status: 'supported', note: 'As the first action, configures the initial navigation.' },
  waitForRequest: { status: 'supported' },
  waitForResponse: { status: 'supported' },
  waitForSelector: { status: 'supported' },
  waitForTimeout: { status: 'supported' },
};

/** Zyte error responses (https://docs.zyte.com/zyte-api/usage/errors.html), not in the spec's schemas. */
export const ERRORS: Record<string, Entry> = {
  '400 /request/invalid': { status: 'supported', note: 'Malformed requests (url format, header syntax), plus fields xyte doesn\'t support.' },
  '400 /request/invalid-json': { status: 'supported', note: 'Server only.' },
  '401 /auth/key-not-found': { status: 'supported', note: 'Server with `XYTE_API_KEYS`.' },
  '403 /auth/account-suspended': { status: 'accepted', note: 'No accounts.' },
  '421 /website/domain-unreachable': { status: 'supported' },
  '422 /request/unprocessable': { status: 'supported', note: 'Incompatible parameters (`browserHtml` + `httpResponseBody`, browser-only fields on HTTP…) and requests asking for nothing, as on api.zyte.com.' },
  '429 /limits/*': { status: 'accepted', note: 'No quotas; `concurrency` queues instead.' },
  '451 /download/domain-forbidden': { status: 'accepted', note: 'Never emitted.' },
  '500 /server/timed-out': { status: 'partial', note: 'Attempt timeouts are retried, then reported as 520.' },
  '503 /limits/over-global-limit': { status: 'accepted', note: 'Never emitted.' },
  '520 /download/temporary-error': { status: 'supported', note: 'Proxy failures and network errors after retries.' },
  '520 /download/website-ban': { status: 'supported', note: 'Bans (403/429/503, challenge pages) after retries. Checked against api.zyte.com.' },
  '521 /download/internal-error': { status: 'accepted', note: 'Never emitted.' },
};

/** Zyte products beyond `/v1/extract`. */
export const OTHER: Record<string, Entry> = {
  'HTTP API `POST /v1/extract`': { status: 'supported', note: '`xyte serve`, `createHandler`, `toNodeHandler`.' },
  'Zyte API as a provider': { status: 'supported', note: '`zyteApi()` (full fidelity, e.g. as a fallback) or `zyteProxy()` (proxy mode).' },
  'Proxy mode (`api.zyte.com:8011`)': { status: 'unsupported', note: 'Planned.' },
  'CDP headless browser': { status: 'unsupported' },
  'Stats API': { status: 'unsupported' },
  'Search API': { status: 'unsupported' },
};

const ICON: Record<Status, string> = {
  supported: '✅',
  partial: '🟡',
  pluggable: '🔌',
  accepted: '⚪',
  unsupported: '❌',
};

/**
 * The kind of request a request field belongs to, from the lists the client validates with
 * (src/fields.ts): a field of the other kind is a 422, as on Zyte.
 */
export function appliesTo(field: string): string {
  const has = (list: readonly string[]) => list.includes(field);
  if (has(BROWSER_OUTPUTS)) return 'browser (makes it one)';
  if (field === 'httpResponseBody') return 'HTTP (makes it one)';
  if (has(BROWSER_ONLY)) return 'browser only';
  if (has(HTTP_ONLY)) return 'HTTP only';
  const extraction = field === 'extractFrom' || has(EXTRACTION_FIELDS) || has(EXTRACTION_FIELDS.map((f) => `${f}Options`));
  if (extraction) return 'either (`extractFrom`)';
  return 'both';
}

function table(title: string, entries: Record<string, Entry>, code = true, applies?: (name: string) => string): string {
  const rows = Object.entries(entries).map(
    ([name, { status, note }]) =>
      `| ${code ? `\`${name}\`` : name} | ${ICON[status]} ${status} |${applies ? ` ${applies(name)} |` : ''} ${note ?? ''} |`,
  );
  const head = applies ? ['| Name | Status | Applies to | Notes |', '| --- | --- | --- | --- |'] : ['| Name | Status | Notes |', '| --- | --- | --- |'];
  return [`## ${title}`, '', ...(applies ? [APPLIES_LEGEND, ''] : []), ...head, ...rows, ''].join('\n');
}

const APPLIES_LEGEND =
  'A request is an HTTP request (`httpResponseBody`, `httpResponseHeaders`, or extraction from HTTP) or a browser request ' +
  '(`browserHtml`, `screenshot`, or extraction from the browser). **Applies to** says which kind each field belongs to: ' +
  'a field of the other kind is a **422** `/request/unprocessable`, as on Zyte.';

function summary(): string {
  const count = (entries: Record<string, Entry>) => {
    const values = Object.values(entries);
    const usable = values.filter((e) => e.status === 'supported' || e.status === 'partial').length;
    return `${usable}/${values.length}`;
  };
  return [
    '| Area | Supported or partial |',
    '| --- | --- |',
    `| Request fields | ${count(REQUEST)} (+${Object.values(REQUEST).filter((e) => e.status === 'pluggable').length} pluggable) |`,
    `| Response fields | ${count(RESPONSE)} (+${Object.values(RESPONSE).filter((e) => e.status === 'pluggable').length} pluggable) |`,
    `| Browser actions | ${count(ACTIONS)} |`,
    '',
  ].join('\n');
}

export function render(): string {
  return [
    '# Zyte API coverage',
    '',
    '<!-- Generated by `bun scripts/coverage.ts` from scripts/coverage.ts. Do not edit. -->',
    '',
    'How much of the [Zyte API](https://docs.zyte.com/zyte-api/usage/reference.html) xyte implements,',
    'field by field, from the OpenAPI spec in `spec/zyte-openapi.json`. A test fails when the spec has',
    'an entry not listed here.',
    '',
    `${ICON.supported} supported · ${ICON.partial} partial · ${ICON.pluggable} pluggable (bring an extractor) · ` +
      `${ICON.accepted} accepted, no effect · ${ICON.unsupported} not supported (request fields: rejected with a 400)`,
    '',
    summary(),
    table('Request fields', REQUEST, true, appliesTo),
    table('Response fields', RESPONSE),
    table('Actions', ACTIONS),
    table('Errors', ERRORS),
    table('Beyond /v1/extract', OTHER, false),
  ].join('\n');
}

if (import.meta.main) {
  await Bun.write('docs/coverage.md', render());
  console.log('wrote docs/coverage.md');
}
