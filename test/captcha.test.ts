import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { browserFromEnv, capsolver, twoCaptcha, Xyte, type AttemptInfo, type CaptchaSolver, type CaptchaTask } from '../src/index.ts';
import { startTarget } from './fixtures.ts';

setDefaultTimeout(30_000);
let target: ReturnType<typeof startTarget>;
beforeAll(() => {
  target = startTarget();
});
afterAll(() => target.stop());

/** A createTask/getTaskResult service: processing once, then ready. */
function service(solution: Record<string, string>) {
  const calls: { path: string; body: Record<string, unknown> }[] = [];
  let polls = 0;
  const fetch = (async (url: string, init: RequestInit) => {
    const path = new URL(url).pathname.slice(1);
    const body = JSON.parse(String(init.body));
    calls.push({ path, body });
    if (path === 'createTask') return Response.json({ errorId: 0, taskId: 'T1' });
    return Response.json(++polls === 1 ? { errorId: 0, status: 'processing' } : { errorId: 0, status: 'ready', solution });
  }) as typeof globalThis.fetch;
  return { fetch, calls };
}

describe('solvers', () => {
  const task: CaptchaTask = { kind: 'recaptchaV2', siteKey: 'k', url: 'https://x.example/' };

  test('capsolver: createTask, then polls getTaskResult until ready', async () => {
    const { fetch, calls } = service({ gRecaptchaResponse: 'TOKEN' });
    const token = await capsolver({ apiKey: 'K', fetch, pollEvery: 0.01 }).solve(task);
    expect(token).toBe('TOKEN');
    expect(calls[0]).toEqual({ path: 'createTask', body: { clientKey: 'K', task: { type: 'ReCaptchaV2TaskProxyLess', websiteURL: 'https://x.example/', websiteKey: 'k' } } });
    expect(calls.slice(1).map((c) => c.body)).toEqual([
      { clientKey: 'K', taskId: 'T1' },
      { clientKey: 'K', taskId: 'T1' },
    ]);
  });

  test('2captcha: its own task names; Turnstile tokens come back as `token`', async () => {
    const { fetch, calls } = service({ token: 'TS' });
    expect(await twoCaptcha({ apiKey: 'K', fetch, pollEvery: 0.01 }).solve({ ...task, kind: 'turnstile', action: 'login' })).toBe('TS');
    expect(calls[0]!.body.task).toEqual({ type: 'TurnstileTaskProxyless', websiteURL: 'https://x.example/', websiteKey: 'k', pageAction: 'login' });
  });

  test('errors: a kind the service lacks, an error answer', async () => {
    await expect(capsolver({ apiKey: 'K' }).solve({ ...task, kind: 'hcaptcha' })).rejects.toThrow("capsolver doesn't solve hcaptcha");
    const failing = (async () => Response.json({ errorId: 1, errorDescription: 'ERROR_KEY_DOES_NOT_EXIST' })) as unknown as typeof fetch;
    await expect(twoCaptcha({ apiKey: 'K', fetch: failing }).solve(task)).rejects.toThrow('2captcha: ERROR_KEY_DOES_NOT_EXIST');
  });

  test('XYTE_CAPTCHA', () => {
    expect(browserFromEnv({ XYTE_CAPTCHA: 'capsolver', CAPSOLVER_API_KEY: 'k' }).captcha?.name).toBe('capsolver');
    expect(browserFromEnv({ XYTE_CAPTCHA: '2captcha', TWOCAPTCHA_API_KEY: 'k' }).captcha?.name).toBe('2captcha');
    expect(() => browserFromEnv({ XYTE_CAPTCHA: 'capsolver' })).toThrow(/CAPSOLVER_API_KEY/);
  });
});

describe('in a browser render', () => {
  for (const kind of ['recaptchaV2', 'turnstile'] as const) {
    test(`${kind}: found, solved, the token handed to the widget's callback; reported on the attempt`, async () => {
      const tasks: CaptchaTask[] = [];
      const solver: CaptchaSolver = {
        name: 'fake',
        solve: async (t) => {
          tasks.push(t);
          return `TOKEN-${t.kind}`;
        },
      };
      const attempts: AttemptInfo[] = [];
      const xyte = new Xyte({ retries: 0, browser: { captcha: solver }, onAttempt: (a) => attempts.push(a) });
      try {
        const res = await xyte.extract({ url: `${target.base}/captcha${kind === 'turnstile' ? '?kind=turnstile' : ''}`, browserHtml: true });
        expect(tasks).toEqual([{ kind, siteKey: 'site-key-123', url: expect.stringContaining('/captcha') }]);
        expect(res.browserHtml).toContain(`data-token="TOKEN-${kind}"`);
        expect(attempts[0]!.captchas).toEqual([{ kind, solver: 'fake', solved: true, ms: expect.any(Number) }]);
      } finally {
        await xyte.close();
      }
    });
  }

  test('a solver error is reported, the page still comes back', async () => {
    const attempts: AttemptInfo[] = [];
    const solver: CaptchaSolver = { name: 'broken', solve: async () => Promise.reject(new Error('no balance')) };
    const xyte = new Xyte({ retries: 0, browser: { captcha: solver }, onAttempt: (a) => attempts.push(a) });
    try {
      const res = await xyte.extract({ url: `${target.base}/captcha`, browserHtml: true });
      expect(res.statusCode).toBe(200);
      expect(attempts[0]!.captchas).toEqual([{ kind: 'recaptchaV2', solver: 'broken', solved: false, ms: expect.any(Number), error: 'no balance' }]);
    } finally {
      await xyte.close();
    }
  });
});
