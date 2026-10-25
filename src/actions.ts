import type { Locator, Page } from 'playwright';
import { unsupported } from './errors.ts';
import type { Action } from './types.ts';

/**
 * Zyte's own actions, which rely on Zyte's per-site knowledge (`searchKeyword`, `setLocation`) or
 * on scripts stored in Zyte's cloud IDE (`interaction`). With `zyteApi()` they go to Zyte; anywhere
 * else they run through handlers you provide (a heuristic one ships for `searchKeyword`), and
 * without a handler they're skipped with a warning, or rejected with `unsupportedActions: 'error'`.
 */
export type SearchKeywordAction = Extract<Action, { action: 'searchKeyword' }>;
export type SetLocationAction = Extract<Action, { action: 'setLocation' }>;
export type InteractionAction = Extract<Action, { action: 'interaction' }>;
export type ZyteOnlyAction = SearchKeywordAction | SetLocationAction | InteractionAction;

export interface ActionHandlerContext {
  /** The page's current URL. */
  url: URL;
  /** Milliseconds the action may take (its `timeout`, within the browser time left). */
  timeout: number;
}

/** Runs one action on the page; throw to fail it (its `onError` then applies, as for any action). */
export type ActionHandler<A extends ZyteOnlyAction> = (page: Page, action: A, context: ActionHandlerContext) => Promise<void>;

/** A handler for every site, or one per site keyed by host (subdomains included, the longest key wins). */
export type PerSite<A extends ZyteOnlyAction> = ActionHandler<A> | Readonly<Record<string, ActionHandler<A>>>;

export interface ActionHandlers {
  /** Default: `searchBox`, a heuristic that finds the page's search box. `false` turns it off. */
  searchKeyword?: PerSite<SearchKeywordAction> | false;
  /** No default: forms to set a location are different on every site. */
  setLocation?: PerSite<SetLocationAction>;
  /** Scripts by the `id` the action names, or one function that gets them all. */
  interaction?: ActionHandler<InteractionAction> | Readonly<Record<string, ActionHandler<InteractionAction>>>;
}

const ZYTE_ONLY = new Set<string>(['searchKeyword', 'setLocation', 'interaction']);

export const isZyteOnlyAction = (action: Action): action is ZyteOnlyAction => ZYTE_ONLY.has(action.action);

function forHost<A extends ZyteOnlyAction>(handlers: PerSite<A> | undefined, url: URL): ActionHandler<A> | undefined {
  if (!handlers || typeof handlers === 'function') return handlers;
  const host = url.hostname.toLowerCase();
  const match = Object.keys(handlers)
    .filter((key) => host === key.toLowerCase() || host.endsWith(`.${key.toLowerCase()}`))
    .sort((a, b) => b.length - a.length)[0];
  return match ? handlers[match] : undefined;
}

/** The handler that runs `action` on `url`, if any. */
export function handlerFor(action: ZyteOnlyAction, handlers: ActionHandlers, url: URL): ActionHandler<ZyteOnlyAction> | undefined {
  switch (action.action) {
    case 'searchKeyword':
      return handlers.searchKeyword === false ? undefined : (forHost(handlers.searchKeyword, url) ?? searchBox) as ActionHandler<ZyteOnlyAction>;
    case 'setLocation':
      return forHost(handlers.setLocation, url) as ActionHandler<ZyteOnlyAction> | undefined;
    case 'interaction': {
      const h = handlers.interaction;
      return (typeof h === 'function' ? h : h?.[action.id]) as ActionHandler<ZyteOnlyAction> | undefined;
    }
  }
}

/** The Zyte-only actions in `actions` that no handler covers on `url`. */
export function withoutHandler(actions: readonly Action[] | undefined, handlers: ActionHandlers, url: URL): ZyteOnlyAction[] {
  return (actions ?? []).filter((action): action is ZyteOnlyAction => isZyteOnlyAction(action) && !handlerFor(action, handlers, url));
}

/** With `unsupportedActions: 'error'`: a 400 for the first Zyte-only action that has no handler. */
export function assertActionHandlers(actions: readonly Action[] | undefined, handlers: ActionHandlers, url: URL): void {
  const [action] = withoutHandler(actions, handlers, url);
  if (!action) return;
  const which = action.action === 'interaction' ? `the "interaction" action (script "${action.id}")` : `the "${action.action}" action`;
  throw unsupported(`${which} without a handler (pass one in \`actions.${action.action}\`, or use zyteApi())`);
}

const SEARCH_INPUTS = [
  'input[type="search"]',
  '[role="searchbox"]',
  'input[name="q"]',
  'textarea[name="q"]',
  'input[name="query"]',
  'input[name="search"]',
  'input[name*="search" i]',
  'input[id*="search" i]',
  'input[placeholder*="search" i]',
  'input[aria-label*="search" i]',
  'input[name*="keyword" i]',
];
const SEARCH_TOGGLES = ['button[aria-label*="search" i]', '[role="button"][aria-label*="search" i]', 'a[aria-label*="search" i]', 'button[class*="search" i]'];

async function firstVisible(page: Page, selectors: readonly string[]): Promise<Locator | undefined> {
  for (const selector of selectors) {
    const candidate = page.locator(`${selector} >> visible=true`).first();
    if ((await candidate.count()) > 0) return candidate;
  }
  return undefined;
}

/**
 * The default `searchKeyword`: finds the page's search box (search inputs, `role=searchbox`, a
 * `q`/`query`/`search` field, a "search" placeholder or label; opening a search toggle first when
 * the box is hidden behind one), types the keyword and presses Enter. Like Zyte's, it fails when
 * the page has no search box; sites it gets wrong can have their own handler.
 */
export const searchBox: ActionHandler<SearchKeywordAction> = async (page, action, { timeout }) => {
  let box = await firstVisible(page, SEARCH_INPUTS);
  if (!box) {
    const toggle = await firstVisible(page, SEARCH_TOGGLES);
    if (toggle) {
      await toggle.click({ timeout });
      await page.waitForSelector(SEARCH_INPUTS.join(', '), { state: 'visible', timeout: Math.min(timeout, 3000) }).catch(() => {});
      box = await firstVisible(page, SEARCH_INPUTS);
    }
  }
  if (!box) throw new Error('no search box found on the page');
  await box.fill(action.keyword, { timeout });
  await box.press('Enter', { timeout });
  await page.waitForLoadState('domcontentloaded', { timeout }).catch(() => {});
};
