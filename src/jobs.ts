import { createHmac } from 'node:crypto';
import type { RequestReport, Xyte } from './client.ts';
import { XyteError, type XyteProblem } from './errors.ts';
import { memoryStore, resilient, type StateStore } from './state.ts';
import type { ExtractRequest, ExtractResponse } from './types.ts';
import { randomSessionId, sleep } from './util.ts';

/**
 * Asynchronous extraction: submit a request, get an id back at once, and fetch the result later
 * or have it POSTed to a webhook. For renders that outlast an HTTP timeout, and for queues.
 */
export interface JobsOptions {
  /** Where jobs are kept. Default: this process's memory. Redis lets any instance answer a job's status. */
  store?: StateStore;
  /** Seconds a job (and its result) is kept. Default 86400 (a day). */
  ttl?: number;
  /** Signs webhook deliveries: `X-Xyte-Signature: sha256=<hex HMAC-SHA256 of the body>`. */
  webhookSecret?: string;
  /** Webhook delivery attempts. Default 3, backing off 1 s, 2 s… */
  webhookAttempts?: number;
  /** For webhook deliveries (tests, proxies). */
  fetch?: typeof fetch;
  /** Each job's request report (the server feeds its stats with it). */
  onReport?: (report: RequestReport) => void;
}

export interface Job {
  id: string;
  status: 'queued' | 'running' | 'done' | 'failed';
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  /** The Zyte response, when `done`. */
  response?: ExtractResponse;
  /** The Zyte problem, when `failed`. */
  error?: XyteProblem;
  callbackUrl?: string;
  /** How the webhook delivery went. */
  callback?: { status: 'pending' | 'delivered' | 'failed'; attempts: number; lastError?: string };
}

export class Jobs {
  private readonly store: StateStore;
  private readonly ttl: number;

  constructor(
    private readonly xyte: Xyte,
    private readonly options: JobsOptions = {},
  ) {
    this.store = options.store ? resilient(options.store) : memoryStore({ maxEntries: 10_000 });
    this.ttl = options.ttl ?? 86_400;
  }

  /** Queues a request and starts it in the background; resolves with the queued job. */
  async submit(request: ExtractRequest, callbackUrl?: string): Promise<Job> {
    const job: Job = {
      id: randomSessionId(),
      status: 'queued',
      createdAt: new Date().toISOString(),
      ...(callbackUrl && { callbackUrl, callback: { status: 'pending', attempts: 0 } }),
    };
    await this.save(job);
    // The caller gets the job as queued; run() goes on with its own copy.
    const queued = structuredClone(job);
    void this.run(job, request);
    return queued;
  }

  async get(id: string): Promise<Job | undefined> {
    const value = await this.store.get(`job:${id}`);
    return value ? (JSON.parse(value) as Job) : undefined;
  }

  private save(job: Job): Promise<void> {
    return this.store.set(`job:${job.id}`, JSON.stringify(job), this.ttl);
  }

  private async run(job: Job, request: ExtractRequest): Promise<void> {
    job.status = 'running';
    job.startedAt = new Date().toISOString();
    await this.save(job);
    try {
      job.response = await this.xyte.extract(request, { onReport: this.options.onReport });
      job.status = 'done';
    } catch (error) {
      job.status = 'failed';
      job.error =
        error instanceof XyteError
          ? error.toJSON()
          : { status: 500, type: '/server/internal', title: 'Internal Server Error', detail: error instanceof Error ? error.message : String(error) };
    }
    job.finishedAt = new Date().toISOString();
    await this.save(job);
    if (job.callbackUrl) await this.deliver(job);
  }

  /** POSTs the finished job to its callback URL, retrying with backoff. */
  private async deliver(job: Job): Promise<void> {
    const doFetch = this.options.fetch ?? fetch;
    const attempts = this.options.webhookAttempts ?? 3;
    const { callback: _callback, ...payload } = job;
    const body = JSON.stringify(payload);
    const headers: Record<string, string> = { 'content-type': 'application/json', 'x-xyte-job-id': job.id };
    if (this.options.webhookSecret) {
      headers['x-xyte-signature'] = `sha256=${createHmac('sha256', this.options.webhookSecret).update(body).digest('hex')}`;
    }
    const callback = job.callback!;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      callback.attempts = attempt;
      try {
        const res = await doFetch(job.callbackUrl!, { method: 'POST', headers, body, signal: AbortSignal.timeout(30_000) });
        await res.body?.cancel();
        if (res.ok) {
          callback.status = 'delivered';
          delete callback.lastError;
          await this.save(job);
          return;
        }
        callback.lastError = `the webhook answered ${res.status}`;
      } catch (error) {
        callback.lastError = error instanceof Error ? error.message : String(error);
      }
      if (attempt < attempts) await sleep(1000 * 2 ** (attempt - 1));
    }
    callback.status = 'failed';
    await this.save(job);
  }
}

/** Verifies a webhook delivery's `X-Xyte-Signature` against the raw body. */
export function verifyWebhook(body: string, signature: string | null | undefined, secret: string): boolean {
  if (!signature?.startsWith('sha256=')) return false;
  const expected = createHmac('sha256', secret).update(body).digest('hex');
  const given = signature.slice('sha256='.length);
  if (given.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ given.charCodeAt(i);
  return diff === 0;
}
