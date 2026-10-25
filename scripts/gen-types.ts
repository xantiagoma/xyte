/**
 * Regenerates src/zyte.gen.ts from spec/zyte-openapi.json.
 *
 * The spec is the one embedded in https://docs.zyte.com/zyte-api/usage/reference.html
 * (`__redoc_state.spec.data`). Upstream has a typo — `ProductNavigation.properties.required`
 * holds the required list — which openapi-typescript rejects, so it is patched here.
 *
 * openapi-typescript needs the TypeScript 5 JS API (TS 7 has none), so it runs from a throwaway
 * install next to typescript@5.
 * `--default-non-nullable false` keeps fields with a default optional, as they are on the wire.
 * `--empty-objects-unknown` types free-form objects (an interaction's `args`) as such, not as
 * `Record<string, never>`.
 */
import { $ } from 'bun';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const specPath = 'spec/zyte-openapi.json';
const spec = await Bun.file(specPath).json();
const nav = spec.components.schemas.ProductNavigation;
if (Array.isArray(nav.properties?.required)) {
  nav.required = nav.properties.required;
  delete nav.properties.required;
  await Bun.write(specPath, JSON.stringify(spec, null, 2) + '\n');
}

const dir = await mkdtemp(join(tmpdir(), 'xyte-gen-'));
try {
  await $`bun add openapi-typescript@7 typescript@5`.cwd(dir).quiet();
  await $`${join(dir, 'node_modules/.bin/openapi-typescript')} ${resolve(specPath)} --default-non-nullable false --empty-objects-unknown -o ${resolve('src/zyte.gen.ts')}`;
} finally {
  await rm(dir, { recursive: true, force: true });
}
