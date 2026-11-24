import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    testTimeout: 60000,
    hookTimeout: 60000,
    include: ['tests/**/*.test.ts'],
    exclude: ['dist/**', 'node_modules/**'],
    // The integration suite uses PostgreSQL and interactive transactions. On a
    // 2-CPU host, Vitest's default worker fan-out starves the pool and produces
    // false failures; keep the same assertions with a bounded worker count.
    maxWorkers: 2,
    minWorkers: 1,
  },
});
