import type { Page } from 'playwright';
import { sleep } from './util.ts';

/**
 * Captcha solving in browser renders: after the page loads (before your actions), a reCAPTCHA,
 * hCaptcha or Cloudflare Turnstile widget on it is sent to a solving service, and its token is put
 * where the page's form expects it, calling the widget's callback. Cloudflare's full-page "Just a
 * moment…" challenge is a different mechanism (cookies and fingerprint), not handled here.
 */
export type CaptchaKind = 'recaptchaV2' | 'recaptchaV3' | 'hcaptcha' | 'turnstile';

/** A captcha found on a page, as a solver gets it. */
export interface CaptchaTask {
  kind: CaptchaKind;
  siteKey: string;
  /** The page the widget is on. */
  url: string;
  /** reCAPTCHA v3 / Turnstile `action`, when the widget declares one. */
  action?: string;
}

/** Solves captchas for browser renders (`browser.captcha`): `capsolver()`, `twoCaptcha()`, or your own. */
export interface CaptchaSolver {
  readonly name: string;
  /** Resolves with the token the widget would have produced. */
  solve(task: CaptchaTask, signal?: AbortSignal): Promise<string>;
}

/** What happened to a captcha found on the page (in the attempt report). */
export interface CaptchaOutcome {
  kind: CaptchaKind;
  solver: string;
  solved: boolean;
  ms: number;
  error?: string;
}

/**
 * A solver for services with the `createTask` / `getTaskResult` API (CapSolver, 2Captcha, and
 * others that copied it): `types` maps each kind to the service's task type.
 */
export function createTaskSolver(options: {
  name: string;
  endpoint: string;
  apiKey: string;
  types: Partial<Record<CaptchaKind, string>>;
  /** Seconds between result polls. Default 3. */
  pollEvery?: number;
  /** Seconds before giving up. Default 120. */
  timeout?: number;
  fetch?: typeof fetch;
}): CaptchaSolver {
  const doFetch = options.fetch ?? fetch;
  const call = async (path: string, body: Record<string, unknown>, signal?: AbortSignal) => {
    const res = await doFetch(`${options.endpoint}/${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ clientKey: options.apiKey, ...body }),
      signal,
    });
    const json = (await res.json().catch(() => ({}))) as {
      errorId?: number;
      errorCode?: string;
      errorDescription?: string;
      taskId?: string | number;
      status?: string;
      solution?: { gRecaptchaResponse?: string; token?: string };
    };
    if (!res.ok || json.errorId) throw new Error(`${options.name}: ${json.errorDescription ?? json.errorCode ?? `HTTP ${res.status}`}`);
    return json;
  };
  return {
    name: options.name,
    async solve(task, signal) {
      const type = options.types[task.kind];
      if (!type) throw new Error(`${options.name} doesn't solve ${task.kind}`);
      const created = await call(
        'createTask',
        { task: { type, websiteURL: task.url, websiteKey: task.siteKey, ...(task.action && { pageAction: task.action }) } },
        signal,
      );
      const deadline = Date.now() + (options.timeout ?? 120) * 1000;
      while (Date.now() < deadline) {
        await sleep((options.pollEvery ?? 3) * 1000);
        signal?.throwIfAborted();
        const result = await call('getTaskResult', { taskId: created.taskId }, signal);
        if (result.status === 'ready') {
          const token = result.solution?.gRecaptchaResponse ?? result.solution?.token;
          if (!token) throw new Error(`${options.name}: no token in the solution`);
          return token;
        }
        if (result.status === 'failed') throw new Error(`${options.name}: the task failed`);
      }
      throw new Error(`${options.name}: no solution after ${options.timeout ?? 120} s`);
    },
  };
}

/** CapSolver (capsolver.com): reCAPTCHA v2/v3 and Turnstile, without a proxy of its own. From its docs; not checked against an account. */
export function capsolver(options: { apiKey: string; fetch?: typeof fetch; timeout?: number; pollEvery?: number }): CaptchaSolver {
  return createTaskSolver({
    name: 'capsolver',
    endpoint: 'https://api.capsolver.com',
    types: { recaptchaV2: 'ReCaptchaV2TaskProxyLess', recaptchaV3: 'ReCaptchaV3TaskProxyLess', turnstile: 'AntiTurnstileTaskProxyLess' },
    ...options,
  });
}

