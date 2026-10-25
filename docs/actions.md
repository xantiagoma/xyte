# Actions

Zyte's `actions` drive the page before it's captured: click, type, scroll, wait. xyte runs them
in its own browser (Playwright, a [fork or a remote browser](browser.md)), with Zyte's request and
result shapes, so the same request works on either. This page covers which actions there are,
where each one runs depending on the provider, and what happens when it can't.

## Which actions

| Action | In xyte |
| --- | --- |
| `click`, `doubleClick`, `hover`, `hide`, `evaluate`, `goto`, `reload`, `keyPress`, `type`, `select`, `scrollTo`, `scrollBottom`, `waitForNavigation`, `waitForRequest`, `waitForResponse`, `waitForSelector`, `waitForTimeout` | built in, with Zyte's options and `onError` ([coverage](coverage.md#actions) has the per-action details) |
| `searchKeyword` | Zyte's own (it knows each site's search box). In xyte: a built-in heuristic, or your handler |
| `setLocation` | Zyte's own (it knows each site's location form). In xyte: your handler |
| `interaction` | Runs a script saved in Zyte's cloud IDE, by id. In xyte: your scripts, by id |

Each action reports a result in the response's `actions`, in order: `success`, `continued` (it
failed and `onError: 'continue'` let the rest go on), `returned` (it failed and stopped the rest,
the default), or `notExecuted` (it never ran: after a `returned`, out of browser time, or skipped
as described below; a skip carries its reason in `error`).

## Which providers run them

