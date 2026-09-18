import { defineConfig } from '@playwright/test';

const PORT = 8977;

export default defineConfig({
  testDir: './tests',
  // Visual regression runs under its own config against the Ladle build,
  // not this app server; see playwright.visual.config.ts.
  testIgnore: 'visual.spec.ts',
  globalSetup: './global-setup.ts',
  // One worker: the suite shares one backend and asserts on live agent state.
  workers: 1,
  timeout: 30_000,
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    trace: 'retain-on-failure',
    // Honor a preinstalled Chromium when the environment provides one.
    ...(process.env.PW_CHROMIUM_PATH ? { launchOptions: { executablePath: process.env.PW_CHROMIUM_PATH } } : {}),
  },
  webServer: {
    command: [
      '../backend/target/debug/clai2-web-server',
      '--repo .tmp/repo',
      '--data-dir .tmp/data',
      '--worktrees-dir .tmp/worktrees',
      '--static-dir ../frontend/dist',
      `--port ${PORT}`,
      '--stub',
    ].join(' '),
    url: `http://127.0.0.1:${PORT}/api/health`,
    reuseExistingServer: false,
    timeout: 30_000,
  },
});
