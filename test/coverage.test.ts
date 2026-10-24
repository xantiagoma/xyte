import { expect, test } from 'bun:test';
import { ACTIONS, render, REQUEST, RESPONSE } from '../scripts/coverage.ts';

const spec = await Bun.file(new URL('../spec/zyte-openapi.json', import.meta.url)).json();
const schemas = spec.components.schemas;
const keys = (record: object) => Object.keys(record).sort();

test('every request field of the spec is classified', () => {
  expect(keys(REQUEST)).toEqual(keys(schemas.ExtractRequest.properties));
});

test('every response field of the spec is classified', () => {
  expect(keys(RESPONSE)).toEqual(keys(schemas.Response200.properties));
});

test('every action of the spec is classified', () => {
  const actions = schemas.ActionSequence.items.oneOf.map((ref: { $ref: string }) => ref.$ref.split('/').at(-1)).sort();
  expect(keys(ACTIONS)).toEqual(actions);
});

test('docs/coverage.md is up to date (bun scripts/coverage.ts)', async () => {
  expect(await Bun.file(new URL('../docs/coverage.md', import.meta.url)).text()).toBe(render());
});
