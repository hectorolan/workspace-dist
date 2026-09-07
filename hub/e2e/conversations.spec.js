'use strict';

/**
 * Legacy conversation detail pages in a real browser (transcript rendering,
 * archive round-trip). The Conversations INDEX retired with document-threads N2
 * — TP-nexus-e2e-020/021 (its filters) retired with it, replaced by
 * TP-nexus-e2e-070/072 in conversation-threads.spec.js.
 * Test plan: hn-test-plan-2026-07-26-playwright-e2e (central DB).
 */

const { test, expect } = require('@playwright/test');
const { resetStub, STUB_URL } = require('./helpers');

test.describe('conversations', () => {
  test.beforeEach(async ({ request }) => {
    await resetStub(request);
  });

  test('TP-nexus-e2e-022 a thread renders its messages with sanitized markdown', async ({ page }) => {
    await page.goto('/conversations/4001');
    await page.waitForLoadState('networkidle');
    await expect(page.locator('.card h1')).toContainText('E2E active thread');
    // The transcript only — the document thread below has its own entries (e2e-073).
    await expect(page.locator('article.msg:not(.thread-entry)')).toHaveCount(2);
    await expect(page.locator('article.msg:not(.thread-entry)').first().locator('strong')).toHaveText('status');
  });

  test('TP-nexus-e2e-023 archiving from the detail page round-trips through the API and updates the badge', async ({ page, request }) => {
    await page.goto('/conversations/4001');
    await page.locator('button.row-action', { hasText: 'Archive' }).click();
    await expect(page.locator('.card .status-badge')).toContainText('archived');
    const patches = await (await request.get(`${STUB_URL}/__captured`)).json();
    expect(patches.statusPatches).toContainEqual({ id: '4001', status: 'archived' });
    // Restore the fixture for the rest of the suite.
    await page.locator('button.row-action', { hasText: 'Unarchive' }).click();
    await expect(page.locator('.card .status-badge')).toContainText('active');
  });
});
