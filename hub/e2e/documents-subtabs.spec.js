'use strict';

/**
 * The Documents grouping tab (hn-documents-subtabs-2026-08-15, the CEO's spec:
 * "inside Documents, these will be the tabs: Plans, Tests, Records,
 * Conversations") in a real browser. Display-layer grouping only — the plan
 * kinds/statuses and the workspace /plan API are untouched. The subtab strip
 * is the SAME nav.subtabs component the Claude section uses (TP-navr-005/006);
 * spillover updates live in navigation.spec.js (TP-navr-007), plans.spec.js
 * (TP-nexus-e2e-010/011/012/090/091) and conversation-threads.spec.js
 * (TP-nexus-e2e-069..072/077). Test plan: hn-documents-subtabs-2026-08-15
 * (central DB).
 */

const { test, expect } = require('@playwright/test');

test.describe('Documents subtabs: Plans / Tests / Records / Conversations', () => {
  // @plan:hn-documents-subtabs-2026-08-15 @promote
  test('TP-docsub-001 /plans is the Documents landing: the four subtabs render, Plans active, Documents lit', async ({ page }) => {
    await page.goto('/plans');
    await page.waitForLoadState('networkidle');
    const active = page.locator('nav.sections a.active');
    await expect(active).toHaveCount(1);
    await expect(active).toHaveText('Documents');
    await expect(page.locator('nav.subtabs a')).toHaveText(['Plans', 'Tests', 'Records', 'Conversations']);
    await expect(page.locator('nav.subtabs a.active')).toHaveText('Plans');
    // The Documents top tab itself lands here (default subtab = Plans).
    await page.goto('/digests');
    await page.waitForLoadState('networkidle');
    await page.locator('nav.sections a', { hasText: 'Documents' }).click();
    await page.waitForLoadState('networkidle');
    await expect(page).toHaveURL(/\/plans$/);
    await expect(page.locator('nav.subtabs a.active')).toHaveText('Plans');
  });

  // @plan:hn-documents-subtabs-2026-08-15 @promote
  test('TP-docsub-002 subtab selection follows the URL; Documents stays lit across all four', async ({ page }) => {
    await page.goto('/plans');
    await page.waitForLoadState('networkidle');
    for (const [label, url] of [
      ['Tests', /\/tests$/],
      ['Records', /\/records$/],
      ['Conversations', /\/conversations$/],
      ['Plans', /\/plans$/],
    ]) {
      await page.locator('nav.subtabs a', { hasText: label }).click();
      await page.waitForLoadState('networkidle');
      await expect(page).toHaveURL(url);
      await expect(page.locator('nav.subtabs a.active')).toHaveText(label);
      await expect(page.locator('nav.sections a.active')).toHaveText('Documents');
    }
  });

  // @plan:hn-documents-subtabs-2026-08-15 @promote
  // Amended by hub-home-restructure-2026-08-29: /digests lives under the Home
  // grouping section now, so it carries the Home strip — one component, three
  // rosters; the no-strip surface is the 404 page (TP-navr-007).
  test('TP-docsub-003 the strip stays scoped: Home bar on /digests, Documents bar on /tests, the Claude bar unchanged', async ({ page }) => {
    await page.goto('/digests');
    await page.waitForLoadState('networkidle');
    await expect(page.locator('nav.subtabs a')).toHaveText(['Digests', 'Guide']);
    await page.goto('/tests');
    await page.waitForLoadState('networkidle');
    await expect(page.locator('nav.subtabs a')).toHaveText(['Plans', 'Tests', 'Records', 'Conversations']);
    // The Claude section keeps its own strip — one component, two rosters.
    await page.goto('/knowledge');
    await page.waitForLoadState('networkidle');
    await expect(page.locator('nav.subtabs a')).toHaveText(['Core', 'Agents', 'Skills', 'Features']);
  });

  // @plan:hn-documents-subtabs-2026-08-15 @promote
  test('TP-docsub-004 Documents lights on every subtab route and on detail pages; the homepage lights Home', async ({ page }) => {
    for (const path of ['/tests', '/records', '/conversations', '/conversations/4001', '/plans/e2e-active-plan']) {
      await page.goto(path);
      await page.waitForLoadState('networkidle');
      const active = page.locator('nav.sections a.active');
      await expect(active, `active tab on ${path}`).toHaveCount(1);
      await expect(active).toHaveText('Documents');
    }
    // Amended by hub-home-restructure-2026-08-29: `/` is the Home tab's own
    // route now — Documents stays unlit there, Home takes it.
    await page.goto('/');
    await page.waitForLoadState('networkidle');
    await expect(page.locator('nav.sections a.active')).toHaveText('Home');
  });

  // @plan:hn-documents-subtabs-2026-08-15 @promote
  test('TP-docsub-005 a /plans/:slug detail lights the subtab owning its KIND (path alone cannot know)', async ({ page }) => {
    await page.goto('/plans/e2e-nexus-test-plan');
    await page.waitForLoadState('networkidle');
    await expect(page.locator('nav.subtabs a.active')).toHaveText('Tests');
    await page.goto('/plans/e2e-active-plan');
    await page.waitForLoadState('networkidle');
    await expect(page.locator('nav.subtabs a.active')).toHaveText('Plans');
    await page.goto('/plans/e2e-archived-audit');
    await page.waitForLoadState('networkidle');
    await expect(page.locator('nav.subtabs a.active')).toHaveText('Records');
  });

  // @plan:hn-documents-subtabs-2026-08-15 @promote
  test('TP-docsub-007 archived plans stay behind the status chips — hidden by default, reachable on demand', async ({ page }) => {
    await page.goto('/plans');
    await page.waitForLoadState('networkidle');
    await expect(page.locator('ul.conv-index')).not.toContainText('E2E retired plan');
    await page.locator('p.filters a', { hasText: /^archived$/ }).click();
    await page.waitForLoadState('networkidle');
    await expect(page).toHaveURL(/status=archived/);
    // No archived kind=plan fixture exists: the quiet empty state, never a crash.
    await expect(page.locator('.card p.empty')).toContainText('No archived plans');
  });

  // @plan:hn-documents-subtabs-2026-08-15 @promote
  test('TP-docsub-008 the Tests subtab lists open test-plans with the held one first, wearing the needs-CEO marker', async ({ page }) => {
    await page.goto('/tests');
    await page.waitForLoadState('networkidle');
    const rows = page.locator('ul.conv-index li');
    await expect(rows).toHaveCount(2);
    // Held-first despite being the OLDER row — a pinned CEO block outranks recency.
    await expect(rows.nth(0)).toContainText('E2E held test plan');
    await expect(rows.nth(0).locator('.needs-ceo')).toHaveText('needs the CEO');
    await expect(rows.nth(1)).toContainText('E2E hub test plan');
    await expect(rows.nth(1).locator('.needs-ceo')).toHaveCount(0);
    // Closed test-plans and other kinds never leak into the open list.
    await expect(page.locator('ul.conv-index')).not.toContainText('E2E closed test plan');
    await expect(page.locator('ul.conv-index')).not.toContainText('E2E active plan');
  });

  // @plan:hn-documents-subtabs-2026-08-15 @promote
  test('TP-docsub-009 closed test-plans sit behind the toggle: hidden by default, revealed with status badges', async ({ page }) => {
    await page.goto('/tests');
    await page.waitForLoadState('networkidle');
    await expect(page.locator('body')).not.toContainText('E2E closed test plan');
    await page.locator('p.filters a', { hasText: /^Show closed \(1\)$/ }).click();
    await page.waitForLoadState('networkidle');
    await expect(page).toHaveURL(/closed=1/);
    const closedCard = page.locator('.card', { has: page.locator('h1', { hasText: /^Closed$/ }) });
    const row = closedCard.locator('ul.conv-index li', { hasText: 'E2E closed test plan' });
    await expect(row.locator('.status-badge')).toHaveText('done');
    await expect(row.locator('.kind-badge.kd-test-plan')).toHaveText('test-plan');
    // And back: the toggle collapses the history again.
    await page.locator('p.filters a', { hasText: /^Hide closed \(1\)$/ }).click();
    await page.waitForLoadState('networkidle');
    await expect(page.locator('body')).not.toContainText('E2E closed test plan');
  });

  // @plan:hn-documents-subtabs-2026-08-15 @promote
  test('TP-docsub-011 the Records subtab merges the record kinds in one badge-carrying list, done visible', async ({ page }) => {
    await page.goto('/records');
    await page.waitForLoadState('networkidle');
    const rows = page.locator('ul.conv-index li');
    await expect(rows).toHaveCount(2);
    // Newest activity first: the baseline (01-05) over the done design (01-01).
    await expect(rows.nth(0)).toContainText('E2E workspace baseline');
    await expect(rows.nth(0).locator('.kind-badge.kd-baseline')).toHaveText('baseline');
    // A done record is still a reference — visible by default.
    await expect(rows.nth(1)).toContainText('E2E done plan');
    await expect(rows.nth(1).locator('.kind-badge.kd-design')).toHaveText('design');
    await expect(rows.nth(1).locator('.status-badge')).toHaveText('done');
    // Plans and test-plans never appear here; archived stays behind the toggle.
    await expect(page.locator('ul.conv-index')).not.toContainText('E2E active plan');
    await expect(page.locator('ul.conv-index')).not.toContainText('test plan');
    await expect(page.locator('ul.conv-index')).not.toContainText('E2E archived audit');
  });

  // @plan:hn-documents-subtabs-2026-08-15 @promote
  test('TP-docsub-012 a kind chip narrows Records to one kind in one click', async ({ page }) => {
    await page.goto('/records');
    await page.locator('p.filters a', { hasText: /^design$/ }).click();
    await page.waitForLoadState('networkidle');
    await expect(page).toHaveURL(/kind=design/);
    const rows = page.locator('ul.conv-index li');
    await expect(rows).toHaveCount(1);
    await expect(rows.first()).toContainText('E2E done plan');
  });

  // @plan:hn-documents-subtabs-2026-08-15 @promote
  test('TP-docsub-015 /conversations renders the listing directly — no redirect bounce, compose box below', async ({ page }) => {
    await page.goto('/conversations');
    await page.waitForLoadState('networkidle');
    // A real page now (the N2-era redirect is reversed — TP-nexus-e2e-072).
    await expect(page).toHaveURL(/\/conversations$/);
    await expect(page.locator('ul.conv-index')).toContainText('Wire the beach house alarm');
    await expect(page.locator('ul.conv-index')).toContainText('E2E active thread');
    await expect(page.locator('#comment-box h2')).toHaveText('Start a conversation');
  });

  // @plan:hn-documents-subtabs-2026-08-15 @promote
  test('TP-docsub-016 archived conversations sit behind the toggle with their badge; default stays clean', async ({ page }) => {
    await page.goto('/conversations');
    await page.waitForLoadState('networkidle');
    await expect(page.locator('ul.conv-index')).not.toContainText('E2E archived thread');
    await page.locator('p.filters a', { hasText: /^Show archived$/ }).click();
    await page.waitForLoadState('networkidle');
    await expect(page).toHaveURL(/archived=1/);
    const row = page.locator('ul.conv-index li', { hasText: 'E2E archived thread' });
    await expect(row.locator('.status-badge')).toHaveText('archived');
    // Page-born threads (never archivable) still list normally.
    await expect(page.locator('ul.conv-index')).toContainText('Wire the beach house alarm');
    await page.locator('p.filters a', { hasText: /^Hide archived$/ }).click();
    await page.waitForLoadState('networkidle');
    await expect(page.locator('ul.conv-index')).not.toContainText('E2E archived thread');
  });

  // @plan:hn-documents-subtabs-2026-08-15 @promote
  test('TP-docsub-017 legacy /plans?kind= URLs land on their owning subtab, axes carried', async ({ page }) => {
    // Old bookmarks/digest-email links from the all-kinds /plans era.
    await page.goto('/plans?kind=test-plan&repo=hub');
    await page.waitForURL(/\/tests\?repo=hub$/);
    await expect(page.locator('ul.conv-index li')).toHaveCount(1);
    await page.goto('/plans?kind=audit&status=archived');
    await page.waitForURL(/\/records\?kind=audit&archived=1$/);
    await expect(page.locator('ul.conv-index')).toContainText('E2E archived audit');
    await page.goto('/plans?kind=plan&status=done');
    await page.waitForURL(/\/plans\?status=done$/);
    await expect(page.locator('ul.conv-index')).toContainText('E2E retired plan');
  });
});
