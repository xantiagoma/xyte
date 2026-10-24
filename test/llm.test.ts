import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { extractorsFromEnv, llmExtractors, OUTPUT_SCHEMAS, openAICompatible, parseJson, Xyte, type CompletionRequest } from '../src/index.ts';

const PRODUCT_PAGE = `<html><body><nav>Shop menu</nav><main><h1>Trail Runner 2</h1>
<p>Price: <b>$129.99</b></p><p>SKU TR-2</p><img src="/img/tr2.jpg" alt="shoe"></main></body></html>`;

let site: ReturnType<typeof Bun.serve>;
const llmCalls: { body: Record<string, unknown>; auth: string | null }[] = [];

beforeAll(() => {
  site = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === '/product') return new Response(PRODUCT_PAGE, { headers: { 'content-type': 'text/html' } });
      if (url.pathname === '/v1/chat/completions') {
        const body = (await req.json()) as Record<string, unknown>;
        llmCalls.push({ body, auth: req.headers.get('authorization') });
        return Response.json({
          choices: [{ message: { content: '```json\n{"name":"Trail Runner 2","price":"129.99","currency":"USD","_probability":0.97}\n```' } }],
          usage: { prompt_tokens: 812, completion_tokens: 31 },
        });
      }
      return new Response('nope', { status: 404 });
    },
  });
});
afterAll(() => site.stop(true));
const base = () => `http://127.0.0.1:${site.port}`;

describe('llmExtractors', () => {
  test('prompts with the page as Markdown and the Zyte schema; returns the Zyte shape', async () => {
    const seen: CompletionRequest[] = [];
    const xyte = new Xyte({
      extractors: llmExtractors({
        complete: async (req) => {
          seen.push(req);
          return { name: 'Trail Runner 2', price: '129.99', currency: 'USD', sku: 'TR-2', _probability: 0.9 };
        },
      }),
    });
    const res = await xyte.extract({ url: `${base()}/product`, product: true });

    expect(seen).toHaveLength(1);
    expect(seen[0]!.field).toBe('product');
    expect(seen[0]!.prompt).toContain('# Trail Runner 2');
    expect(seen[0]!.prompt).toContain(`![shoe](${base()}/img/tr2.jpg)`);
    expect(seen[0]!.schema).toMatchObject({ properties: { name: { type: 'string' }, price: { type: 'string' } } });

    expect(res.product).toMatchObject({
      name: 'Trail Runner 2',
      price: '129.99',
      currency: 'USD',
      sku: 'TR-2',
      url: `${base()}/product`,
      metadata: { probability: 0.9 },
    });
    expect((res.product as { metadata: { dateDownloaded: string } }).metadata.dateDownloaded).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
    expect(res.product).not.toHaveProperty('_probability');
  });

  test('customAttributes: the request schema, values + token metadata', async () => {
    let schema: object | undefined;
    const xyte = new Xyte({
      extractors: llmExtractors({
        complete: async (req) => {
          schema = req.schema;
          return { output: '{"summary":"A trail shoe.","onSale":false}', usage: { inputTokens: 500, outputTokens: 12 } };
        },
      }),
    });
    const res = await xyte.extract({
      url: `${base()}/product`,
      customAttributes: { summary: { type: 'string', description: 'One sentence.' }, onSale: { type: 'boolean' } },
    });
    expect(schema).toEqual({ type: 'object', properties: { summary: { type: 'string', description: 'One sentence.' }, onSale: { type: 'boolean' } } });
    expect(res.customAttributes).toMatchObject({
      values: { summary: 'A trail shoe.', onSale: false },
      metadata: { inputTokens: 500, outputTokens: 12 },
    });
  });

  test('nothing found means probability 0', async () => {
    const xyte = new Xyte({ extractors: llmExtractors({ complete: async () => ({}) }) });
    const res = await xyte.extract({ url: `${base()}/product`, jobPosting: true });
    expect(res.jobPosting).toMatchObject({ metadata: { probability: 0 } });
  });

  test('bundled schemas exist for every Zyte AI output', () => {
    for (const field of ['product', 'productList', 'productNavigation', 'article', 'articleList', 'articleNavigation', 'forumThread', 'jobPosting', 'jobPostingNavigation', 'pageContent', 'serp'] as const) {
      expect(OUTPUT_SCHEMAS[field]).toHaveProperty('properties');
    }
    expect(JSON.stringify(OUTPUT_SCHEMAS)).not.toContain('$ref');
  });
});

describe('openAICompatible', () => {
  test('calls /chat/completions with a JSON schema response format', async () => {
    const xyte = new Xyte({
      extractors: llmExtractors({ complete: openAICompatible({ baseURL: `${base()}/v1`, apiKey: 'sk-test', model: 'test-model' }) }),
    });
    const res = await xyte.extract({ url: `${base()}/product`, product: true });
    const call = llmCalls.at(-1)!;
    expect(call.auth).toBe('Bearer sk-test');
    expect(call.body).toMatchObject({ model: 'test-model', temperature: 0, response_format: { type: 'json_schema', json_schema: { name: 'product' } } });
    expect(res.product).toMatchObject({ name: 'Trail Runner 2', metadata: { probability: 0.97 } });
  });

  test('from env (what `xyte serve` uses)', async () => {
    const extractors = extractorsFromEnv({ XYTE_LLM_MODEL: 'm', XYTE_LLM_BASE_URL: `${base()}/v1` });
    const res = await new Xyte({ extractors }).extract({ url: `${base()}/product`, article: true });
    expect(res.article).toMatchObject({ name: 'Trail Runner 2' });
    expect(extractorsFromEnv({})).toBeUndefined();
  });
});

test('parseJson tolerates fences and surrounding text', () => {
  expect(parseJson('Sure! {"a":1} hope that helps')).toEqual({ a: 1 });
  expect(parseJson('```json\n{"b":2}\n```')).toEqual({ b: 2 });
  expect(() => parseJson('no json here')).toThrow('did not return JSON');
});
