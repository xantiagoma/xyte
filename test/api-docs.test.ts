import { expect, test } from 'bun:test';
import * as xyte from '../src/index.ts';

/** Every export of the package, runtime values and types, named in docs/api.md. */
test('docs/api.md covers every export', async () => {
  const doc = await Bun.file(new URL('../docs/api.md', import.meta.url)).text();
  const index = await Bun.file(new URL('../src/index.ts', import.meta.url)).text();
  const types = await Bun.file(new URL('../src/types.ts', import.meta.url)).text();
  const names = new Set([
    ...Object.keys(xyte),
    ...[...index.matchAll(/\btype ([A-Z]\w*)/g)].map((m) => m[1]!),
    ...[...types.matchAll(/^export type (\w+)/gm)].map((m) => m[1]!),
  ]);
  // Named as code: `name`, `name(…)`, `name<…>`, or in a `a, b, c` list.
  const missing = [...names].filter((name) => !new RegExp('`' + name + '(?=[`(<])').test(doc)).sort();
  expect(missing).toEqual([]);
});