/** 2Captcha (2captcha.com), API v2: reCAPTCHA v2/v3, hCaptcha and Turnstile. From its docs; not checked against an account. */
export function twoCaptcha(options: { apiKey: string; fetch?: typeof fetch; timeout?: number; pollEvery?: number }): CaptchaSolver {
  return createTaskSolver({
    name: '2captcha',
    endpoint: 'https://api.2captcha.com',
    types: {
      recaptchaV2: 'RecaptchaV2TaskProxyless',
      recaptchaV3: 'RecaptchaV3TaskProxyless',
      hcaptcha: 'HCaptchaTaskProxyless',
      turnstile: 'TurnstileTaskProxyless',
    },
    ...options,
  });
}

interface Widget {
  kind: CaptchaKind;
  siteKey: string;
  action?: string;
  callback?: string;
}

/** The captcha widgets on the page: elements with a sitekey, or the widgets' iframes. */
export function findCaptchas(page: Page): Promise<Widget[]> {
  return page.evaluate(() => {
    const found: { kind: 'recaptchaV2' | 'hcaptcha' | 'turnstile'; siteKey: string; action?: string; callback?: string }[] = [];
    for (const el of Array.from(document.querySelectorAll('[data-sitekey]'))) {
      const kind = el.matches('.cf-turnstile, [class*="turnstile"]') ? 'turnstile' : el.matches('.h-captcha, [class*="h-captcha"]') ? 'hcaptcha' : 'recaptchaV2';
      found.push({
        kind,
        siteKey: el.getAttribute('data-sitekey')!,
        action: el.getAttribute('data-action') ?? undefined,
        callback: el.getAttribute('data-callback') ?? undefined,
      });
    }
    for (const frame of Array.from(document.querySelectorAll('iframe[src]'))) {
      const src = (frame as HTMLIFrameElement).src;
      let url: URL;
      try {
        url = new URL(src);
      } catch {
        continue;
      }
      if (/recaptcha\/(api2|enterprise)\/anchor/.test(url.pathname) && url.searchParams.get('k')) found.push({ kind: 'recaptchaV2', siteKey: url.searchParams.get('k')! });
      else if (url.hostname.endsWith('hcaptcha.com') && url.searchParams.get('sitekey')) found.push({ kind: 'hcaptcha', siteKey: url.searchParams.get('sitekey')! });
      else if (url.hostname === 'challenges.cloudflare.com') {
        const key = url.pathname.split('/').find((part) => /^0x[0-9A-Za-z_-]{10,}$/.test(part));
        if (key) found.push({ kind: 'turnstile', siteKey: key });
      }
    }
    const seen = new Set<string>();
    return found.filter((w) => !seen.has(`${w.kind}:${w.siteKey}`) && seen.add(`${w.kind}:${w.siteKey}`));
  });
}

/** Puts the token where the widget's form expects it, and calls its callback. */
export function injectToken(page: Page, widget: Widget, token: string): Promise<void> {
  return page.evaluate(
    ({ kind, callback, token }) => {
      const names = kind === 'turnstile' ? ['cf-turnstile-response'] : kind === 'hcaptcha' ? ['h-captcha-response', 'g-recaptcha-response'] : ['g-recaptcha-response'];
      for (const name of names) {
        const fields = Array.from(document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>(`[name="${name}"], #${name}`));
        if (fields.length === 0) {
          // The widget's script would have added it: add it to the form the widget sits in.
          const form = document.querySelector('[data-sitekey]')?.closest('form') ?? document.forms[0];
          const field = document.createElement('textarea');
          field.name = name;
          field.style.display = 'none';
          (form ?? document.body).appendChild(field);
          fields.push(field);
        }
        for (const field of fields) field.value = token;
      }
      const fn = callback ? (window as unknown as Record<string, unknown>)[callback] : undefined;
      if (typeof fn === 'function') (fn as (t: string) => void)(token);
    },
    { kind: widget.kind, callback: widget.callback, token },
  );
}
