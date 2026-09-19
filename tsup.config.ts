import { readFileSync } from 'node:fs';
import { defineConfig } from 'tsup';

const { version } = JSON.parse(readFileSync('package.json', 'utf8')) as { version: string };

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  target: 'node20',
  platform: 'node',
  clean: true,
  sourcemap: true,
  banner: { js: '#!/usr/bin/env node' },
  // Baked in at build time so `laracrew --version` cannot drift from package.json, and so the
  // published binary never reads a file to answer it. `tsx` falls back to reading package.json.
  define: { __LARACREW_VERSION__: JSON.stringify(version) },
});
