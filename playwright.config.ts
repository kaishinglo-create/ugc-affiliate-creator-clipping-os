// Playwright is installed in browser-runtime-host, outside this project's
// TypeScript dependency tree. Runtime resolution still works from the repo root.
// @ts-expect-error Playwright has no declaration at this relative path.
import { defineConfig, devices } from './browser-runtime-host/node_modules/playwright/test.mjs';

export default defineConfig({
  testDir: './tests/e2e',
  testMatch: '**/*.spec.ts',
  fullyParallel: false,
  workers: 1,
  timeout: 45_000,
  expect: { timeout: 10_000 },
  // Plain list output only: no HTML report that could persist secrets.
  reporter: [['list']],
  use: {
    baseURL: 'http://127.0.0.1:3031',
  },
  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        headless: true,
        launchOptions: { args: ['--no-sandbox'] },
      },
    },
  ],
});
