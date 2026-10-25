import { afterAll, beforeAll, expect, setDefaultTimeout, test } from 'bun:test';
import { browserFromEnv, camoufox, cloakBrowser, patchright, Xyte } from '../src/index.ts';
import { startTarget } from './fixtures.ts';

setDefaultTimeout(60_000);
let target: ReturnType<typeof startTarget>;
beforeAll(() => {
  target = startTarget();
});
afterAll(() => target.stop());

test('patchright(): renders, with its own user agent and viewport kept', async () => {
  const preset = patchright();
  const context = await preset.contextOptions!({ userAgent: 'xyte-ua', viewport: { width: 1, height: 1 }, locale: 'en-US' }, {} as never);
  expect(context).toEqual({ locale: 'en-US' });
  const xyte = new Xyte({ retries: 0, browser: preset });
  try {
    const res = await xyte.extract({ url: `${target.base}/app`, browserHtml: true, actions: [{ action: 'waitForSelector', selector: { type: 'css', value: '#done' } }] });
    expect(res.browserHtml).toContain('secret 42');
  } finally {
    await xyte.close();
  }
});

test('a preset whose package is missing: a 500 saying what to install, not retried', async () => {
  for (const [preset, install] of [
    [camoufox(), 'npm i camoufox-js'],
    [cloakBrowser(), 'npm i cloakbrowser'],
  ] as const) {
    const xyte = new Xyte({ retries: 2, browser: preset });
    const error = await xyte.extract({ url: `${target.base}/html`, browserHtml: true }).catch((e) => e);
    expect(error).toMatchObject({ status: 500 });
    expect(error.detail).toContain(install);
    await xyte.close();
  }
});

test('XYTE_BROWSER picks a preset by name', () => {
  expect(browserFromEnv({ XYTE_BROWSER: 'camoufox' }).launch).toBeDefined();
  expect(browserFromEnv({ XYTE_BROWSER: 'cloakbrowser' }).launch).toBeDefined();
  expect(browserFromEnv({ XYTE_BROWSER: 'patchright' }).contextOptions).toBeDefined();
  expect(browserFromEnv({ XYTE_BROWSER: 'some-fork' }).browserType).toBeDefined();
});
