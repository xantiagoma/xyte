import type { components } from './zyte.gen.ts';

/** Every schema of the Zyte API OpenAPI spec, as generated. */
export type ZyteSchemas = components['schemas'];

export type CountryCode = ZyteSchemas['CountryCode'];
export type Action = ZyteSchemas['ActionSequence'][number];
export type ActionName = Action['action'];
export type ActionResult = ZyteSchemas['ActionResult'];
export type ActionSelector = ZyteSchemas['ActionSelector'];
export type Cookie = ZyteSchemas['Cookie'];
export type HttpHeader = ZyteSchemas['HTTPHeader'];
export type CapturedResponse = ZyteSchemas['CapturedResponse'];
export type NetworkCaptureFilter = ZyteSchemas['UrlFilter'] | ZyteSchemas['ResourceTypeFilter'];
export type Problem = ZyteSchemas['Problem'];

/**
 * The body of `POST https://api.zyte.com/v1/extract`.
 *
 * Loosened from the spec where Zyte itself is lenient: `geolocation` in any case, the network
 * capture filters as the union the spec describes in prose, and `echoData` as any JSON.
 */
export type ExtractRequest = Omit<
  ZyteSchemas['ExtractRequest'],
  'geolocation' | 'networkCapture' | 'echoData'
> & {
  geolocation?: CountryCode | Lowercase<CountryCode>;
  networkCapture?: NetworkCaptureFilter[];
  echoData?: unknown;
};

/** The 200 body of `POST /v1/extract`. */
export type ExtractResponse = Omit<ZyteSchemas['Response200'], 'echoData'> & {
  echoData?: unknown;
};

/** Zyte's AI extraction outputs. xyte runs them only through user-supplied extractors. */
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
export type ExtractionField = (typeof EXTRACTION_FIELDS)[number];
