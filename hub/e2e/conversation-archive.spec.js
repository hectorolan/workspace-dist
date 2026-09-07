'use strict';

/**
 * Conversation archive for BOTH populations + artifact-linkage badges in a
 * real browser (piece 2 of hub-conversation-archive-api-2026-08-17; test plan
 * hub-conversation-archive-ui-2026-08-17). The stub serves the piece-1 log-API
 * shapes; POST /__legacy-thread arms the pre-piece-1 behavior so the
 * degradation path runs against the real client code. Archive is deliberately
 * dialog-free (CEO ruling 2026-08-17: archive means drop it — reversible, the
 * inbox runner skips archived threads until unarchived).
 */

const { test, expect } = require('@playwright/test');
const { resetStub, STUB_URL } = require('./helpers');

const statusPatches = async (request) =>
  (await (await request.get(`${STUB_URL}/__captured`)).json()).statusPatches;

test.describe('conversation archive + artifact badges', () => {
  test.beforeEach(async ({ request }) => {
    await resetStub(request);
  });

  // @plan:hub-conversation-archive-ui-2026-08-17 @promote
  test('TP-convarch-010 linked rows wear an artifact chip deep-linking the document; unlinked rows wear none', async ({ page }) => {
    await page.goto('/conversations?archived=1');
    await page.waitForLoadState('networkidle');
    const rowFor = (title) => page.locator('ul.conv-index li', { hasText: title });

    // Legacy conversation 4001 → the test plan it generated.
    const legacyChip = rowFor('E2E active thread').locator('a.artifact-chip');
    await expect(legacyChip).toHaveText('→ plan');
    await expect(legacyChip).toHaveAttribute('href', '/plans/e2e-closed-test-plan');
    // Page-born conv-8100 → the plan it generated.
    const bornChip = rowFor('Wire the beach house alarm').locator('a.artifact-chip');
    await expect(bornChip).toHaveAttribute('href', '/plans/e2e-active-plan');
    // The unlinked conversation shows no chip — absence, never an empty badge.
    await expect(rowFor('E2E archived thread').locator('a.artifact-chip')).toHaveCount(0);

    // The chip navigates to the DOCUMENT, not the conversation.
    await bornChip.click();
    await page.waitForLoadState('networkidle');
    await expect(page).toHaveURL(/\/plans\/e2e-active-plan$/);
    await expect(page.locator('.card h1').first()).toContainText('E2E active plan');
  });

  // @plan:hub-conversation-archive-ui-2026-08-17 @promote
  test('TP-convarch-011 page-born archive/unarchive round-trips through the backing conversation row and the index reflects it', async ({ page, request }) => {
    await page.goto('/conversations/conv-8100');
    await page.waitForLoadState('networkidle');
    await expect(page.locator('.card .status-badge')).toHaveText('active');

    // Archive: one click, no confirm dialog (CEO ruling) — the hub PATCHes the
    // backing conversation row server-side and the badge flips on refetch.
    await page.getByRole('button', { name: 'Archive', exact: true }).click();
    await expect(page.locator('.card .status-badge')).toHaveText('archived');
    expect(await statusPatches(request)).toContainEqual({ id: '4101', status: 'archived' });

    // The index drops the row from the default view and reveals it, marked,
    // behind the archived toggle.
    await page.goto('/conversations');
    await page.waitForLoadState('networkidle');
    await expect(page.locator('ul.conv-index')).not.toContainText('Wire the beach house alarm');
    await page.goto('/conversations?archived=1');
    await page.waitForLoadState('networkidle');
    const row = page.locator('ul.conv-index li', { hasText: 'Wire the beach house alarm' });
    await expect(row.locator('.status-badge')).toHaveText('archived');
    await expect(row).toHaveClass(/rail-archived/);

    // Fully reversible: unarchive restores the row (and inbox eligibility).
    await page.goto('/conversations/conv-8100');
    await page.waitForLoadState('networkidle');
    await page.getByRole('button', { name: 'Unarchive', exact: true }).click();
    await expect(page.locator('.card .status-badge')).toHaveText('active');
    expect(await statusPatches(request)).toContainEqual({ id: '4101', status: 'active' });
    await page.goto('/conversations');
    await page.waitForLoadState('networkidle');
    await expect(page.locator('ul.conv-index')).toContainText('Wire the beach house alarm');
  });

  // @plan:hub-conversation-archive-ui-2026-08-17 @promote
  test('TP-convarch-012 legacy archive round-trips reflect on the index; the archived row stays reachable by URL', async ({ page, request }) => {
    await page.goto('/conversations/4001');
    await page.waitForLoadState('networkidle');
    await page.getByRole('button', { name: 'Archive', exact: true }).click();
    await expect(page.locator('.card .status-badge')).toContainText('archived');
    expect(await statusPatches(request)).toContainEqual({ id: '4001', status: 'archived' });

    await page.goto('/conversations');
    await page.waitForLoadState('networkidle');
    await expect(page.locator('ul.conv-index')).not.toContainText('E2E active thread');
    await page.goto('/conversations?archived=1');
    await page.waitForLoadState('networkidle');
    await expect(
      page.locator('ul.conv-index li', { hasText: 'E2E active thread' }).locator('.status-badge')
    ).toHaveText('archived');

    // Direct URL still serves the archived thread; unarchive restores it.
    await page.goto('/conversations/4001');
    await page.waitForLoadState('networkidle');
    await page.getByRole('button', { name: 'Unarchive', exact: true }).click();
    await expect(page.locator('.card .status-badge')).toContainText('active');
    await page.goto('/conversations');
    await page.waitForLoadState('networkidle');
    await expect(page.locator('ul.conv-index')).toContainText('E2E active thread');
  });

  // @plan:hub-conversation-archive-ui-2026-08-17 @promote
  test('TP-convarch-013 a pre-piece-1 log API degrades: index renders with no badges and no console errors; archive fails clean', async ({ page, request }) => {
    const pageErrors = [];
    const consoleErrors = [];
    page.on('pageerror', (e) => pageErrors.push(String(e)));
    page.on('console', (m) => {
      if (m.type() === 'error') consoleErrors.push(m.text());
    });
    await request.post(`${STUB_URL}/__legacy-thread`);

    await page.goto('/conversations');
    await page.waitForLoadState('networkidle');
    // Both populations render; the third row is the page-born opener's backing
    // conversation row, which the old API cannot identify for dedupe — the
    // status-quo-ante duplicate, degraded but never broken.
    await expect(page.locator('ul.conv-index li')).toHaveCount(3);
    await expect(page.locator('ul.conv-index')).toContainText('E2E active thread');
    await expect(page.locator('ul.conv-index')).toContainText('Wire the beach house alarm');
    await expect(page.locator('a.artifact-chip')).toHaveCount(0);
    expect(consoleErrors, 'the badge-less index must not spray the console').toEqual([]);

    // The oldest API carries no conversation ids on thread messages: archiving
    // a page-born thread surfaces the clean inline error, page intact. (The
    // 404 itself may log a resource-load console line — only real JS
    // exceptions fail the case here.)
    await page.goto('/conversations/conv-8100');
    await page.waitForLoadState('networkidle');
    await page.getByRole('button', { name: 'Archive', exact: true }).click();
    await expect(page.locator('.comment-err')).toContainText('not found');
    await expect(page.locator('#doc-thread article.thread-entry')).toHaveCount(2);
    expect(pageErrors).toEqual([]);
  });

  // ---- artifact chips INSIDE the detail pages (test plan
  // hub-conversation-detail-artifact-chips-2026-08-17): the index chip's link
  // now also renders in the conversation header, next to the status badge.

  // @plan:hub-conversation-detail-artifact-chips-2026-08-17 @promote
  test('TP-convchip-004 the legacy detail header wears the artifact chip; an unlinked conversation shows none', async ({ page }) => {
    await page.goto('/conversations/4001');
    await page.waitForLoadState('networkidle');
    // In the header card, beside the status badge (the CEO's "in the top,
    // next to the status archive").
    const chip = page.locator('.card h1 a.artifact-chip');
    await expect(chip).toHaveText('→ plan');
    await expect(chip).toHaveAttribute('href', '/plans/e2e-closed-test-plan');
    // The unlinked conversation (4002, reachable by direct URL) shows no chip
    // anywhere — absence, never an empty badge.
    await page.goto('/conversations/4002');
    await page.waitForLoadState('networkidle');
    await expect(page.locator('.card h1')).toContainText('E2E archived thread');
    await expect(page.locator('a.artifact-chip')).toHaveCount(0);
  });

  // @plan:hub-conversation-detail-artifact-chips-2026-08-17 @promote
  test('TP-convchip-005 the page-born thread header wears its chip and it deep-links the plan page', async ({ page }) => {
    await page.goto('/conversations/conv-8100');
    await page.waitForLoadState('networkidle');
    const chip = page.locator('.card h1 a.artifact-chip');
    await expect(chip).toHaveText('→ plan');
    await expect(chip).toHaveAttribute('href', '/plans/e2e-active-plan');
    // The chip navigates to the DOCUMENT the conversation generated.
    await chip.click();
    await page.waitForLoadState('networkidle');
    await expect(page).toHaveURL(/\/plans\/e2e-active-plan$/);
    await expect(page.locator('.card h1').first()).toContainText('E2E active plan');
  });

  // @plan:hub-conversation-detail-artifact-chips-2026-08-17 @promote
  test('TP-convchip-006 a pre-piece-1 log API renders both detail headers chip-less — pages intact, no JS errors', async ({ page, request }) => {
    const pageErrors = [];
    page.on('pageerror', (e) => pageErrors.push(String(e)));
    await request.post(`${STUB_URL}/__legacy-thread`);

    await page.goto('/conversations/conv-8100');
    await page.waitForLoadState('networkidle');
    await expect(page.locator('.card h1')).toContainText('Wire the beach house alarm');
    await expect(page.locator('a.artifact-chip')).toHaveCount(0);

    await page.goto('/conversations/4001');
    await page.waitForLoadState('networkidle');
    await expect(page.locator('.card h1')).toContainText('E2E active thread');
    await expect(page.locator('a.artifact-chip')).toHaveCount(0);
    expect(pageErrors).toEqual([]);
  });
});
