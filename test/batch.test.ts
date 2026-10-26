import { afterAll, beforeAll, expect, test } from 'bun:test';
import { Xyte, XyteError } from '../src/index.ts';
import { startTarget } from './fixtures.ts';

let target: ReturnType<typeof startTarget>;
beforeAll(() => {
  target = startTarget();
});
afterAll(() => target.stop());

test('extractMany: results as they finish, with their index; a failure does not stop the batch', async () => {
  const xyte = new Xyte({ retries: 0 });
  const urls = ['/api/slow', '/html', '/missing', '/forbidden'].map((path) => ({ url: `${target.base}${path}`, httpResponseBody: true }));
  const order: number[] = [];
  const results = [];
  for await (const result of xyte.extractMany(urls)) {
    order.push(result.index);
    results[result.index] = result;
  }
  expect(order[order.length - 1]).toBe(0); // the slow one finished last
  expect(results[1]!.response!.statusCode).toBe(200);
  expect(results[2]!.response!.statusCode).toBe(404);
  expect(results[3]!.error).toBeInstanceOf(XyteError);
});

test('extractMany: at most `concurrency` in flight, fed lazily from an async source', async () => {
  let pulled = 0;
  let inFlight = 0;
  let most = 0;
  async function* source() {
    for (let i = 0; i < 6; i++) {
      pulled++;
      yield { url: `${target.base}/api/slow?i=${i}`, httpResponseBody: true };
    }
  }
  const counting = new Xyte({
    retries: 0,
    transport: async (req) => {
      inFlight++;
      most = Math.max(most, inFlight);
      try {
        return await fetch(req.url, { method: req.method, headers: req.headers, signal: req.signal });
      } finally {
        inFlight--;
      }
    },
  });
  const all = await counting.extractAll(source(), { concurrency: 2 });
  expect(all.map((r) => r.index)).toEqual([0, 1, 2, 3, 4, 5]); // extractAll: input order
  expect(most).toBe(2);
  expect(pulled).toBe(6);
});

test('extractMany: leaving the loop early cancels what is in flight and closes the source', async () => {
  let finished = 0;
  let aborted = 0;
  let sourceClosed = false;
  async function* source() {
    try {
      for (let i = 0; ; i++) yield { url: `${target.base}/${i === 0 ? 'html' : 'api/slow'}?i=${i}`, httpResponseBody: true };
    } finally {
      sourceClosed = true;
    }
  }
  const xyte = new Xyte({
    retries: 0,
    transport: async (req) => {
      try {
        const res = await fetch(req.url, { method: req.method, headers: req.headers, signal: req.signal });
        finished++;
        return res;
      } catch (error) {
        aborted++;
        throw error;
      }
    },
  });
  for await (const result of xyte.extractMany(source(), { concurrency: 3 })) {
    expect(result.index).toBe(0); // /html answers first
    break;
  }
  expect(sourceClosed).toBe(true);
  expect(aborted).toBe(2); // the two slow ones still running, not left to finish unread
  await Bun.sleep(600);
  expect(finished).toBe(1);
});

test('xyte batch: JSONL in, JSONL out', async () => {
  const input = `${target.base}/html\n# a comment\n{"url":"${target.base}/missing","httpResponseBody":true}\n`;
  const proc = Bun.spawn(['bun', 'src/cli.ts', 'batch', '-'], { stdin: new Blob([input]), stdout: 'pipe', stderr: 'pipe' });
  const out = (await new Response(proc.stdout).text()).trim().split('\n').map((line) => JSON.parse(line));
  expect(await proc.exited).toBe(0);
  expect(out.map((r) => [r.index, r.response.statusCode]).sort()).toEqual([
    [0, 200],
    [1, 404],
  ]);
});
