import { afterAll, beforeAll, expect, setDefaultTimeout, test } from 'bun:test';
import { Xyte, XyteError } from '../src/index.ts';
import { startTarget } from './fixtures.ts';

setDefaultTimeout(60_000);
let target: ReturnType<typeof startTarget>;
beforeAll(() => {
  target = startTarget();
});
afterAll(() => target.stop());

test('close() cancels requests in flight, HTTP and browser, with /client/closed', async () => {
  const xyte = new Xyte({ retries: 0 });
  const http = xyte.extract({ url: `${target.base}/api/slow`, httpResponseBody: true });
  const render = xyte.extract({ url: `${target.base}/api/slow`, browserHtml: true });
  await Bun.sleep(50);
  await xyte.close();
  for (const result of await Promise.allSettled([http, render])) {
    expect(result.status).toBe('rejected');
    const error = (result as PromiseRejectedResult).reason as XyteError;
    expect(error).toBeInstanceOf(XyteError);
    expect(error.type).toBe('/client/closed');
    expect(error.retryable).toBe(false);
  }
});

// The mistake that used to leave an orphaned browser and a process that never exits:
// await using closes the client before the returned render has even started its browser.
test('return without await inside await using: a /client/closed error, no browser left open', async () => {
  const xyte = new Xyte({ retries: 0 });
  let launched = 0;
  const browser = (xyte as unknown as { browser: { getBrowser: () => Promise<unknown> } }).browser;
  const original = browser.getBrowser.bind(browser);
  browser.getBrowser = () => (launched++, original());
  const scrape = async () => {
    await using client = xyte;
    return client.extract({ url: `${target.base}/html`, browserHtml: true });
  };
  const error = await scrape().catch((e: unknown) => e);
  expect((error as XyteError).type).toBe('/client/closed');
  expect(launched).toBe(0);
});

test('close() twice is fine, and the client keeps working after it', async () => {
  const xyte = new Xyte({ retries: 0 });
  await xyte.extract({ url: `${target.base}/html`, browserHtml: true });
  await xyte.close();
  await xyte.close();
  const again = await xyte.extract({ url: `${target.base}/html`, browserHtml: true });
  expect(again.browserHtml).toContain('<');
  await xyte.close();
});