| Provider | Actions |
| --- | --- |
| Proxies (`oxylabs`, `decodo`, `direct()`, `template()`…), `zyteProxy()` | xyte's browser runs them |
| Remote browsers (`browser.connect`, `XYTE_BROWSER_WS`, `XYTE_REMOTE_BROWSER`) | xyte runs them in the remote browser |
| Scraping APIs in proxy mode (ZenRows, ScrapingBee…) | xyte's browser runs them, but every sub-request of the page is a billed request |
| `zyteApi()` | the request goes to Zyte, which runs them all, its own three included |
| `scrappey()`, `scrapingBot()` (HTML-only APIs) | none: see [HTML-only APIs](#html-only-apis-scrappey-scrapingbot) |

## Zyte's own: `searchKeyword`, `setLocation`, `interaction`

These three aren't browser operations but Zyte services, so outside Zyte they run through
handlers:

```ts
new Xyte({
  actions: {
    searchKeyword: {
      'shop.example': async (page, { keyword }) => page.fill('#find', keyword),
      'odd-site.example': null, // the heuristic gets it wrong here: no handler on this site
      // '*': the built-in heuristic unless you set it (null turns it off everywhere)
    },
    setLocation: {
      'doordash.com': async (page, { address }) => { /* … */ },
      '*': async (page, { address }) => { /* your generic attempt, for every other site */ },
    },
    interaction: {
      'accept-cookies': async (page) => page.click('#onetrust-accept-btn-handler'),
      '*': async (page, { id, args }) => myScripts.run(id, page, args), // any other script id
    },
  },
  unsupportedActions: 'warn', // or 'error', 'zyte': below
});
```

Each takes a table: keys are hosts for `searchKeyword` and `setLocation` (subdomains included, the
longest key wins) and script ids for `interaction`, and `'*'` covers everything not listed. A
value of `null` means explicitly no handler, so a listed `null` also beats `'*'`. A plain function
is short for `{ '*': fn }`.

| | `'*'` by default |
| --- | --- |
| `searchKeyword` | `searchBox`: a heuristic (search inputs, role=searchbox, q/query/search fields, a "search" placeholder or label; it opens a search toggle when the box hides behind one). `null` or `searchKeyword: false` turns it off |
| `setLocation` | none: every site's location form is different |
| `interaction` | none: the scripts are yours |

A handler gets the Playwright page, the action as Zyte defines it (`keyword`, `address`, `id` and
`args`), and `{ url, timeout, log }`: `log(message, level?)` lines come back in the action's
`interactionLogs`, as Zyte returns its scripts' `console.log`. Throwing fails the action, and its `onError` applies, as for any
action. [`examples/actions.ts`](../examples/actions.ts) is a typechecked version.

### Where they run

On each attempt, each of these actions is one of three kinds:

- **Yours**: a handler you configured covers it (a listed key or your own `'*'`). It always runs
  locally: it's your code, and Zyte doesn't have it.
- **Built-in**: `searchKeyword` with no handler of yours, so the heuristic. It's a fallback for
  where Zyte isn't, never a reason to skip Zyte.
- **None**: no handler covers it: `setLocation` / `interaction` without a matching key or `'*'`,
  a `null` entry, or `searchKeyword` turned off.

What happens depends on the kind and on what the attempt's provider is. There are three types
of providers here:

- **Local browser**: proxies (`oxylabs`, `decodo`, `direct()`, `template()`…), scraping APIs in
  proxy mode, remote browsers, `zyteProxy()`. xyte's browser runs the actions.
- **`zyteApi()`**: Zyte's browser runs them, its own three included. Your code can't run there.
- **HTML-only APIs** (`scrappey()`, `scrapingBot()`): no browser at all, so no action of any kind
  runs, standard ones (`click`…) included. See [below](#html-only-apis-scrappey-scrapingbot).

| | Attempt on a local-browser provider | Attempt on `zyteApi()` | Attempt on an HTML-only API |
| --- | --- | --- | --- |
| **Yours** | your handler runs | passed over for a local-browser provider. With nowhere to go: `searchKeyword` / `setLocation` go to Zyte, which runs its own, plus a warning; your `interaction` script isn't sent (see below) | passed over. With nowhere to go: skipped, like every action on it |
| **Built-in** | the heuristic runs (with `'zyte'`: passed over for Zyte if a combinator has it) | Zyte runs its own | passed over. With nowhere to go: skipped, like every action on it |
| **None** | `unsupportedActions` decides ↓ | Zyte runs it | passed over. With nowhere to go: skipped, like every action on it |

On an HTML-only API with nowhere to go, "skipped" means `'warn'` and `'zyte'` return the page with
every action `notExecuted` (the reason in `error`) plus a warning, and `'error'` is a 400.

An `ApiEndpoint` you write that doesn't declare `unsupported` is assumed to run everything: it
gets the request as is, except actions with your handler, which look for a local-browser provider
first (and with nowhere to go, as on `zyteApi()`: your `interaction` scripts aren't sent, the
other two go with a warning).

| `unsupportedActions` | **None**, on a local-browser provider |
| --- | --- |
| `'warn'` (default) | skipped: `notExecuted` in the response's `actions`, a warning (`onWarning`, `X-Xyte-Warning`), the other actions go on |
| `'error'` | run it or fail: passed over for Zyte if a combinator has it, else a 400 naming the action. While Zyte is reachable the outcome doesn't depend on which provider an attempt lands on; when it isn't (a `route()` that never sends this site to Zyte, or the pass-over limits below), it's the 400. With no `zyteApi()` among the providers at all, the 400 comes before any request |
| `'zyte'` | passed over for Zyte if a combinator has it (built-in actions too), else like `'warn'` |

**Your `interaction` scripts with `zyteApi()` alone.** Zyte answers "script not found" for an id
it doesn't have, and stops every action after it. So a script you have a handler for isn't sent:
it's reported `notExecuted` in its place with the reason, and the other actions run on Zyte (with
`'error'`, a 400 before calling Zyte). To run your scripts behind Zyte's IPs, use `zyteProxy()`:
Zyte's proxy mode with xyte's browser.

When Zyte runs an action and bans every try, the answer is its 520, never a page without the
action.

## HTML-only APIs: Scrappey, ScrapingBot

They return a page's HTML: they run no action at all (`click` included), take no screenshot and
capture no network responses. Their endpoints say so (`ApiEndpoint.unsupported`), so xyte decides
instead of dropping them silently:

| The request has | Inside a combinator | Alone, `'warn'` / `'zyte'` | Alone, `'error'` |
| --- | --- | --- | --- |
| actions (any) | passed over for a provider that can | 200, every action `notExecuted` with the reason, plus a warning | 400 |
| `screenshot`, `networkCapture` | passed over | 400 | 400 |

An `ApiEndpoint` you write can declare the same: `unsupported: (request) => request.screenshot ?
['screenshot'] : []`. Without it, xyte assumes it can do everything.

## Pass-overs

"Passed over" means the attempt's provider is skipped without a request: no backoff, no retry used
up, no `onRetry` call, no `adaptive` score, circuit or `sessionContext` session touched. A
`budget()` slot is taken when the provider is resolved and given back right after (so a provider
whose budget is already spent answers its 429 before a pass-over could skip it). The next attempt
goes to the next provider the combinator picks.

It only happens inside a combinator (`rotate`, `route`, `weighted`, `adaptive`…: with a single
provider there's nowhere to go), at most 10 times per request, and after three in a row with no
suitable provider the attempt runs anyway with what it has (so `'zyte'` ends up skipping the
action, and `'error'` in a 400).

Pass-overs are `aborted` attempts: in [`onRequest`](observability.md) reports with their reason
(for example `"setLocation" has no handler of yours: passed over oxylabs-residential for Zyte`),
and in `X-Xyte-Attempts` as `provider:aborted`.

## Limits

- **`sessionContextParameters.actions`** (the actions that initialize a pooled session) resolve
  their own provider, separately from the attempt, and are never passed over. If that resolves
  to an API provider, the session isn't initialized locally (the API keeps its own sessions).
  Zyte's own actions there follow the same handlers; without one they're skipped with a warning,
  or a 400 with `unsupportedActions: 'error'`.
- **Per-site handlers** are looked up twice: the request URL's host decides whether an action is
  yours (and so whether to pass over), and the page's URL at the time the action runs picks the
  handler. After a redirect to another host they can disagree, and the action is then skipped
  like one without a handler. Key handlers by the host the page ends on, or use one function for
  every site.
