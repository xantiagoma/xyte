import type { BrowserOptions, BrowserTypeLike } from './engines/browser.ts';
import { serverError } from './errors.ts';

/**
 * Browser presets for sites that detect automation: spread one into `browser`
 * (`new Xyte({ browser: { ...camoufox(), blockResources: ['image'] } })`), or pick it with
 * `XYTE_BROWSER`. Each is an optional install; a missing one is a 500 saying what to install.
 */

async function load<T>(name: string, install: string): Promise<T> {
  try {
    return (await import(name)) as T;
  } catch (error) {
    throw serverError(`the "${name}" browser isn't installed (${install})`, error);
  }
}

/**
 * Browsers that bring their own fingerprint (user agent, screen, client hints) keep it: xyte's
 * defaults for those would contradict it, which is exactly what detection looks for.
 */
const ownFingerprint: NonNullable<BrowserOptions['contextOptions']> = ({ userAgent: _userAgent, viewport: _viewport, ...rest }) => rest;

/** Patchright: Playwright patched against CDP-based detection (Chromium). */
export function patchright(): BrowserOptions {
  return {
    browserType: async () => (await load<{ chromium: BrowserTypeLike }>('patchright', 'npm i patchright && npx patchright install chromium')).chromium,
    contextOptions: ownFingerprint,
  };
}

/** rebrowser-playwright: Playwright with the rebrowser patches (Chromium), a drop-in. */
export function rebrowser(): BrowserOptions {
  return {
    browserType: async () =>
      (await load<{ chromium: BrowserTypeLike }>('rebrowser-playwright', 'npm i rebrowser-playwright && npx rebrowser-playwright install chromium')).chromium,
  };
}

/** Camoufox: a Firefox build that spoofs its fingerprint at the C++ level, through `camoufox-js`. Options go to `Camoufox()`. */
export function camoufox(options: Record<string, unknown> = {}): BrowserOptions {
  return {
    launch: async () =>
      (await load<{ Camoufox: (o: Record<string, unknown>) => Promise<unknown> }>('camoufox-js', 'npm i camoufox-js playwright-core && npx camoufox-js fetch')).Camoufox({
        headless: true,
        ...options,
      }),
    contextOptions: ownFingerprint,
  };
}

/** CloakBrowser: a Chromium patched at the source level against fingerprinting. Options go to its `launch()`. */
export function cloakBrowser(options: Record<string, unknown> = {}): BrowserOptions {
  return {
    launch: async () =>
      (await load<{ launch: (o: Record<string, unknown>) => Promise<unknown> }>('cloakbrowser', 'npm i cloakbrowser playwright-core')).launch({
        headless: true,
        ...options,
      }),
    contextOptions: ownFingerprint,
  };
}

/** The presets by their `XYTE_BROWSER` names. */
export const STEALTH_BROWSERS: Readonly<Record<string, () => BrowserOptions>> = {
  patchright,
  rebrowser,
  'rebrowser-playwright': rebrowser,
  camoufox,
  cloakbrowser: cloakBrowser,
};
