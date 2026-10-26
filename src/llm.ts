/**
 * AI extraction (`product`, `article`, `jobPosting`, `customAttributes`…) through any LLM.
 *
 * The page is converted to Markdown, and the model is asked for JSON matching Zyte's own output
 * schema for the field (bundled from the OpenAPI spec in schemas.gen.ts), so responses keep
 * Zyte's shape. Bring the model: `openAICompatible()` covers OpenAI, OpenRouter, Groq, Together,
 * Ollama, vLLM, LM Studio and Anthropic's OpenAI-compatible endpoint; or write `complete` yourself.
 */
import type { Extractor } from './client.ts';
import { htmlToMarkdown } from './markdown.ts';
import { OUTPUT_SCHEMAS, type OutputSchemaField } from './schemas.gen.ts';
import type { ExtractionField } from './types.ts';

/** One model call `llmExtractors()` makes: a prompt for one extraction field, and the schema to answer in. */
export interface CompletionRequest {
  /** The extraction field, e.g. `product`. */
  field: ExtractionField;
  system: string;
  prompt: string;
  /** JSON Schema the answer must match. */
  schema: object;
}

/** A model's answer, with its token usage if known. */
export interface Completion {
  /** The model's answer: JSON text (code fences are tolerated) or an already-parsed object. */
  output: string | object;
  usage?: { inputTokens?: number; outputTokens?: number };
}

/**
 * Calls your model: gets a `CompletionRequest`, returns the answer (text, an object, or a `Completion`).
 * `openAICompatible()` makes one for any OpenAI-compatible API.
 */
export type Complete = (request: CompletionRequest) => Promise<string | object | Completion>;

/** Options of `llmExtractors()`. */
export interface LlmExtractorOptions {
  complete: Complete;
  /** Fields to provide. Default: all AI fields (product…pageContent, serp, customAttributes). */
  fields?: readonly ExtractionField[];
  /** Page text sent to the model, in characters (~4 per token). Default 60 000. */
  maxInputChars?: number;
}

const AI_FIELDS: readonly ExtractionField[] = [...(Object.keys(OUTPUT_SCHEMAS) as OutputSchemaField[]), 'customAttributes'];

/** Prose-first types read the main content; listings and products need the whole page. */
const MAIN_CONTENT = new Set<ExtractionField>(['article', 'forumThread', 'jobPosting', 'pageContent']);

const SYSTEM = [
  'You extract structured data from web pages.',
  'Answer with a single JSON object that matches the given JSON Schema, and nothing else.',
  'Use only information present on the page. Omit fields you cannot find; never invent values.',
  'Keep URLs absolute. Prices are strings without currency symbols (e.g. "1299.99"), currency is an ISO 4217 code.',
].join(' ');

/**
 * Extractors for `new Xyte({ extractors: llmExtractors({ complete }) })`. Each runs one model
 * call per requested field.
 */
export function llmExtractors(options: LlmExtractorOptions): Partial<Record<ExtractionField, Extractor>> {
  const maxChars = options.maxInputChars ?? 60_000;
  const extractors: Partial<Record<ExtractionField, Extractor>> = {};

  for (const field of options.fields ?? AI_FIELDS) {
    if (field === 'markdown') continue;
    extractors[field] = async ({ url, html, request, options: fieldOptions }) => {
      const custom = field === 'customAttributes';
      const tokenLimit = custom ? (fieldOptions as { maxInputTokens?: number } | undefined)?.maxInputTokens : undefined;
      const limit = tokenLimit ? Math.min(maxChars, tokenLimit * 4) : maxChars;

      const page = htmlToMarkdown(html, { url, scope: MAIN_CONTENT.has(field) ? 'mainContent' : 'fullPage' });
      const text = page.length > limit ? `${page.slice(0, limit)}\n…(truncated)` : page;
      const schema = custom ? customSchema(request.customAttributes) : withProbability(field, OUTPUT_SCHEMAS[field as OutputSchemaField]);
      if (!schema) throw new Error(`llmExtractors: no schema for "${field}"`);

      const what = custom ? 'the requested attributes' : `the ${field} data`;
      const prompt = `Extract ${what} from this web page.\n\nURL: ${url}\n\nJSON Schema:\n${JSON.stringify(schema)}\n\nPage (Markdown):\n${text}`;

      const started = Date.now();
      const answer = normalize(await options.complete({ field, system: SYSTEM, prompt, schema }));
      const data = parseJson(answer.output);

      if (custom) {
        return {
          values: data,
          metadata: {
            inputTokens: answer.usage?.inputTokens,
            outputTokens: answer.usage?.outputTokens,
            textInputTokens: Math.ceil(text.length / 4),
          },
        };
      }
      const { [PROBABILITY]: rawProbability, ...item } = data;
      const found = Object.values(item).some((v) => v != null && v !== '' && !(Array.isArray(v) && v.length === 0));
      const probability = typeof rawProbability === 'number' ? Math.min(1, Math.max(0, rawProbability)) : found ? 1 : 0;
      return {
        ...item,
        url: typeof item.url === 'string' ? item.url : url,
        metadata: { dateDownloaded: new Date(started).toISOString().replace(/\.\d+Z$/, 'Z'), probability },
      };
    };
  }
  return extractors;
}

