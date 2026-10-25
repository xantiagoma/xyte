import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { decodeBody, Xyte, XyteError } from '../src/index.ts';
import { startTarget } from './fixtures.ts';

let target: ReturnType<typeof startTarget>;
beforeAll(() => {
  target = startTarget();
});
afterAll(() => target.stop());

const xyte = new Xyte({ retries: 2 });

describe('HTTP requests', () => {
  test('httpResponseBody comes back base64 with statusCode and url', async () => {
    const res = await xyte.extract({ url: `${target.base}/html`, httpResponseBody: true });
    expect(res.statusCode).toBe(200);
    expect(res.url).toBe(`${target.base}/html`);
    expect(decodeBody(res.httpResponseBody!)).toContain('<h1>hello</h1>');
    expect(res.httpResponseHeaders).toBeUndefined();
  });

  test('httpResponseHeaders on request', async () => {
    const res = await xyte.extract({ url: `${target.base}/html`, httpResponseBody: true, httpResponseHeaders: true });
    expect(res.httpResponseHeaders).toContainEqual({ name: 'x-test', value: 'yes' });
  });

  test('method, text body and custom headers reach the target', async () => {
    const res = await xyte.extract({
      url: `${target.base}/echo`,
      httpResponseBody: true,
      httpRequestMethod: 'POST',
      httpRequestText: '{"q":"pizza"}',
      customHttpRequestHeaders: [{ name: 'Content-Type', value: 'application/json' }],
      requestHeaders: { referer: 'https://example.com/' },
    });
    const echo = JSON.parse(decodeBody(res.httpResponseBody!));
    expect(echo).toMatchObject({ method: 'POST', body: '{"q":"pizza"}' });
    expect(echo.headers['content-type']).toBe('application/json');
    expect(echo.headers.referer).toBe('https://example.com/');
    expect(echo.headers['user-agent']).toContain('Chrome/');
  });

  test('base64 httpRequestBody (the Wolt search shape)', async () => {
    const res = await xyte.extract({
      url: `${target.base}/echo`,
      httpResponseBody: true,
      httpRequestMethod: 'POST',
      httpRequestBody: Buffer.from(JSON.stringify({ q: 'tacos' })).toString('base64'),
    });
    expect(JSON.parse(decodeBody(res.httpResponseBody!)).body).toBe('{"q":"tacos"}');
  });

  test('redirects are followed with cookies carried across hops', async () => {
    const res = await xyte.extract({ url: `${target.base}/redirect`, httpResponseBody: true, responseCookies: true });
    expect(res.url).toBe(`${target.base}/landing`);
    expect(decodeBody(res.httpResponseBody!)).toBe('cookie=step=1');
    expect(res.responseCookies?.map((c) => c.name).sort()).toEqual(['final', 'step']);
  });

  test('followRedirect: false returns the redirect itself', async () => {
    const res = await xyte.extract({ url: `${target.base}/redirect`, httpResponseBody: true, followRedirect: false });
    expect(res.statusCode).toBe(302);
  });

  test('requestCookies are sent', async () => {
    const res = await xyte.extract({
      url: `${target.base}/echo`,
      httpResponseBody: true,
      requestCookies: [{ name: 'sid', value: 'abc', domain: '127.0.0.1' }],
    });
    expect(JSON.parse(decodeBody(res.httpResponseBody!)).headers.cookie).toBe('sid=abc');
  });

  test('a session keeps its cookies across requests', async () => {
    const session = { id: 'cookie-session' };
    await xyte.extract({ url: `${target.base}/set-cookie`, httpResponseBody: true, session });
    const res = await xyte.extract({ url: `${target.base}/echo`, httpResponseBody: true, session });
    expect(JSON.parse(decodeBody(res.httpResponseBody!)).headers.cookie).toMatch(/^visit=\d+$/);

    const other = await xyte.extract({ url: `${target.base}/echo`, httpResponseBody: true });
    expect(JSON.parse(decodeBody(other.httpResponseBody!)).headers.cookie).toBeUndefined();
  });

  test('a target 404 is a successful response with statusCode 404 (as on Zyte)', async () => {
    const res = await xyte.extract({ url: `${target.base}/missing`, httpResponseBody: true });
    expect(res.statusCode).toBe(404);
  });

  test('echoData and jobId are returned verbatim', async () => {
    const res = await xyte.extract({ url: `${target.base}/html`, httpResponseBody: true, echoData: { n: 1 }, jobId: 'j1' });
    expect(res.echoData).toEqual({ n: 1 });
    expect(res.jobId).toBe('j1');
  });
});

