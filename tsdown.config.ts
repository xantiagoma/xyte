import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: ['src/index.ts', 'src/cli.ts'],
  format: 'esm',
  platform: 'node',
  target: 'node20',
  dts: true,
  sourcemap: true,
  clean: true,
  deps: { neverBundle: ['playwright', 'playwright-core', 'undici'] },
});
