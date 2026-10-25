# Browser rendering and customization

Requests with `browserHtml`, `screenshot`, `actions` or `networkCapture` render in a browser.
By default, that's a shared headless Chromium from `playwright` (an optional dependency), with a
new context for each request carrying its proxy, cookies, viewport and user agent.

Everything about it can be swapped:

| Option | For |
| --- | --- |
| `browserType` | A Playwright-compatible library: **patchright**, rebrowser-playwright, playwright-extra… |
| `launchOptions` | `channel: 'chrome'`, `headless: false`, `args`, `executablePath` |
| `launch` | Full control over the shared browser |
| `connect(ctx)` | A **remote browser per request** (Bright Data Scraping Browser, Browserless, Browserbase…) |
| `contextOptions(defaults, info)` | Change or drop xyte's defaults per request (user agent, viewport, locale, timezone…) |
| `onPage(page, info)` | Init scripts, routes, stealth patches before navigation |
| `blockResources` | Abort `image`, `media`, `font`… to save proxy bandwidth |
| `timeLimit` | Browser seconds per request (Zyte: 60) |
| `settleTime` | After load and actions, wait up to this many seconds for the network to go quiet, so XHR data lands in `browserHtml` and `networkCapture` (default 3, `0` to skip; `XYTE_BROWSER_SETTLE`) |

## Patchright (undetected Playwright)

[Patchright](https://github.com/Kaliiiiiiiiii-Vinyzu/patchright) is a drop-in Playwright fork
that removes common automation tells (`Runtime.enable`, `navigator.webdriver`, automation
flags). The test suite runs it as `browserType`, including actions and network capture.

```sh
npm i patchright && npx patchright install chrome   # or: chromium
```

```ts
import { chromium } from 'patchright';
import { decodo, Xyte } from 'xyte';

const xyte = new Xyte({
  proxy: decodo({ username, password }),
  browser: {
    browserType: chromium,
    launchOptions: { channel: 'chrome', args: ['--webrtc-ip-handling-policy=disable_non_proxied_udp'] },
    // Patchright's advice: don't override the user agent or viewport.
    contextOptions: ({ userAgent, viewport, ...defaults }) => ({ ...defaults, viewport: null }),
  },
});
```

Or with no code: `XYTE_BROWSER=patchright XYTE_BROWSER_CHANNEL=chrome xyte serve`.

Notes:

- Zyte's `evaluate` action runs in the page's main world, with page globals visible. Patchright
  runs `page.evaluate` in an isolated world, so xyte executes `evaluate` sources through a
  self-removing `<script>` tag. That behaves the same on Playwright and its forks, and errors
  are still reported in the `actions` results.
- Patchright recommends persistent profiles (`launchPersistentContext`). xyte uses a fresh
  context per request, which is what makes per-request proxies and cookies work. Use `session.id`
  for continuity across requests.
- The same pattern works for **rebrowser-playwright** (`XYTE_BROWSER=rebrowser-playwright`) and
  **playwright-extra** with `puppeteer-extra-plugin-stealth` (pass its `chromium` as `browserType`).
- Firefox-based stealth browsers such as Camoufox expose a Playwright `firefox` type or a
  Playwright server. Use `browserType` or `connect` with `protocol: 'playwright'`.

## Remote browsers

`connect(ctx)` runs for each request with the request's `country`, `sessionId` and `attempt`,
and returns a WebSocket endpoint. Hosted browsers proxy on their own, so xyte's `proxy` is **not**
applied (set `useProxy: true` to apply it anyway). The connection closes after the request.

```ts
new Xyte({
  browser: {
    // Bright Data Scraping Browser: country in the username
    connect: ({ country }) =>
      `wss://brd-customer-${id}-zone-${zone}${country ? `-country-${country.toLowerCase()}` : ''}:${password}@brd.superproxy.io:9222`,
  },
});

new Xyte({
  browser: {
    // Browserless
    connect: ({ country }) => ({
      endpoint: `wss://production-sfo.browserless.io?token=${token}${country ? `&proxy=residential&proxyCountry=${country.toLowerCase()}` : ''}`,
    }),
  },
});

