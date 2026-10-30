import { defineConfig } from '@playwright/test';

/**
 * E2E config for the real Chrome boundary. Tests load the built extension from `dist/` via a
 * persistent context (the only way Chrome loads an unpacked MV3 extension) and exercise the
 * side panel page + chrome.storage.local. Run `npm run build` first so `dist/` exists.
 */
export default defineConfig({
  testDir: './e2e',
  testMatch: /.*\.spec\.ts/,
  fullyParallel: false,
  workers: 1,
  timeout: 60_000,
  reporter: process.env.CI ? 'github' : 'list',
  use: {
    trace: 'on-first-retry'
  }
});
