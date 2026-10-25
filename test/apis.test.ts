import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { decodeBody, proxyUrl, rotate, scrapingBot, scrappey, Xyte, zyteApi } from '../src/index.ts';
import { startTarget } from './fixtures.ts';

type Call = { url: string; init: RequestInit; body: Record<string, unknown> };

/** A fetch stub that records calls and answers with `reply`. */
function stub(reply: (call: Call) => Response) {
  const calls: Call[] = [];
  const fn = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const call = { url: String(input), init, body: JSON.parse(String(init.body ?? '{}')) };
    calls.push(call);
    return reply(call);
  }) as typeof fetch;
  return { fetch: fn, calls };
}

describe('zyteApi', () => {
  test('forwards the request unchanged and returns Zyte’s answer as is', async () => {
    const { fetch, calls } = stub(() =>
      Response.json({ url: 'https://shop.example/', statusCode: 200, product: { name: 'Shoe', metadata: { probability: 0.99 } } }),
    );
    const xyte = new Xyte({ proxy: zyteApi({ apiKey: 'KEY', fetch }) });
    const res = await xyte.extract({ url: 'https://shop.example/', product: true, geolocation: 'US' });

    expect(calls[0]!.url).toBe('https://api.zyte.com/v1/extract');
    expect((calls[0]!.init.headers as Record<string, string>).authorization).toBe(`Basic ${btoa('KEY:')}`);
    expect(calls[0]!.body).toEqual({ url: 'https://shop.example/', product: true, geolocation: 'US' });
    // No local extractor needed: Zyte answered the AI field itself.
    expect(res.product).toEqual({ name: 'Shoe', metadata: { probability: 0.99 } } as never);
  });

  test('a trusted 403 statusCode is not retried as a ban', async () => {
    const { fetch, calls } = stub(() => Response.json({ url: 'https://x.example/', statusCode: 403, httpResponseBody: btoa('forbidden') }));
    const res = await new Xyte({ proxy: zyteApi({ apiKey: 'K', fetch }) }).extract({ url: 'https://x.example/', httpResponseBody: true });
    expect(res.statusCode).toBe(403);
    expect(calls).toHaveLength(1);
  });

  test('after the retries, Zyte’s own last problem is returned (a ban stays a website-ban)', async () => {
    const ban = { type: '/download/website-ban', title: 'Website Ban', status: 520, detail: 'no ban-free response' };
    const { fetch, calls } = stub(() => Response.json(ban, { status: 520 }));
    const error = await new Xyte({ retries: 1, proxy: zyteApi({ apiKey: 'K', fetch }) })
      .extract({ url: 'https://x.example/', httpResponseBody: true })
      .catch((e) => e);
    expect(calls).toHaveLength(2);
    expect(error.toJSON()).toEqual(ban);
  });

  test('Zyte’s own actions (searchKeyword, setLocation, interaction) are forwarded, not rejected', async () => {
    const { fetch, calls } = stub(() => Response.json({ url: 'https://shop.example/', statusCode: 200, browserHtml: '<p>results</p>' }));
    const actions = [
      { action: 'setLocation' as const, address: { postalCode: '10001' } },
      { action: 'searchKeyword' as const, keyword: 'pizza' },
      { action: 'interaction' as const, id: 'my-script' },
    ];
    const res = await new Xyte({ proxy: zyteApi({ apiKey: 'K', fetch }) }).extract({ url: 'https://shop.example/', browserHtml: true, actions });
    expect(res.browserHtml).toBe('<p>results</p>');
    expect(calls[0]!.body.actions).toEqual(actions);
  });

  test("mixed with a proxy and unsupportedActions: 'zyte': the proxy is passed over and Zyte runs it", async () => {
    const { fetch, calls } = stub(() => Response.json({ url: 'https://shop.example/', statusCode: 200, browserHtml: 'x' }));
    const proxy = rotate([proxyUrl('http://u:p@127.0.0.1:1'), zyteApi({ apiKey: 'K', fetch })]);
    const res = await new Xyte({ proxy, retries: 0, unsupportedActions: 'zyte', actions: { searchKeyword: false } }).extract({
      url: 'https://shop.example/',
      browserHtml: true,
      actions: [{ action: 'searchKeyword', keyword: 'pizza' }],
    });
    expect(res.browserHtml).toBe('x');
    expect(calls).toHaveLength(1);
  });

  test('a 400 problem passes through untouched', async () => {
    const { fetch } = stub(() =>
      Response.json({ type: '/request/invalid', status: 400, title: 'Invalid Request', detail: 'bad combo' }, { status: 400 }),
    );
    const error = await new Xyte({ proxy: zyteApi({ apiKey: 'K', fetch }) })
      .extract({ url: 'https://x.example/', httpResponseBody: true })
      .catch((e) => e);
    expect(error).toMatchObject({ status: 400, type: '/request/invalid', detail: 'bad combo' });
  });
});

