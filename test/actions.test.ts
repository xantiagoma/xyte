import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { custom, rotate, route, Xyte, zyteApi, type ActionHandlers, type AttemptInfo } from '../src/index.ts';
import { startProxy, startTarget } from './fixtures.ts';

setDefaultTimeout(30_000);
let target: ReturnType<typeof startTarget>;
let proxy: Awaited<ReturnType<typeof startProxy>>;
const clients: Xyte[] = [];
beforeAll(async () => {
  target = startTarget();
  proxy = await startProxy({ password: 'secret' });
});
afterAll(async () => {
  await Promise.all(clients.map((c) => c.close()));
  target.stop();
  await proxy.stop();
});

function client(options: ConstructorParameters<typeof Xyte>[0] = {}) {
  const warnings: string[] = [];
  const xyte = new Xyte({ retries: 0, onWarning: (m) => warnings.push(m), ...options });
  clients.push(xyte);
  return { xyte, warnings };
}

describe('Zyte-only actions without a handler', () => {
  test('default: skipped with a warning, the other actions run, the request succeeds', async () => {
    const { xyte, warnings } = client();
    const res = await xyte.extract({
      url: `${target.base}/search-page`,
      browserHtml: true,
      actions: [
        { action: 'setLocation', address: { postalCode: '10001' } },
        { action: 'evaluate', source: 'document.body.dataset.after = "1"' },
      ],
    });
    expect(res.actions!.map((a) => [a.action, a.status])).toEqual([
      ['setLocation', 'notExecuted'],
      ['evaluate', 'success'],
    ]);
    expect(res.browserHtml).toContain('data-after="1"');
    expect(warnings).toEqual([expect.stringContaining('"setLocation" skipped')]);
  });

  test("unsupportedActions: 'error' rejects them upfront, as before", async () => {
    const { xyte } = client({ unsupportedActions: 'error' });
    const error = await xyte
      .extract({ url: `${target.base}/search-page`, browserHtml: true, actions: [{ action: 'interaction', id: 'checkout' }] })
      .catch((e) => e);
    expect(error).toMatchObject({ status: 400 });
    expect(error.detail).toContain('script "checkout"');
  });
});

describe('searchKeyword: the built-in heuristic', () => {
  test('finds the search box, types, submits', async () => {
    const { xyte } = client();
    const res = await xyte.extract({ url: `${target.base}/search-page`, browserHtml: true, actions: [{ action: 'searchKeyword', keyword: 'pizza' }] });
    expect(res.actions![0]!.status).toBe('success');
    expect(res.url).toContain('/results?q=pizza');
    expect(res.browserHtml).toContain('Results for pizza');
  });

  test('opens a search toggle when the box is hidden behind one', async () => {
    const { xyte } = client();
    const res = await xyte.extract({ url: `${target.base}/search-toggle`, browserHtml: true, actions: [{ action: 'searchKeyword', keyword: 'tacos' }] });
    expect(res.browserHtml).toContain('Results for tacos');
  });

  test('no search box: the action fails like any other (onError applies)', async () => {
    const { xyte } = client();
    const res = await xyte.extract({
      url: `${target.base}/html`,
      browserHtml: true,
      actions: [{ action: 'searchKeyword', keyword: 'x', onError: 'continue' }],
    });
    expect(res.actions![0]).toMatchObject({ status: 'continued', error: 'no search box found on the page' });
  });
});

