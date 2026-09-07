'use strict';

/**
 * Playwright config for the hub browser suite (`npm run test:e2e`).
 *
 * Methodology: the workspace `webapp-testing` skill — headless chromium,
 * reconnaissance-then-action selectors, and a managed server lifecycle. The skill
 * demonstrates its server helper in Python; this repo is Node end to end (see
 * CLAUDE.md "Stack"), so the same lifecycle is expressed through Playwright's
 * native `webServer` blocks rather than adding a second toolchain to CI.
 *
 * Two servers come up per run and both are torn down afterwards:
 *   1. e2e/fixtures/stub-log-api.js — the log API the app reads server-side. The
 *      real API is never contacted: the browser suite must be deterministic and
 *      must never write to the central DB.
 *   2. src/server.js with AUTH_BYPASS=true — the documented dev/test auth mode
 *      (CLAUDE.md "Dev auth bypass"). BASE_URL stays http:// so the production
 *      guard in src/config.js is satisfied; the server-side allowlist still runs.
 */

const path = require('node:path');
const { defineConfig, devices } = require('@playwright/test');

const APP_PORT = Number(process.env.E2E_APP_PORT || 8099);
const STUB_PORT = Number(process.env.E2E_STUB_PORT || 8791);
const baseURL = `http://127.0.0.1:${APP_PORT}`;
const stubURL = `http://127.0.0.1:${STUB_PORT}`;

module.exports = defineConfig({
  testDir: './e2e',
  testMatch: '**/*.spec.js',
  fullyParallel: false, // the stub server holds mutable state (captures, archive flags)
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : [['list']],
  use: {
    baseURL,
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: [
    {
      command: `node e2e/fixtures/stub-log-api.js --port ${STUB_PORT}`,
      url: `${stubURL}/__captured`,
      reuseExistingServer: !process.env.CI,
      stdout: 'ignore',
      stderr: 'pipe',
    },
    {
      command: 'node src/server.js',
      url: `${baseURL}/healthz`,
      reuseExistingServer: !process.env.CI,
      stdout: 'ignore',
      stderr: 'pipe',
      env: {
        PORT: String(APP_PORT),
        BASE_URL: baseURL,
        AUTH_BYPASS: 'true',
        AUTH_BYPASS_EMAIL: 'e2e-owner@example.com',
        ALLOWED_EMAIL: 'e2e-owner@example.com',
        SESSION_SECRET: 'e2e-session-secret',
        LOG_API_URL: stubURL,
        LOG_API_KEY: 'e2e-api-key',
        WORKSPACE_CLAUDE_DIR: path.join(__dirname, 'e2e', 'fixtures', 'claude'),
        // Fixture pages root (test plan hub-pages-framework-core-2026-08-29):
        // all three tiers plus a skipped no-index folder, fully deterministic.
        HUB_PAGES_DIR: path.join(__dirname, 'e2e', 'fixtures', 'pages'),
      },
    },
  ],
});