describe('bans and retries', () => {
  test('a persistent 403 is retried, then fails as a 520 /download/website-ban', async () => {
    const before = target.hits.get('/forbidden') ?? 0;
    const error = await xyte.extract({ url: `${target.base}/forbidden`, httpResponseBody: true }).catch((e) => e);
    expect(error).toBeInstanceOf(XyteError);
    expect(error.status).toBe(520);
    expect(error.type).toBe('/download/website-ban');
    expect((target.hits.get('/forbidden') ?? 0) - before).toBe(3);
  });

  test('a challenge page served with 200 counts as a ban', async () => {
    const error = await new Xyte({ retries: 0 })
      .extract({ url: `${target.base}/challenge`, httpResponseBody: true })
      .catch((e) => e);
    expect(error.status).toBe(520);
  });

  test('a transient ban recovers on retry', async () => {
    const retries: number[] = [];
    const res = await new Xyte({ retries: 3, onRetry: ({ attempt }) => retries.push(attempt) }).extract({
      url: `${target.base}/flaky`,
      httpResponseBody: true,
    });
    expect(decodeBody(res.httpResponseBody!)).toBe('finally');
    expect(retries).toEqual([1, 2]);
  });

  test('isBan: false returns banned pages as they are', async () => {
    const res = await new Xyte({ isBan: false }).extract({ url: `${target.base}/forbidden`, httpResponseBody: true });
    expect(res.statusCode).toBe(403);
  });

  test('an unresolvable domain is a 421, without retries', async () => {
    const error = await xyte
      .extract({ url: 'http://this-domain-does-not-exist.invalid/', httpResponseBody: true })
      .catch((e) => e);
    expect(error.status).toBe(421);
    expect(error.type).toBe('/website/domain-unreachable');
  });
});

// Statuses as api.zyte.com answers them: 400 for a malformed request, 422 for parameters that
// can't be combined or a request that asks for nothing.
describe('validation (Zyte 400s and 422s)', () => {
  const rejects = async (request: Parameters<Xyte['extract']>[0], status: number, message: RegExp) => {
    const error = await xyte.extract(request).catch((e) => e);
    expect(error).toBeInstanceOf(XyteError);
    expect(error.status).toBe(status);
    expect(error.type).toBe(status === 422 ? '/request/unprocessable' : '/request/invalid');
    expect(error.message).toMatch(message);
  };

  test('browserHtml with httpResponseBody', () =>
    rejects({ url: `${target.base}/html`, browserHtml: true, httpResponseBody: true }, 422, /cannot be combined/));
  test('httpRequestBody with httpRequestText', () =>
    rejects({ url: `${target.base}/html`, httpResponseBody: true, httpRequestMethod: 'POST', httpRequestBody: 'YQ==', httpRequestText: 'a' }, 422, /cannot be combined/));
  test('no output', () => rejects({ url: `${target.base}/html` }, 422, /no output/));
  test('relative url', () => rejects({ url: '/html', httpResponseBody: true }, 400, /absolute URL/));
  test('browser-only field on an HTTP request', () =>
    rejects({ url: `${target.base}/html`, httpResponseBody: true, actions: [{ action: 'scrollBottom' }] }, 422, /requires browserHtml/));
  test('HTTP-only field on a browser request', () =>
    rejects({ url: `${target.base}/html`, browserHtml: true, httpRequestMethod: 'POST' }, 422, /only be used with httpResponseBody/));
  test('AI extraction without an extractor', () => rejects({ url: `${target.base}/html`, product: true }, 400, /extractor/));
  test('Zyte-only actions', () =>
    rejects({ url: `${target.base}/html`, browserHtml: true, actions: [{ action: 'searchKeyword', keyword: 'x' }] }, 400, /searchKeyword/));
  test('a Cookie header is dropped, as Zyte does', async () => {
    const res = await xyte.extract({
      url: `${target.base}/echo`,
      httpResponseBody: true,
      customHttpRequestHeaders: [{ name: 'Cookie', value: 'a=b' }, { name: 'X-Kept', value: '1' }],
    });
    const echoed = JSON.parse(decodeBody(res.httpResponseBody!)).headers;
    expect(echoed.cookie).toBeUndefined();
    expect(echoed['x-kept']).toBe('1');
  });
});

describe('extractors', () => {
  test('a registered extractor fills its field from the page', async () => {
    const custom = new Xyte({
      extractors: {
        pageContent: ({ html, url }) => ({ url, headline: html.match(/<h1>(.*?)<\/h1>/)?.[1] }),
      },
    });
    const res = await custom.extract({ url: `${target.base}/html`, pageContent: true });
    expect(res.pageContent).toEqual({ url: `${target.base}/html`, headline: 'hello' } as never);
    expect(res.httpResponseBody).toBeUndefined();
  });
});

describe('concurrency', () => {
  test('caps requests in flight', async () => {
    let active = 0;
    let peak = 0;
    const limited = new Xyte({
      concurrency: 2,
      transport: async () => {
        active++;
        peak = Math.max(peak, active);
        await Bun.sleep(20);
        active--;
        return new Response('ok');
      },
    });
    await Promise.all(Array.from({ length: 6 }, () => limited.extract({ url: 'https://example.com/', httpResponseBody: true })));
    expect(peak).toBe(2);
  });
});
