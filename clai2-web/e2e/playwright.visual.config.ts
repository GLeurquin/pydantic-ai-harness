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
  projects: [
    // The empty name keeps this project's baselines at their existing
    // `<id>-<platform>.png` path (Playwright's default snapshot path
    // template only inserts a `-<projectName>` segment when the project
    // has one -- see `sanitizeForFilePath`/`{-projectName}` in
    // playwright's workerProcessEntry.js), so introducing the mobile
    // project below doesn't rename every desktop baseline.
    { name: '' },
    { name: 'mobile', use: { viewport: { width: 390, height: 844 } } },
  ],
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
