# AI extraction

Zyte's AI outputs (`product`, `productList`, `productNavigation`, `article`, `articleList`,
`articleNavigation`, `forumThread`, `jobPosting`, `jobPostingNavigation`, `pageContent`, `serp`
and `customAttributes`) run through **any LLM you choose**:

```ts
import { llmExtractors, openAICompatible, Xyte } from '@xtandard/xyte';

const xyte = new Xyte({
  extractors: llmExtractors({
    complete: openAICompatible({ baseURL: 'https://openrouter.ai/api/v1', apiKey: process.env.OPENROUTER_API_KEY, model: 'openai/gpt-5-mini' }),
  }),
});

const { product } = await xyte.extract({ url: 'https://shop.example/p/123', product: true });
// { name, price, currency, sku, images, …, url, metadata: { dateDownloaded, probability } }
```

How it works:

1. The page is downloaded as for any request: HTTP by default, or the browser when
   `productOptions.extractFrom` is `browserHtml` or the request also asks for `browserHtml`.
2. It's converted to Markdown with the built-in converter: main content for articles, jobs and
   forum threads, the full page for products and listings. It's cut to `maxInputChars`
   (default 60 000, ~15k tokens).
3. The model gets the page plus **Zyte's own output schema** for the field, bundled from the
   OpenAPI spec (`OUTPUT_SCHEMAS`, regenerated with `bun run gen:types`). The response therefore
   has Zyte's field names and types.
4. `metadata.probability` is the model's estimate that the page really is of that type (0 when
   nothing was found), and `metadata.dateDownloaded` is set by xyte.

`customAttributes` uses the request's own schema and returns `{ values, metadata: { inputTokens,
outputTokens, textInputTokens } }`, as on Zyte. `customAttributesOptions.maxInputTokens` caps the
page text.

## Extracting from your own HTML

`extractFrom: "userHtml"` in a field's options extracts from HTML you send instead of downloading
the page, as on Zyte (the `url` is still required):

```json
{ "url": "https://shop.example/item", "product": true,
  "productOptions": { "extractFrom": "userHtml", "userHtml": "<html>…</html>" } }
```

When every output is such an extraction and runs locally (the built-in `markdown`, or your
extractors), there's no request at all. With `zyteApi()` and no local extractor, Zyte does it.

## Models

`openAICompatible()` speaks the Chat Completions API with `response_format: json_schema`:

| Provider | `baseURL` |
| --- | --- |
| OpenAI | default |
| OpenRouter | `https://openrouter.ai/api/v1` |
| Groq | `https://api.groq.com/openai/v1` |
| Together | `https://api.together.xyz/v1` |
| Anthropic (OpenAI-compatible endpoint) | `https://api.anthropic.com/v1/` (may ignore `response_format`; the prompt and parser still get JSON) |
| Ollama / LM Studio / vLLM (local) | `http://localhost:11434/v1` … |

For servers without JSON-schema output, pass `responseFormat: 'json_object'`. Any other SDK
works through `complete` directly:

```ts
llmExtractors({
  complete: async ({ system, prompt, schema, field }) => {
    const text = await myModel.generate({ system, prompt, jsonSchema: schema });
    return { output: text, usage: { inputTokens: 0, outputTokens: 0 } }; // or just return the text / object
  },
  fields: ['product', 'article'], // only these; others stay 400
});
```

From env, for `xyte serve`: `XYTE_LLM_MODEL`, `XYTE_LLM_BASE_URL`, `XYTE_LLM_API_KEY`,
`XYTE_LLM_RESPONSE_FORMAT`, `XYTE_LLM_MAX_INPUT_CHARS`.

## Compared with Zyte

Zyte runs purpose-trained models and also uses visual features of the rendered page. A
general-purpose LLM over Markdown gets the common fields (name, price, currency, images,
description, author, dates) right on most pages, but quality depends on the model, and every
field costs a model call. `markdown` itself needs no model: it's built in.
