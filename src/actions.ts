import type { Locator, Page } from 'playwright';
import { unsupported } from './errors.ts';
import type { Action } from './types.ts';

/** Zyte's `searchKeyword` action: type `keyword` into the page's search box and submit. */
export type SearchKeywordAction = Extract<Action, { action: 'searchKeyword' }>;
/** Zyte's `setLocation` action: set the site's delivery or store location to an address. */
export type SetLocationAction = Extract<Action, { action: 'setLocation' }>;
/** Zyte's `interaction` action: run a script by `id` (on Zyte, one from its cloud IDE). */
export type InteractionAction = Extract<Action, { action: 'interaction' }>;
/**
 * Zyte's own actions, which rely on Zyte's per-site knowledge (`searchKeyword`, `setLocation`) or
 * on scripts stored in Zyte's cloud IDE (`interaction`). Zyte runs them on attempts that reach
 * `zyteApi()`; elsewhere they run in xyte's browser through handlers: yours (which always run
 * locally), or the built-in heuristic for `searchKeyword`. Without one, `unsupportedActions`
 * decides (skip with a warning, pass over to Zyte, or a 400). See docs/actions.md.
 */
export type ZyteOnlyAction = SearchKeywordAction | SetLocationAction | InteractionAction;

/** What an action handler gets besides the page and the action. */
export interface ActionHandlerContext {
  /** The page's current URL. */
  url: URL;
  /** Milliseconds the action may take: 30 s, within the browser time left (these actions have no `timeout` of their own). */
  timeout: number;
  /** Adds a line to the action's `interactionLogs` in the response, as Zyte does with its scripts' `console.log`. */
  log: (message: string, level?: 'debug' | 'info' | 'warning' | 'error') => void;
}

/** Runs one action on the page; throw to fail it (its `onError` then applies, as for any action). */
export type ActionHandler<A extends ZyteOnlyAction> = (page: Page, action: A, context: ActionHandlerContext) => Promise<void>;

/** A handler, or `null` for explicitly none (no fallback, no built-in). */
export type ActionEntry<A extends ZyteOnlyAction> = ActionHandler<A> | null;

/**
 * Handlers by site: keys are hosts (subdomains included, the longest key wins), `'*'` is every
 * other site. A plain function is the same as `{ '*': fn }`.
 */
export type PerSite<A extends ZyteOnlyAction> = ActionHandler<A> | Readonly<Record<string, ActionEntry<A>>>;

/** Handlers by the `id` the action names; `'*'` is every other id. A plain function is `{ '*': fn }`. */
export type ById<A extends ZyteOnlyAction> = ActionHandler<A> | Readonly<Record<string, ActionEntry<A>>>;

/**
 * The `actions` option: how `searchKeyword`, `setLocation` and `interaction` run outside Zyte.
 * Each takes a handler, or a table by site (`PerSite`) or by id (`ById`). See docs/actions.md.
 */
export interface ActionHandlers {
  /** `'*'` defaults to `searchBox`, a heuristic that finds the page's search box; `null` (or `false`) turns it off. */
  searchKeyword?: PerSite<SearchKeywordAction> | false;
  /** `'*'` defaults to none: forms to set a location are different on every site. */
  setLocation?: PerSite<SetLocationAction>;
  /** Your scripts by id; `'*'` defaults to none. */
  interaction?: ById<InteractionAction>;
}

const ZYTE_ONLY = new Set<string>(['searchKeyword', 'setLocation', 'interaction']);

/** Whether an action is one of Zyte's own three (`searchKeyword`, `setLocation`, `interaction`). */
export const isZyteOnlyAction = (action: Action): action is ZyteOnlyAction => ZYTE_ONLY.has(action.action);

/** The entry a table has for `matches` keys, else its `'*'`; undefined when it says nothing. */
function lookup<A extends ZyteOnlyAction>(
  table: ActionHandler<A> | Readonly<Record<string, ActionEntry<A>>> | undefined,
  pick: (keys: string[]) => string | undefined,
): ActionEntry<A> | undefined {
  if (table === undefined || typeof table === 'function') return table;
  const key = pick(Object.keys(table).filter((k) => k !== '*'));
  if (key !== undefined) return table[key];
  return '*' in table ? table['*'] : undefined;
}

const byHost = (url: URL) => (keys: string[]) => {
  const host = url.hostname.toLowerCase();
  return keys.filter((key) => host === key.toLowerCase() || host.endsWith(`.${key.toLowerCase()}`)).sort((a, b) => b.length - a.length)[0];
};

/** What you configured for `action` on `url`: a handler, `null` (explicitly none), or undefined (nothing). */
function ownEntryFor(action: ZyteOnlyAction, handlers: ActionHandlers, url: URL): ActionEntry<ZyteOnlyAction> | undefined {
  switch (action.action) {
    case 'searchKeyword':
      return handlers.searchKeyword === false ? null : (lookup(handlers.searchKeyword, byHost(url)) as ActionEntry<ZyteOnlyAction> | undefined);
    case 'setLocation':
      return lookup(handlers.setLocation, byHost(url)) as ActionEntry<ZyteOnlyAction> | undefined;
    case 'interaction':
      return lookup(handlers.interaction, (keys) => keys.find((key) => key === action.id)) as ActionEntry<ZyteOnlyAction> | undefined;
  }
}

/** The handler that runs `action` on `url` in xyte's browser: yours, else the built-in one (searchKeyword). */
export function handlerFor(action: ZyteOnlyAction, handlers: ActionHandlers, url: URL): ActionHandler<ZyteOnlyAction> | undefined {
  const own = ownEntryFor(action, handlers, url);
  if (own !== undefined) return own ?? undefined;
  return action.action === 'searchKeyword' ? (searchBox as ActionHandler<ZyteOnlyAction>) : undefined;
}

/**
 * The request's Zyte-only actions on `url`, by who would run them in xyte's browser: a handler you
 * configured (`own`, always run locally), the built-in one (`builtIn`, a fallback for where Zyte
 * isn't), or nothing (`none`).
 */
export function classifyActions(
  actions: readonly Action[] | undefined,
  handlers: ActionHandlers,
  url: URL,
): { own: ZyteOnlyAction[]; builtIn: ZyteOnlyAction[]; none: ZyteOnlyAction[] } {
  const groups = { own: [] as ZyteOnlyAction[], builtIn: [] as ZyteOnlyAction[], none: [] as ZyteOnlyAction[] };
  for (const action of actions ?? []) {
    if (!isZyteOnlyAction(action)) continue;
    if (ownEntryFor(action, handlers, url)) groups.own.push(action);
    else if (handlerFor(action, handlers, url)) groups.builtIn.push(action);
    else groups.none.push(action);
  }
  return groups;
}

/** With `unsupportedActions: 'error'`: a 400 for the first Zyte-only action that has no handler. */
export function assertActionHandlers(actions: readonly Action[] | undefined, handlers: ActionHandlers, url: URL): void {
  const [action] = classifyActions(actions, handlers, url).none;
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
