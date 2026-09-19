import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    testTimeout: 20_000,
    hookTimeout: 20_000,
    // Process-supervision tests spawn real children and bind real ports.
    // Running files in parallel makes port/pid assertions flaky.
    fileParallelism: false,
  },
});