describe('your own handlers', () => {
  const handlers: ActionHandlers = {
    setLocation: {
      localhost: async (page, action) => {
        await page.evaluate((zip) => (document.getElementById('loc')!.textContent = `delivering to ${zip}`), action.address?.postalCode ?? '');
      },
    },
    interaction: {
      'tag-body': async (page, action) => {
        await page.evaluate((args) => (document.body.dataset.tag = String(args.tag)), action.args ?? {});
      },
    },
    searchKeyword: async (page, action) => {
      await page.goto(`${new URL(page.url()).origin}/results?q=${encodeURIComponent(action.keyword)}&custom=1`);
    },
  };

  test('setLocation per site, interaction by id, searchKeyword replaced', async () => {
    const { xyte } = client({ actions: handlers, unsupportedActions: 'error' });
    const base = target.base.replace('127.0.0.1', 'localhost');
    const res = await xyte.extract({
      url: `${base}/search-page`,
      browserHtml: true,
      actions: [
        { action: 'setLocation', address: { postalCode: '94103' } },
        { action: 'interaction', id: 'tag-body', args: { tag: 'done' } },
      ],
    });
    expect(res.browserHtml).toContain('delivering to 94103');
    expect(res.browserHtml).toContain('data-tag="done"');

    const searched = await xyte.extract({ url: `${base}/search-page`, browserHtml: true, actions: [{ action: 'searchKeyword', keyword: 'sushi' }] });
    expect(searched.url).toContain('custom=1');
  });

  test('a site without a setLocation handler, or an unknown script, is still rejected in error mode', async () => {
    const { xyte } = client({ actions: handlers, unsupportedActions: 'error' });
    const error = await xyte
      .extract({ url: `${target.base.replace('127.0.0.1', 'localhost')}/search-page`, browserHtml: true, actions: [{ action: 'interaction', id: 'unknown' }] })
      .catch((e) => e);
    expect(error.status).toBe(400);
  });
});

