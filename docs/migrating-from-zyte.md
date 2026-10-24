# Migrating from Zyte

There are two ways to move code that calls Zyte, depending on how much you want to touch it.

## 1. Change the base URL (no code changes)

Deploy `xyte serve` ([deploy.md](deploy.md)) and point the existing calls at it:

```diff
- const res = await fetch('https://api.zyte.com/v1/extract', {
+ const res = await fetch(`${process.env.XYTE_URL}/v1/extract`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
-     Authorization: 'Basic ' + btoa(ZYTE_API_KEY + ':'),
+     Authorization: 'Basic ' + btoa(XYTE_API_KEY + ':'),
    },
    body: JSON.stringify({ url, httpResponseBody: true }),
  });
```

Status handling stays the same. A target 404 is `200` with `statusCode: 404`, a ban is `520`,
rate limiting would be `429`, and code that retries `429 || >= 500` keeps doing the right thing.

## 2. Call the library directly (no HTTP hop)

A typical helper, such as one with `getHTMLFromZyte({ url, actions, options })` that POSTs to
Zyte and retries transient statuses, becomes:

```ts
import { Xyte, XyteError, proxyFromEnv, type ExtractRequest } from 'xyte';

const xyte = new Xyte({ proxy: proxyFromEnv(), concurrency: 10 }); // replaces p-limit

export async function getHTMLFromXyte<R = unknown>(args: Omit<ExtractRequest, 'url'> & { url: string }) {
  try {
    // Retries with session rotation are built in (retries: 3).
    return { response: (await xyte.extract(args)) as R };
  } catch (error) {
    // Keep the old contract: after retries, hand back the error body instead of throwing.
    if (error instanceof XyteError && error.retryable) return { response: error.toJSON() as R };
    throw error;
  }
}
```

Helpers that decode Zyte bodies keep working unchanged: `httpResponseBody` and captured bodies
are base64, as on Zyte (`decodeBody()` is exported for convenience).

## What changes

| | Zyte | xyte |
| --- | --- | --- |
| Ban avoidance | Zyte's anti-ban stack (fingerprints, IP pools, solving) | Your provider's IPs, plus retries on a fresh session, plus optionally a stealth browser ([patchright](browser.md#patchright-undetected-playwright)) or a scraping API in proxy mode |
| Billing | Per request, by tier | Your provider's pricing (per GB for residential) |
| AI extraction | Built in | Bring an extractor ([coverage](coverage.md)) |
| Hard targets | Zyte picks HTTP vs browser per site | You choose (`httpResponseBody` vs `browserHtml`) |

For the hardest sites (Yelp-style 520s), point `rotate()` at a scraping API (ZenRows,
ScrapingBee, Bright Data Web Unlocker) as the fallback after a residential proxy. The full
field-by-field status is in [coverage.md](coverage.md).