describe('rotate across proxies and APIs', () => {
  let target: ReturnType<typeof startTarget>;
  beforeAll(() => {
    target = startTarget();
  });
  afterAll(() => target.stop());

  test('a Zyte 520 moves on to the next provider', async () => {
    const zyte = stub(() => Response.json({ type: '/download/temporary-error', status: 520 }, { status: 520 }));
    const fallback = stub(() => Response.json({ url: target.base, statusCode: 200, httpResponseBody: btoa('from fallback') }));
    const xyte = new Xyte({ retries: 1, proxy: rotate([zyteApi({ apiKey: 'A', fetch: zyte.fetch }), zyteApi({ apiKey: 'B', fetch: fallback.fetch })]) });
    const res = await xyte.extract({ url: `${target.base}/html`, httpResponseBody: true });
    expect(decodeBody(res.httpResponseBody!)).toBe('from fallback');
    expect(zyte.calls).toHaveLength(1);
  });

  test('a broken proxy, then an API', async () => {
    const api = stub(() => Response.json({ url: target.base, statusCode: 200, httpResponseBody: btoa('api') }));
    // A proxy and an API in one rotate(), no type annotation needed.
    const proxy = rotate([
      proxyUrl('http://u:p@127.0.0.1:1'), // nothing listens: connection refused
      zyteApi({ apiKey: 'K', fetch: api.fetch }),
    ]);
    const res = await new Xyte({ retries: 1, proxy }).extract({ url: `${target.base}/html`, httpResponseBody: true });
    expect(decodeBody(res.httpResponseBody!)).toBe('api');
  });
});

describe('scrappey', () => {
  test('maps the request and the solution', async () => {
    const { fetch, calls } = stub(() =>
      Response.json({
        data: 'success',
        solution: { response: '<h1>ok</h1>', statusCode: 200, currentUrl: 'https://x.example/final', responseHeaders: { 'x-a': '1' } },
      }),
    );
    const xyte = new Xyte({ proxy: scrappey({ apiKey: 'K', fetch }) });
    const res = await xyte.extract({
      url: 'https://x.example/',
      browserHtml: true,
      geolocation: 'us',
      httpResponseHeaders: true,
      requestCookies: [{ name: 'a', value: 'b', domain: 'x.example' }],
    });
    expect(calls[0]!.url).toBe('https://publisher.scrappey.com/api/v1?key=K');
    expect(calls[0]!.body).toMatchObject({ cmd: 'request.get', url: 'https://x.example/', requestType: 'browser', proxyCountry: 'UnitedStates', cookies: 'a=b' });
    expect(res).toMatchObject({ url: 'https://x.example/final', statusCode: 200, browserHtml: '<h1>ok</h1>' });
    expect(res.httpResponseHeaders).toEqual([{ name: 'x-a', value: '1' }]);
  });

  test('an error answer is retried', async () => {
    let n = 0;
    const { fetch } = stub(() =>
      ++n === 1 ? Response.json({ data: 'error', error: 'CODE-0002' }) : Response.json({ data: 'success', solution: { response: 'fine', statusCode: 200 } }),
    );
    const res = await new Xyte({ proxy: scrappey({ apiKey: 'K', fetch }) }).extract({ url: 'https://x.example/', httpResponseBody: true });
    expect(decodeBody(res.httpResponseBody!)).toBe('fine');
    expect(n).toBe(2);
  });
});

describe('scrapingBot', () => {
  test('basic auth, url + options, raw HTML back', async () => {
    const { fetch, calls } = stub(() => new Response('<p>bot</p>'));
    const res = await new Xyte({ proxy: scrapingBot({ username: 'u', apiKey: 'k', fetch, options: { premiumProxy: true } }) }).extract({
      url: 'https://x.example/',
      httpResponseBody: true,
      geolocation: 'DE',
    });
    expect((calls[0]!.init.headers as Record<string, string>).authorization).toBe(`Basic ${btoa('u:k')}`);
    expect(calls[0]!.body).toEqual({ url: 'https://x.example/', options: { premiumProxy: true, proxyCountry: 'DE' } });
    expect(decodeBody(res.httpResponseBody!)).toBe('<p>bot</p>');
  });
});
