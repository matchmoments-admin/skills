import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './e2e',
  timeout: 90_000,
  retries: 1,
  reporter: [['list'], ['html', { open: 'never' }]],
  use: { headless: true, trace: 'retain-on-failure', video: 'retain-on-failure', screenshot: 'only-on-failure' }
});
