import type { components } from './zyte.gen.ts';

/** Every schema of the Zyte API OpenAPI spec, as generated. */
export type ZyteSchemas = components['schemas'];

/** An ISO 3166-1 alpha-2 country code, as `geolocation` takes (`US`, `DE`…). */
export type CountryCode = ZyteSchemas['CountryCode'];
/** One browser action (`click`, `type`, `scrollBottom`, `waitForSelector`…), as in `actions`. */
export type Action = ZyteSchemas['ActionSequence'][number];
/** The name of an action: `click`, `type`, `searchKeyword`… */
export type ActionName = Action['action'];
/** What happened to one action, in the response's `actions`: `status`, `error`, `elapsedTime`. */
export type ActionResult = ZyteSchemas['ActionResult'];
/** How an action finds its element: `{ type: 'css' | 'xpath', value }`. */
export type ActionSelector = ZyteSchemas['ActionSelector'];
/** A cookie, as in `requestCookies` and `responseCookies`. */
export type Cookie = ZyteSchemas['Cookie'];
/** A header as a `{ name, value }` pair, as Zyte lists them (`httpResponseHeaders`, `customHttpRequestHeaders`). */
export type HttpHeader = ZyteSchemas['HTTPHeader'];
/** One response a browser render captured (`networkCapture`): its URL, status, headers and body. */
export type CapturedResponse = ZyteSchemas['CapturedResponse'];
/** Which responses `networkCapture` keeps: by URL, or by resource type. */
export type NetworkCaptureFilter = ZyteSchemas['UrlFilter'] | ZyteSchemas['ResourceTypeFilter'];
/** Zyte's error body as the spec has it. `XyteProblem` is the same with the fields xyte always sets. */
export type Problem = ZyteSchemas['Problem'];

/**
 * The body of `POST https://api.zyte.com/v1/extract`.
 *
 * Loosened from the spec where Zyte itself is lenient: `geolocation` in any case, the network
 * capture filters as the union the spec describes in prose, and `echoData` as any JSON.
 */
export type ExtractRequest = Omit<
  ZyteSchemas['ExtractRequest'],
  'geolocation' | 'networkCapture' | 'echoData' | 'tags'
> & {
  geolocation?: CountryCode | Lowercase<CountryCode>;
  networkCapture?: NetworkCaptureFilter[];
  echoData?: unknown;
  /** Labels for the request. "Values must be strings or `null`" (Zyte's docs; the schema says strings only). */
  tags?: Record<string, string | null>;
};

/** The 200 body of `POST /v1/extract`. */
export type ExtractResponse = Omit<ZyteSchemas['Response200'], 'echoData'> & {
  echoData?: unknown;
};

/** Zyte's extraction outputs. `markdown` has a built-in converter; the others need an extractor (`extractors` option, or `llmExtractors()`). */
export const EXTRACTION_FIELDS = [
  'product',
  'productList',
  'productNavigation',
  'article',
  'articleList',
  'articleNavigation',
  'forumThread',
  'jobPosting',
  'jobPostingNavigation',
  'pageContent',
  'serp',
  'customAttributes',
  'markdown',
] as const;
/** One of `EXTRACTION_FIELDS`: `product`, `article`, … `markdown`. */
export type ExtractionField = (typeof EXTRACTION_FIELDS)[number];
