'use strict';

/**
 * Instance identity in the browser (CEO-is-config sweep, central-DB test plan
 * hn-ceo-is-config-2026-08-15): the nav brand and the conversation speaker
 * labels render the values the stub log API's GET /identity serves — FIXTURE
 * values, never a real person. Asserting a real name here would be exactly the
 * bug this sweep exists to kill.
 */

const { test, expect } = require('@playwright/test');
const { resetStub } = require('./helpers');

// Must match e2e/fixtures/stub-log-api.js IDENTITY.
const FIXTURE_HUB_TITLE = 'E2E Fixture Hub';
const FIXTURE_OWNER_NAME = 'E2E Fixture Owner';

test.describe('instance identity', () => {
  test.beforeEach(async ({ request }) => {
    await resetStub(request);
  });

  // @plan:hn-ceo-is-config-2026-08-15 @promote
  test('TP-ceoconf-012 the nav brand renders the configured hub title from /identity', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('.brand a')).toHaveText(FIXTURE_HUB_TITLE);
    // Still the home link (TP-nexus-e2e-083 owns the navigation behavior).
    await expect(page.locator('.brand a')).toHaveAttribute('href', '/');
  });

  // @plan:hn-ceo-is-config-2026-08-15 @promote
  test('TP-ceoconf-013 a legacy conversation shows the identity name as the CEO-side speaker with the ceo rail', async ({ page }) => {
    await page.goto('/conversations/4001');
    await page.waitForLoadState('networkidle');
    const first = page.locator('article.msg:not(.thread-entry)').first();
    await expect(first.locator('.who')).toHaveText(FIXTURE_OWNER_NAME);
    await expect(first).toHaveClass(/\bceo\b/);
    // The agent side keeps its generic label.
    const second = page.locator('article.msg:not(.thread-entry)').nth(1);
    await expect(second.locator('.who')).toHaveText('Agent');
  });
});
