import { afterAll, beforeAll, expect, test } from 'bun:test';
import { decodeBody, Xyte, zyteApi, type RequestReport } from '../src/index.ts';
import { startTarget } from './fixtures.ts';

let target: ReturnType<typeof startTarget>;
beforeAll(() => {
  target = startTarget();
});
afterAll(() => target.stop());

test('extractFrom: "userHtml" with a local extractor: no download at all', async () => {
  const reports: RequestReport[] = [];
  let sent = 0;
  const xyte = new Xyte({
    transport: async () => {
      sent++;
      return new Response('');
    },
    onRequest: (r) => reports.push(r),
  });
  const res = await xyte.extract({
    url: 'https://shop.example/item',
    markdown: true,
    markdownOptions: { extractFrom: 'userHtml', userHtml: '<html><body><main><h1>Hello</h1><p>From my HTML.</p></main></body></html>' } as never,
  });
  expect(res.markdown).toContain('# Hello');
  expect(sent).toBe(0);
  expect(reports[0]!.attempts).toEqual([]);
});

test('userHtml is required with extractFrom: "userHtml"', async () => {
  const error = await new Xyte().extract({ url: 'https://shop.example/', markdown: true, markdownOptions: { extractFrom: 'userHtml' } as never }).catch((e) => e);
  expect(error).toMatchObject({ status: 400 });
  expect(error.detail).toContain('markdownOptions.userHtml');
});

test('mixed: the body is downloaded, the field is extracted from the HTML sent', async () => {
  const seen: string[] = [];
  const xyte = new Xyte({
    retries: 0,
    extractors: {
      product: ({ html }) => {
        seen.push(html);
        return { name: 'from user html' };
      },
    },
  });
  const res = await xyte.extract({
    url: `${target.base}/html`,
    httpResponseBody: true,
    product: true,
    productOptions: { extractFrom: 'userHtml', userHtml: '<p>mine</p>' } as never,
  });
  expect(decodeBody(res.httpResponseBody!)).toContain('hello');
  expect(seen).toEqual(['<p>mine</p>']);
  expect(res.product).toEqual({ name: 'from user html' } as never);
});

test('with zyteApi() and no local extractor, the request goes to Zyte as is', async () => {
  const bodies: unknown[] = [];
  const fetch = (async (_url: string, init: RequestInit) => {
    bodies.push(JSON.parse(String(init.body)));
    return Response.json({ url: 'https://shop.example/', product: { name: 'by zyte' } });
  }) as typeof globalThis.fetch;
  const options = { extractFrom: 'userHtml', userHtml: '<p>x</p>' };
  const res = await new Xyte({ proxy: zyteApi({ apiKey: 'K', fetch }) }).extract({ url: 'https://shop.example/', product: true, productOptions: options as never });
  expect(res.product).toEqual({ name: 'by zyte' } as never);
  expect(bodies[0]).toMatchObject({ productOptions: options });
});