/** Asked of the model, moved to `metadata.probability` (Zyte: how likely the page is of this type). */
const PROBABILITY = '_probability';

function withProbability(field: string, schema: object | undefined): object | undefined {
  if (!schema) return undefined;
  const s = schema as { properties?: Record<string, unknown> };
  return {
    ...s,
    properties: {
      ...s.properties,
      [PROBABILITY]: {
        type: 'number',
        description: `0 to 1: how likely it is that this page really contains ${field} data (close to 0 if not).`,
      },
    },
  };
}

/** Zyte's `customAttributes` is a map of property schemas; wrap it as an object schema. */
function customSchema(attributes: unknown): object {
  if (attributes == null || typeof attributes !== 'object') throw new Error('customAttributes must be an object of attribute schemas');
  const props = attributes as Record<string, unknown>;
  // Accept both `{ name: {type…} }` and a full `{ type: 'object', properties }` schema.
  return 'properties' in props && typeof props.properties === 'object' ? props : { type: 'object', properties: props };
}

function normalize(answer: string | object | Completion): Completion {
  if (typeof answer === 'string') return { output: answer };
  if ('output' in answer && (typeof answer.output === 'string' || typeof answer.output === 'object')) return answer as Completion;
  return { output: answer };
}

/** Parses a model answer, tolerating ```json fences and text around the object. */
export function parseJson(output: string | object): Record<string, unknown> {
  if (typeof output !== 'string') return output as Record<string, unknown>;
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(output)?.[1];
  const candidate = (fenced ?? output).trim();
  try {
    return JSON.parse(candidate);
  } catch {
    const start = candidate.indexOf('{');
    const end = candidate.lastIndexOf('}');
    if (start !== -1 && end > start) return JSON.parse(candidate.slice(start, end + 1));
    throw new Error(`the model did not return JSON: ${candidate.slice(0, 120)}`);
  }
}

/**
 * `complete` for any OpenAI-compatible chat completions API:
 *
 *     openAICompatible({ baseURL: 'https://openrouter.ai/api/v1', apiKey, model: 'openai/gpt-5-mini' })
 *     openAICompatible({ baseURL: 'http://localhost:11434/v1', model: 'qwen3' })   // Ollama
 */
export function openAICompatible(options: {
  model: string;
  apiKey?: string;
  /** Default `https://api.openai.com/v1`. */
  baseURL?: string;
  headers?: Record<string, string>;
  temperature?: number;
  /** Ask for `response_format: json_schema` (default) or plain `json_object` for servers without it. */
  responseFormat?: 'json_schema' | 'json_object';
  fetch?: typeof fetch;
}): Complete {
  const base = (options.baseURL ?? 'https://api.openai.com/v1').replace(/\/+$/, '');
  const doFetch = options.fetch ?? fetch;
  return async ({ field, system, prompt, schema }) => {
    const res = await doFetch(`${base}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(options.apiKey ? { authorization: `Bearer ${options.apiKey}` } : {}),
        ...options.headers,
      },
      body: JSON.stringify({
        model: options.model,
        temperature: options.temperature ?? 0,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: prompt },
        ],
        response_format:
          options.responseFormat === 'json_object'
            ? { type: 'json_object' }
            : { type: 'json_schema', json_schema: { name: field, schema, strict: false } },
      }),
    });
    if (!res.ok) throw new Error(`LLM API answered ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const body = (await res.json()) as {
      choices?: { message?: { content?: string } }[];
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };
    const content = body.choices?.[0]?.message?.content;
    if (content == null) throw new Error('LLM API returned no message content');
    return { output: content, usage: { inputTokens: body.usage?.prompt_tokens, outputTokens: body.usage?.completion_tokens } };
  };
}