describe('with Zyte among the providers', () => {
  /** A Zyte stub that records the actions it was asked to run. */
  function zyteStub(answer: 'ok' | 'ban' = 'ok') {
    const received: unknown[] = [];
    const fetch = (async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      received.push(body.actions);
      return answer === 'ok'
        ? Response.json({ url: body.url, statusCode: 200, browserHtml: '<p>zyte ran it</p>', actions: body.actions.map((a: { action: string }) => ({ action: a.action, status: 'success' })) })
        : Response.json({ type: '/download/website-ban', title: 'Website Ban', status: 520 }, { status: 520 });
    }) as typeof globalThis.fetch;
    return { provider: zyteApi({ apiKey: 'K', fetch }), received };
  }
  const local = () => custom('local', () => `http://bob:secret@127.0.0.1:${proxy.port}`);
  const setLocation = [{ action: 'setLocation' as const, address: { postalCode: '10001' } }];

  test('default: no local handler and the attempt lands on a proxy → skipped with a warning; Zyte is not called', async () => {
    const zyte = zyteStub();
    const { xyte, warnings } = client({ proxy: rotate([local(), zyte.provider]) });
    const res = await xyte.extract({ url: `${target.base}/search-page`, browserHtml: true, actions: setLocation });
    expect(res.actions![0]!.status).toBe('notExecuted');
    expect(zyte.received).toEqual([]);
    expect(warnings).toEqual([expect.stringContaining('"setLocation" skipped')]);
  });

  test("unsupportedActions: 'zyte' → providers without a handler are passed over (no request, no wait) so Zyte runs it", async () => {
    const zyte = zyteStub();
    const attempts: AttemptInfo[] = [];
    const { xyte, warnings } = client({ proxy: rotate([local(), zyte.provider]), unsupportedActions: 'zyte', onAttempt: (a) => attempts.push(a) });
    const started = Date.now();
    const res = await xyte.extract({ url: `${target.base}/search-page`, browserHtml: true, actions: setLocation });
    expect(res.browserHtml).toBe('<p>zyte ran it</p>');
    expect(zyte.received).toEqual([setLocation]);
    expect(attempts.map((a) => [a.provider, a.result])).toEqual([
      ['local', 'aborted'],
      ['zyte-api', 'ok'],
    ]);
    expect(Date.now() - started).toBeLessThan(400); // no backoff after a pass-over
    expect(warnings).toEqual([]);
  });

  const zipHandler: ActionHandlers = {
    setLocation: async (page, { address }) => void (await page.evaluate((zip) => (document.getElementById('loc')!.textContent = `zip ${zip}`), address?.postalCode)),
  };

  test('a local handler always wins: an attempt landing on Zyte is passed over for a provider that runs it', async () => {
    const zyte = zyteStub();
    const attempts: AttemptInfo[] = [];
    const { xyte } = client({ proxy: rotate([zyte.provider, local()]), actions: zipHandler, onAttempt: (a) => attempts.push(a) });
    const res = await xyte.extract({ url: `${target.base}/search-page`, browserHtml: true, actions: setLocation });
    expect(res.browserHtml).toContain('zip 10001');
    expect(zyte.received).toEqual([]);
    expect(attempts.map((a) => [a.provider, a.result])).toEqual([
      ['zyte-api', 'aborted'],
      ['local', 'ok'],
    ]);
  });

  test('zyteApi() alone: nowhere to run your handler, so Zyte gets the action as is, and you hear about it', async () => {
    const zyte = zyteStub();
    const { xyte, warnings } = client({ proxy: zyte.provider, actions: zipHandler });
    const res = await xyte.extract({ url: `${target.base}/search-page`, browserHtml: true, actions: setLocation });
    expect(res.browserHtml).toBe('<p>zyte ran it</p>');
    expect(zyte.received).toEqual([setLocation]);
    expect(warnings).toEqual([expect.stringContaining('your "setLocation" handler isn\'t used')]);
  });

  const search = [{ action: 'searchKeyword' as const, keyword: 'pizza' }];

  test('the built-in search heuristic is a fallback: it never passes Zyte over', async () => {
    const zyte = zyteStub();
    const { xyte } = client({ proxy: rotate([zyte.provider, local()]) });
    const res = await xyte.extract({ url: `${target.base}/search-page`, browserHtml: true, actions: search });
    expect(res.browserHtml).toBe('<p>zyte ran it</p>');
    expect(zyte.received).toEqual([search]);
  });

  test("'zyte' sends the built-in-only actions to Zyte too", async () => {
    const zyte = zyteStub();
    const { xyte } = client({ proxy: rotate([local(), zyte.provider]), unsupportedActions: 'zyte' });
    const res = await xyte.extract({ url: `${target.base}/search-page`, browserHtml: true, actions: search });
    expect(res.browserHtml).toBe('<p>zyte ran it</p>');
  });

  test("'error' with Zyte in the combinator: looks for Zyte before failing, so the outcome doesn't depend on the order", async () => {
    const zyte = zyteStub();
    const { xyte } = client({ proxy: rotate([local(), zyte.provider]), unsupportedActions: 'error' });
    const res = await xyte.extract({ url: `${target.base}/search-page`, browserHtml: true, actions: setLocation });
    expect(res.browserHtml).toBe('<p>zyte ran it</p>');
  });

  test("'error' when no route leads to Zyte for this site: a 400 after the pass-overs", async () => {
    const zyte = zyteStub();
    const { xyte } = client({ proxy: route({ 'zyte-only.example': zyte.provider }, local()), unsupportedActions: 'error' });
    const error = await xyte.extract({ url: `${target.base}/search-page`, browserHtml: true, actions: setLocation }).catch((e) => e);
    expect(error).toMatchObject({ status: 400 });
    expect(zyte.received).toEqual([]);
  });

  test("'zyte' with a route that never reaches Zyte for this site: a few pass-overs, then like 'warn'", async () => {
    const zyte = zyteStub();
    const attempts: AttemptInfo[] = [];
    const { xyte, warnings } = client({
      proxy: route({ 'zyte-only.example': zyte.provider }, local()),
      unsupportedActions: 'zyte',
      onAttempt: (a) => attempts.push(a),
    });
    const res = await xyte.extract({ url: `${target.base}/search-page`, browserHtml: true, actions: setLocation });
    expect(attempts.map((a) => a.result)).toEqual(['aborted', 'aborted', 'aborted', 'ok']);
    expect(res.actions![0]!.status).toBe('notExecuted');
    expect(warnings).toHaveLength(1);
  });

  test("'zyte', Zyte banned on every try: its 520, not a page without the location", async () => {
    const zyte = zyteStub('ban');
    const attempts: AttemptInfo[] = [];
    const { xyte } = client({ retries: 1, proxy: rotate([zyte.provider, local()]), unsupportedActions: 'zyte', onAttempt: (a) => attempts.push(a) });
    const error = await xyte.extract({ url: `${target.base}/search-page`, browserHtml: true, actions: setLocation }).catch((e) => e);
    expect(error).toMatchObject({ status: 520, type: '/download/website-ban' });
    expect(attempts.map((a) => [a.provider, a.result])).toEqual([
      ['zyte-api', 'ban'],
      ['local', 'aborted'],
      ['zyte-api', 'ban'],
    ]);
  });
});
