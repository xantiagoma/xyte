import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createHandler, verifyWebhook, Xyte, type Job } from '../src/index.ts';
import { startTarget } from './fixtures.ts';

let target: ReturnType<typeof startTarget>;
let hook: ReturnType<typeof Bun.serve>;
const deliveries: { body: string; signature: string | null; jobId: string | null }[] = [];
let hookStatus = 200;
beforeAll(() => {
  target = startTarget();
  hook = Bun.serve({
    port: 0,
    fetch: async (req) => {
      deliveries.push({ body: await req.text(), signature: req.headers.get('x-xyte-signature'), jobId: req.headers.get('x-xyte-job-id') });
      return new Response('', { status: hookStatus });
    },
  });
});
afterAll(() => {
  target.stop();
  hook.stop(true);
});

const handlerWith = (options: Parameters<typeof createHandler>[1] = {}) => {
  const handler = createHandler(new Xyte({ retries: 0 }), { apiKeys: ['K'], ...options });
  return (path: string, init: { method?: string; body?: unknown; key?: string } = {}) =>
    handler(
      new Request(`http://x${path}`, {
        method: init.method ?? (init.body ? 'POST' : 'GET'),
        headers: { authorization: `Basic ${btoa(`${init.key ?? 'K'}:`)}` },
        ...(init.body !== undefined && { body: JSON.stringify(init.body) }),
      }),
    );
};

/** Polls a job until it's finished (and its webhook, if any, is settled). */
async function finished(call: ReturnType<typeof handlerWith>, id: string): Promise<Job> {
  for (let i = 0; i < 100; i++) {
    const job = (await (await call(`/v1/jobs/${id}`)).json()) as Job;
    if ((job.status === 'done' || job.status === 'failed') && job.callback?.status !== 'pending') return job;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('job never finished');
}

describe('jobs', () => {
  test('202 at once, then the Zyte response when done', async () => {
    const call = handlerWith();
    const res = await call('/v1/jobs', { body: { url: `${target.base}/html`, httpResponseBody: true } });
    expect(res.status).toBe(202);
    const job = (await res.json()) as Job;
    expect(job.status).toBe('queued');
    expect(res.headers.get('location')).toBe(`/v1/jobs/${job.id}`);
    const done = await finished(call, job.id);
    expect(done).toMatchObject({ status: 'done', response: { statusCode: 200 } });
    expect(done.finishedAt).toBeDefined();
  });

  test('a failed extraction is a failed job with the Zyte problem', async () => {
    const call = handlerWith();
    const job = (await (await call('/v1/jobs', { body: { url: `${target.base}/forbidden`, httpResponseBody: true } })).json()) as Job;
    expect(await finished(call, job.id)).toMatchObject({ status: 'failed', error: { status: 520, type: '/download/website-ban' } });
  });

  test('the result is POSTed to callbackUrl, signed', async () => {
    const call = handlerWith({ jobs: { webhookSecret: 's3cret' } });
    const job = (await (await call('/v1/jobs', { body: { url: `${target.base}/html`, httpResponseBody: true, callbackUrl: hook.url.href } })).json()) as Job;
    const done = await finished(call, job.id);
    expect(done.callback).toEqual({ status: 'delivered', attempts: 1 });
    const delivery = deliveries.find((d) => d.jobId === job.id)!;
    expect(verifyWebhook(delivery.body, delivery.signature, 's3cret')).toBe(true);
    expect(verifyWebhook(delivery.body, delivery.signature, 'wrong')).toBe(false);
    expect(JSON.parse(delivery.body)).toMatchObject({ id: job.id, status: 'done', response: { statusCode: 200 } });
  });

  test('a webhook that keeps failing is retried, then marked failed', async () => {
    hookStatus = 500;
    try {
      const call = handlerWith({ jobs: { webhookAttempts: 2 } });
      const job = (await (await call('/v1/jobs', { body: { url: `${target.base}/html`, httpResponseBody: true, callbackUrl: hook.url.href } })).json()) as Job;
      const done = await finished(call, job.id);
      expect(done.callback).toMatchObject({ status: 'failed', attempts: 2, lastError: 'the webhook answered 500' });
    } finally {
      hookStatus = 200;
    }
  });

  test('validation, auth, unknown jobs, and turning the routes off', async () => {
    const call = handlerWith({ blockPrivateTargets: true });
    expect((await call('/v1/jobs', { body: { url: 'https://x.example/', httpResponseBody: true, callbackUrl: 'ftp://x' } })).status).toBe(400);
    const internal = await call('/v1/jobs', { body: { url: 'https://x.example/', httpResponseBody: true, callbackUrl: 'http://169.254.169.254/' } });
    expect(internal.status).toBe(400);
    expect((await call('/v1/jobs/nope')).status).toBe(404);
    expect((await call('/v1/jobs/nope', { key: 'bad' })).status).toBe(401);
    expect((await call('/v1/jobs', { method: 'GET' })).status).toBe(405);
    expect((await handlerWith({ jobs: false })('/v1/jobs', { body: { url: 'https://x.example/' } })).status).toBe(404);
  });
});
