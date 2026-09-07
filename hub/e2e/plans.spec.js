'use strict';

/**
 * Plans section in a real browser (list, filters, detail render). Since
 * hn-documents-subtabs-2026-08-15, /plans is the PLANS SUBTAB of the Documents
 * section — kind=plan only; test-plans live on /tests, the other kinds on
 * /records, conversations on /conversations (e2e/documents-subtabs.spec.js).
 * Test plans: hn-test-plan-2026-07-26-playwright-e2e,
 * hn-documents-subtabs-2026-08-15 (central DB).
 */

const { test, expect } = require('@playwright/test');

test.describe('plans', () => {
  // Updated by hn-documents-subtabs-2026-08-15 (TP-docsub-006): /plans is the
  // Plans subtab now — open kind=plan rows only; other kinds live on their own
  // subtabs and done/archived stay behind the status chips.
  test('TP-nexus-e2e-010 the default list shows only open kind=plan rows', async ({ page }) => {
    await page.goto('/plans');
    await page.waitForLoadState('networkidle');
    const rows = page.locator('ul.conv-index li');
    await expect(rows).toHaveCount(1);
    await expect(page.locator('ul.conv-index')).toContainText('E2E active plan');
    await expect(page.locator('ul.conv-index')).not.toContainText('E2E retired plan');
    await expect(page.locator('ul.conv-index')).not.toContainText('E2E hub test plan');
    await expect(page.locator('ul.conv-index')).not.toContainText('E2E done plan');
  });

  test('TP-nexus-e2e-011 the status filter reaches done plans', async ({ page }) => {
    await page.goto('/plans');
    await page.locator('p.filters a', { hasText: /^done$/ }).click();
    await page.waitForLoadState('networkidle');
    await expect(page).toHaveURL(/status=done/);
    await expect(page.locator('ul.conv-index')).toContainText('E2E retired plan');
  });

  // Updated by hn-documents-subtabs-2026-08-15: the kind axis became the
  // subtabs; the repo axis survives per subtab — here on Tests.
  test('TP-nexus-e2e-012 the repo filter composes in the query string on the Tests subtab', async ({ page }) => {
    await page.goto('/tests');
    await page.locator('p.filters a', { hasText: /^hub$/ }).click();
    await page.waitForLoadState('networkidle');
    await expect(page).toHaveURL(/repo=hub/);
    const rows = page.locator('ul.conv-index li');
    await expect(rows).toHaveCount(1);
    await expect(rows.first()).toContainText('E2E hub test plan');
  });

  test('TP-nexus-e2e-013 a plan detail page renders its markdown body', async ({ page }) => {
    await page.goto('/plans');
    await page.locator('ul.conv-index a', { hasText: 'E2E active plan' }).click();
    await page.waitForLoadState('networkidle');
    await expect(page).toHaveURL(/\/plans\/e2e-active-plan$/);
    await expect(page.locator('.card h1').first()).toContainText('E2E active plan');
    await expect(page.locator('.card strong').first()).toHaveText('bold');
  });

  test('TP-nexus-e2e-014 an unknown plan slug renders the 404 state', async ({ page }) => {
    const apiResponse = page.waitForResponse((r) => r.url().includes('/api/plans/no-such-plan'));
    await page.goto('/plans/no-such-plan');
    expect((await apiResponse).status()).toBe(404);
    await expect(page.locator('body')).toContainText(/not found/i);
  });

  // @plan:test-plan-history-kind-removal @promote
  // Updated by hn-documents-subtabs-2026-08-15: the kind chips live on the
  // Records subtab now and offer only the RECORD kinds present — never a
  // history chip, never plan/test-plan (those are subtabs).
  test('TP-nexus-e2e-090 the Records kind chips offer the record kinds present, no history chip', async ({ page }) => {
    await page.goto('/records');
    await page.waitForLoadState('networkidle');
    // The kind row is the one whose "All" link reads "All kinds".
    const kindRow = page.locator('p.filters', { has: page.locator('a', { hasText: /^All kinds$/ }) });
    await expect(kindRow.locator('a')).toHaveText(['All kinds', 'design', 'baseline']);
    // With archived revealed, the archived audit's kind joins the roster.
    await page.goto('/records?archived=1');
    await page.waitForLoadState('networkidle');
    await expect(kindRow.locator('a')).toHaveText(['All kinds', 'design', 'audit', 'baseline']);
  });

  // @plan:test-plan-history-kind-removal @promote
  // Updated by hn-documents-subtabs-2026-08-15: archived records surface via
  // the Records archived toggle (TP-docsub-013) — the guarantee is unchanged.
  test('TP-nexus-e2e-091 the archived toggle lists items under their real kinds', async ({ page }) => {
    await page.goto('/records');
    await page.locator('p.filters a', { hasText: /^Show archived$/ }).click();
    await page.waitForLoadState('networkidle');
    await expect(page).toHaveURL(/archived=1/);
    const row = page.locator('ul.conv-index li', { hasText: 'E2E archived audit' });
    // The whole point of retiring `history`: the original kind stays visible.
    await expect(row.locator('.kind-badge.kd-audit')).toHaveText('audit');
    await expect(row.locator('.status-badge')).toHaveText('archived');
  });

  // @plan:test-plan-two-line-index-rows
  test('TP-nexus-e2e-075 an index row is two lines: meta below the title, date first then key', async ({ page }) => {
    await page.goto('/plans');
    await page.waitForLoadState('networkidle');
    const row = page.locator('ul.conv-index li', { hasText: 'E2E active plan' });
    // Line 2 reads date · key (the old order was key · date).
    await expect(row.locator('.meta-facts')).toHaveText(/^\d{4}-\d{2}-\d{2} · e2e-active-plan$/);
    // Two lines, always: the meta block starts below the title block.
    const title = await row.locator('.conv-title').boundingBox();
    const meta = await row.locator('.conv-meta').boundingBox();
    expect(meta.y).toBeGreaterThanOrEqual(title.y + title.height - 1);
  });

  // @plan:test-plan-two-line-index-rows
  test('TP-nexus-e2e-076 the comment count sits at the right edge and only when nonzero', async ({ page }) => {
    await page.goto('/plans');
    await page.waitForLoadState('networkidle');
    const row = page.locator('ul.conv-index li', { hasText: 'E2E active plan' });
    const count = row.locator('.thread-count');
    await expect(count).toHaveText('2 comments');
    // Pushed all the way to the right: the count's right edge tracks the link's.
    const link = await row.locator('a').boundingBox();
    const box = await count.boundingBox();
    expect(box.x + box.width).toBeGreaterThan(link.x + link.width - 24);
    // Zero stays silent, in the new position too (regression of the convention).
    await page.locator('p.filters a', { hasText: /^done$/ }).click();
    await page.waitForLoadState('networkidle');
    const doneRow = page.locator('ul.conv-index li', { hasText: 'E2E retired plan' });
    await expect(doneRow.locator('.meta-facts')).toHaveText(/^\d{4}-\d{2}-\d{2} · e2e-retired-plan$/);
    await expect(doneRow.locator('.thread-count')).toHaveCount(0);
  });
});
