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

## Gotchas

Where xyte answers differently from Zyte, depending on how it's configured:

- **`geolocation` needs a provider that geolocates.** With `direct()` (no `XYTE_PROVIDER` /
  `XYTE_PROXY_URL`), a plain `proxyUrl()`, or a `template()` without `{country}`, the field is
  accepted and **ignored**: requests exit from the host's own IP and country. The country is
  only applied when the preset encodes it ([providers](providers.md)).
- **`direct()` exits from your server's IP.** On Cloud Run, Fly and similar hosts, that is a
  datacenter IP. Easy sites work, but sites that block datacenters (Yelp, DoorDash…) answer
  403, or a challenge page that xyte retries and then reports as a `520`.
- **AI fields are a 400 until you plug in an extractor.** `product`, `article`, `pageContent`,
  `serp`, `customAttributes`… ([extraction](extraction.md)). Zyte extracts them itself.
- **`markdown` is built in**, like Zyte's: non-AI, no LLM needed. `pageContent` is the AI field.
- **Zyte decides HTTP vs browser per site; xyte does what you ask.** A site that needs
  JavaScript returns its empty shell to `httpResponseBody`. Request `browserHtml` instead.
- **Zyte-only features:** the `searchKeyword`, `setLocation` and `interaction` actions return a
  400. Zyte's proxy mode (port 8011) and its Stats API aren't implemented: xyte serves only
  `POST /v1/extract`.

These match Zyte, so they need no changes: `screenshot` defaults to JPEG (`screenshotOptions.format:
"png"` for PNG); a target error is HTTP 200 with its `statusCode`; problem types (`/request/invalid`,
`/auth/key-not-found`, `/website/domain-unreachable`, `/download/temporary-error`) and action
statuses (`success`, `continued`, `returned`) use Zyte's values.

## Checking a deployment

`bun run test:live` runs the same requests against real public sites (JSON APIs, a JavaScript-only
page, XHR capture, screenshots, error cases) through a local `xyte serve`. Point it at a deployed
instance, or at Zyte itself, to compare the answers:

```sh
XYTE_LIVE_URL=https://xyte.example.com/v1/extract XYTE_LIVE_KEY=… bun scripts/live.ts
XYTE_LIVE_URL=https://api.zyte.com/v1/extract XYTE_LIVE_KEY=$ZYTE_API_KEY bun scripts/live.ts
```

Last run (2026-10-24, `direct()`, dist on Node): 18/18 passed, including snappr's
`getHTMLFromZyte` unchanged except for the URL (render + actions, a JSON API, `networkCapture`,
a POST). It has not yet been run against Zyte for a side-by-side comparison.