new Xyte({
  browser: {
    // A Playwright server you run yourself (`npx playwright run-server`)
    connect: () => ({ endpoint: 'ws://browsers.internal:3000/', protocol: 'playwright' }),
  },
});
```

From env: `XYTE_BROWSER_WS='wss://…?proxyCountry={country:lower}&session={session}'` accepts the
same placeholders as [`template()`](providers.md#any-other-provider-template).

Check each vendor's docs for the exact endpoint. Some (Bright Data) allow only one page per
session, which matches xyte's one-context-per-request model.

## Hooks

```ts
new Xyte({
  browser: {
    contextOptions: (defaults, { context }) => ({
      ...defaults,
      locale: context.country === 'DE' ? 'de-DE' : 'en-US',
      timezoneId: context.country === 'DE' ? 'Europe/Berlin' : 'America/New_York',
    }),
    onPage: async (page) => {
      await page.addInitScript(() => Object.defineProperty(navigator, 'hardwareConcurrency', { get: () => 8 }));
    },
    blockResources: ['image', 'media', 'font'],
  },
});
```

`info` gives the Zyte `request`, the resolved `proxy` and the proxy `context` (country, session,
attempt), so hooks can match locale and timezone to the exit country.

## Defaults xyte sets

- Viewport 1920×1080 (or the request's `viewport`; 412×915 for `device: "mobile"`)
- A Chrome user agent matching `device`, and `locale: en-US`
- `bypassCSP: true`, so `evaluate` scripts run on pages with strict CSP
- `ignoreHTTPSErrors` only for proxies marked `insecure` (scraping APIs that re-sign TLS)
- `javaScriptEnabled` from the request's `javascript`

## Captchas

```ts
import { capsolver, twoCaptcha, Xyte } from 'xyte';

new Xyte({ browser: { captcha: capsolver({ apiKey: process.env.CAPSOLVER_API_KEY! }) } });
```

After a browser render's page loads, and before its actions (which may submit the form), xyte looks
for a reCAPTCHA (v2), hCaptcha or Cloudflare Turnstile widget (an element with `data-sitekey`, or
the widget's iframe), sends its sitekey to the service, puts the token in the field the form
expects (`g-recaptcha-response`, `h-captcha-response`, `cf-turnstile-response`) and calls the
widget's `data-callback`. Each attempt's report lists the captchas met (`captchas`: kind, solver,
solved, ms, error).

| Solver | Solves | Env |
| --- | --- | --- |
| `capsolver({ apiKey })` | reCAPTCHA v2 / v3, Turnstile | `XYTE_CAPTCHA=capsolver`, `CAPSOLVER_API_KEY` |
| `twoCaptcha({ apiKey })` | reCAPTCHA v2 / v3, hCaptcha, Turnstile | `XYTE_CAPTCHA=2captcha`, `TWOCAPTCHA_API_KEY` |
| `createTaskSolver({ name, endpoint, apiKey, types })` | any service with the same `createTask` / `getTaskResult` API | |
| your own `{ name, solve(task, signal) }` | anything | |

Both presets follow their services' documentation and are tested against a stand-in service, not
against real accounts yet. Not covered: Cloudflare's full-page "Just a moment…" challenge, which
depends on the browser's cookies and fingerprint rather than a widget token (see
[routing](routing.md#browserfallback-retry-a-banned-page-in-a-browser) and patchright above), and
image or audio captchas. Solving services bill per captcha.

## Zyte's own actions: `searchKeyword`, `setLocation`, `interaction`

These three are Zyte services (its per-site knowledge, its hosted scripts), not browser operations.
Outside Zyte they run in xyte's browser through handlers in `actions`: a built-in heuristic for
`searchKeyword`, your own for `setLocation` (per site) and `interaction` (by script id). Where each
runs depending on the provider, what `unsupportedActions` does without a handler, and how
HTML-only APIs are handled: [actions](actions.md).
