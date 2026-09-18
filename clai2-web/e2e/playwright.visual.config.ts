import { defineConfig } from '@playwright/test';

const PORT = 61300;

export default defineConfig({
  testDir: './tests',
  testMatch: 'visual.spec.ts',
  // Screenshot baselines are pixel-exact; a story that races its own
  // animation frame flakes the whole suite otherwise.
  workers: 1,
  retries: 0,
  timeout: 15_000,
  expect: {
    toHaveScreenshot: { maxDiffPixels: 32 },
  },
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    trace: 'retain-on-failure',
    ...(process.env.PW_CHROMIUM_PATH ? { launchOptions: { executablePath: process.env.PW_CHROMIUM_PATH } } : {}),
  },
  webServer: {
    // Ladle's default host binds IPv6-only on some platforms; force IPv4 so
    // Playwright's own 127.0.0.1 health check can reach it.
    command: `npx ladle preview -o build --port ${PORT} --host 127.0.0.1`,
    cwd: '../frontend',
    url: `http://127.0.0.1:${PORT}`,
    reuseExistingServer: false,
    timeout: 30_000,
  },
});
