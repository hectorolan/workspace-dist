'use strict';

/**
 * Shell + digest index + homepage in a real browser.
 * Test plans: hn-test-plan-2026-07-26-playwright-e2e, test-plan-digest-index +
 * test-plan-home-latest-digest (central DB). The digest index page (backlog
 * item 70) retired the jump-to-latest landing redirect (TP-nexus-e2e-001 → 078)
 * and the detail-page date dropdown (TP-nexus-e2e-003 → 080): the index IS the
 * date navigation. The homepage split (CEO call): `/` renders the LATEST digest
 * in full (the morning read, brand click), `/digests` is the index (the nav
 * item) — TP-nexus-e2e-082..085.
 */

const { test, expect } = require('@playwright/test');

test.describe('shell and digest index', () => {
  // @plan:test-plan-digest-index
  // Amended by test-plan-home-latest-digest: the index's sole home is /digests
  // now that `/` renders the latest digest.
  test('TP-nexus-e2e-078 /digests renders the digest index: two-line rows newest first, subject titles with fallback', async ({ page }) => {
    await page.goto('/digests');
    await page.waitForLoadState('networkidle');
    const rows = page.locator('ul.conv-index.two-line li');
    await expect(rows).toHaveCount(3);
    // Newest first; the newest row's title is the composed stored subject
    // (item-72 readiness: a report title lights up with zero UI work).
    await expect(rows.nth(0).locator('.conv-title')).toHaveText('Quiet markets, loud agents');
    await expect(rows.nth(1).locator('.conv-title')).toHaveText('Daily Digest — 2026-01-02');
    // A subject-less history row falls back to the date name.
    await expect(rows.nth(2).locator('.conv-title')).toHaveText('Daily Digest — 2026-01-01');
    // Line 2: date first, then the row's key (digests/<date>).
    await expect(rows.nth(0).locator('.meta-facts')).toHaveText('2026-01-03 · digests/2026-01-03');
    // Two lines, always: the meta block starts below the title block.
    const title = await rows.nth(0).locator('.conv-title').boundingBox();
    const meta = await rows.nth(0).locator('.conv-meta').boundingBox();
    expect(meta.y).toBeGreaterThanOrEqual(title.y + title.height - 1);
  });

  // @plan:test-plan-digest-index
  test('TP-nexus-e2e-079 the comment count sits at the right edge and only on rows with thread entries', async ({ page }) => {
    await page.goto('/digests');
    await page.waitForLoadState('networkidle');
    const row = page.locator('ul.conv-index li', { hasText: 'Daily Digest — 2026-01-02' });
    const count = row.locator('.thread-count');
    await expect(count).toHaveText('2 comments');
    // Pushed all the way to the right: the count's right edge tracks the link's.
    const link = await row.locator('a').boundingBox();
    const box = await count.boundingBox();
    expect(box.x + box.width).toBeGreaterThan(link.x + link.width - 24);
    // Zero stays silent: the commented date is the only row with a count.
    await expect(page.locator('ul.conv-index .thread-count')).toHaveCount(1);
  });

  // @plan:test-plan-digest-index
  test('TP-nexus-e2e-080 a row click opens the digest detail — body + thread, no dropdown — and the pager returns to the index', async ({ page }) => {
    await page.goto('/digests');
    await page.waitForLoadState('networkidle');
    await page.locator('ul.conv-index li a', { hasText: 'Daily Digest — 2026-01-02' }).click();
    await page.waitForURL('**/digests/2026-01-02');
    await expect(page.locator('.card h1')).toContainText('Daily Digest — 2026-01-02');
    // Markdown is rendered, not shown as source.
    await expect(page.locator('.card strong').first()).toHaveText('Something happened');
    await expect(page.locator('.card a[href="https://example.com/story"]')).toBeVisible();
    // The document thread still renders below the body — the page is otherwise unchanged.
    await expect(page.locator('#doc-thread article.thread-entry')).toHaveCount(2);
    // The date dropdown retired with the index page.
    await expect(page.locator('form.digest-picker')).toHaveCount(0);
    await page.locator('.pager a', { hasText: 'All digests' }).click();
    await page.waitForURL('**/digests');
    await expect(page.locator('ul.conv-index.two-line li')).toHaveCount(3);
  });

  // @plan:test-plan-digest-index
  test('TP-nexus-e2e-081 deep links survive the index: direct /digests/<date> and legacy ?date= both land on the digest', async ({ page }) => {
    // Emails carry /digests/<date> — it must render directly, no index hop.
    await page.goto('/digests/2026-01-02');
    await page.waitForLoadState('networkidle');
    await expect(page.locator('.card h1')).toContainText('Daily Digest — 2026-01-02');
    // The legacy query-string form still redirects to the path form.
    await page.goto('/digests?date=2026-01-01');
    await page.waitForURL('**/digests/2026-01-01');
    await expect(page.locator('.card h1')).toContainText('Daily Digest — 2026-01-01');
  });

  // Updated by hn-nav-restructure-2026-08-15 (TP-navr-010), then by
  // hub-home-restructure-2026-08-29: the top nav is Home (the Digests tab
  // renamed, landing on `/`), Documents, Claude.
  test('TP-nexus-e2e-002 every nav section is reachable from the shell', async ({ page }) => {
    await page.goto('/plans');
    await page.waitForLoadState('networkidle');
    const sections = [
      ['Home', /\/$/],
      ['Documents', /\/plans$/],
      ['Claude', /\/knowledge$/],
    ];
    for (const [label, url] of sections) {
      await page.locator('nav.sections a', { hasText: label }).first().click();
      await page.waitForLoadState('networkidle');
      await expect(page).toHaveURL(url);
    }
  });

  test('TP-nexus-e2e-004 an unknown digest date renders the 404 state, not a stack trace', async ({ page }) => {
    const apiResponse = page.waitForResponse((r) => r.url().includes('/api/digests/2026-12-31'));
    await page.goto('/digests/2026-12-31');
    expect((await apiResponse).status()).toBe(404);
    await expect(page.locator('body')).toContainText('Digest not found');
  });
});

test.describe('homepage: the latest digest', () => {
  // @plan:test-plan-home-latest-digest @promote
  test('TP-nexus-e2e-082 the homepage renders the newest digest in full — body and its document thread below', async ({ page }) => {
    // The thread must anchor to the same digests/<date> slug the detail page
    // uses — `/` is DigestPage for the latest date, not a separate rendering.
    const threadFetch = page.waitForResponse((r) => r.url().includes('/api/threads/digests/2026-01-03'));
    await page.goto('/');
    await page.waitForLoadState('networkidle');
    // The newest digest's rendered body — not the index.
    await expect(page.locator('.card h1').first()).toContainText('Daily Digest — 2026-01-03');
    await expect(page.locator('.card strong').first()).toHaveText('Something happened');
    await expect(page.locator('ul.conv-index')).toHaveCount(0);
    // Its thread section, in thread mode (the newest fixture digest has an
    // empty thread on purpose; entry rendering is TP-nexus-e2e-080's job).
    expect((await threadFetch).status()).toBe(200);
    await expect(page.locator('#doc-thread')).toBeVisible();
    await expect(page.locator('#doc-thread #comment-box h2')).toHaveText('Add to this thread');
    // The pager still leads to the full history.
    await expect(page.locator('.pager a', { hasText: 'All digests' })).toBeVisible();
  });

  // @plan:test-plan-home-latest-digest @promote
  // Amended by hn-nav-restructure-2026-08-15 (TP-navr-011), then by
  // hub-home-restructure-2026-08-29 (the CEO's Home design): the Digests tab
  // became HOME and `/` is its own route — brand and Home tab land on the same
  // place with Home lit; the full history stays one hop away at /digests.
  test('TP-nexus-e2e-083 brand and the Home tab land on the latest digest with Home lit; All digests leads to the index', async ({ page }) => {
    await page.goto('/plans');
    await page.waitForLoadState('networkidle');
    await page.locator('nav.sections a', { hasText: 'Home' }).click();
    await page.waitForLoadState('networkidle');
    await expect(page).toHaveURL(/\/$/);
    await expect(page.locator('.card h1').first()).toContainText('Daily Digest — 2026-01-03');
    await expect(page.locator('nav.sections a', { hasText: 'Home' })).toHaveClass(/active/);
    // The history surface is one hop away, still under Home.
    await page.locator('.pager a', { hasText: 'All digests' }).click();
    await page.waitForURL('**/digests');
    await expect(page.locator('ul.conv-index.two-line li')).toHaveCount(3);
    await expect(page.locator('nav.sections a', { hasText: 'Home' })).toHaveClass(/active/);
    // The brand goes to the same landing surface.
    await page.locator('.brand a').click();
    await page.waitForLoadState('networkidle');
    await expect(page).toHaveURL(/\/$/);
    await expect(page.locator('nav.sections a.active')).toHaveText('Home');
  });

  // @plan:test-plan-home-latest-digest @promote
  test('TP-nexus-e2e-084 no digests at all: the homepage shows the quiet empty line, never a crash', async ({ page }) => {
    // The stub always serves three digests (and PR #34 owns its file), so the
    // empty DB is simulated at the browser edge: /api/digests answers empty.
    await page.route('**/api/digests', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, digests: [] }) })
    );
    await page.goto('/');
    await page.waitForLoadState('networkidle');
    await expect(page.locator('.card p.empty')).toContainText('no digests yet');
    await expect(page.locator('#doc-thread')).toHaveCount(0);
  });

  // @plan:test-plan-home-latest-digest @promote
  test('TP-nexus-e2e-085 a legacy /?date=X link still lands on that digest', async ({ page }) => {
    await page.goto('/?date=2026-01-01');
    await page.waitForURL('**/digests/2026-01-01');
    await expect(page.locator('.card h1').first()).toContainText('Daily Digest — 2026-01-01');
  });
});

// Section amended by hub-home-restructure-2026-08-29 (the CEO's Home design):
// the Digests tab became HOME, `/` is its own route (the tab lights there,
// superseding the 2026-08-15 no-tab-on-/ call), and Home is a grouping
// section (Digests / Guide subtabs). e2e/home.spec.js owns the new surface;
// these keep guarding the roster and the active-tab derivation.
test.describe('top nav restructure: Home / Documents / Claude', () => {
  // @plan:hub-pages-framework-core-2026-08-29 @promote
  // (Amended by pages phase 2: this suite runs with the fixture pages root,
  // so custom-page tabs legitimately follow the built-ins — the built-in
  // roster is the leading three; TP-pages-030 owns the full ordering.)
  test('TP-navr-001 the top nav leads with Home, Documents and Claude', async ({ page }) => {
    await page.goto('/digests');
    await page.waitForLoadState('networkidle');
    const tabs = page.locator('nav.sections a');
    await expect(tabs.nth(0)).toHaveText('Home');
    await expect(tabs.nth(1)).toHaveText('Documents');
    await expect(tabs.nth(2)).toHaveText('Claude');
    // The grouped/retired sections keep their routes but never a top-level entry.
    for (const gone of ['Digests', 'Plans', 'Agents', 'Skills', 'Stations', 'Conversations']) {
      await expect(page.locator('nav.sections a', { hasText: gone })).toHaveCount(0);
    }
  });

  // @plan:hn-nav-restructure-2026-08-15 @promote
  test('TP-navr-002 the homepage lights the Home tab (its own route since the Home restructure)', async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle');
    // The latest digest renders…
    await expect(page.locator('.card h1').first()).toContainText('Daily Digest — 2026-01-03');
    // …and `/` is the Home tab's own route: exactly one active tab.
    await expect(page.locator('nav.sections a.active')).toHaveText('Home');
  });

  // @plan:hn-nav-restructure-2026-08-15 @promote
  test('TP-navr-003 /digests and a digest detail light exactly the Home tab', async ({ page }) => {
    for (const path of ['/digests', '/digests/2026-01-02']) {
      await page.goto(path);
      await page.waitForLoadState('networkidle');
      const active = page.locator('nav.sections a.active');
      await expect(active).toHaveCount(1);
      await expect(active).toHaveText('Home');
    }
  });

  // @plan:hn-nav-restructure-2026-08-15 @promote
  test('TP-navr-004 /plans lights exactly the Documents tab and the plans index still renders', async ({ page }) => {
    await page.goto('/plans');
    await page.waitForLoadState('networkidle');
    const active = page.locator('nav.sections a.active');
    await expect(active).toHaveCount(1);
    await expect(active).toHaveText('Documents');
    // Label-only rename: the route and its content are untouched.
    await expect(page.locator('ul.conv-index')).toContainText('E2E active plan');
  });

  // @plan:hn-nav-restructure-2026-08-15 @promote
  // Updated by hn-documents-subtabs-2026-08-15 (TP-docsub-003), then by
  // hub-home-restructure-2026-08-29: every top tab is a grouping section now —
  // Home carries the Digests/Guide strip — so the bar's scope check moves to
  // the 404 page, the one surface outside every section.
  test('TP-navr-007 the subtab bar exists only inside the grouping sections', async ({ page }) => {
    await page.goto('/digests');
    await page.waitForLoadState('networkidle');
    await expect(page.locator('nav.subtabs a')).toHaveText(['Digests', 'Guide']);
    await page.goto('/no-such-section');
    await page.waitForLoadState('networkidle');
    await expect(page.locator('nav.subtabs')).toHaveCount(0);
    await page.goto('/plans');
    await page.waitForLoadState('networkidle');
    await expect(page.locator('nav.subtabs')).toHaveCount(1);
    await expect(page.locator('nav.subtabs a')).toHaveText(['Plans', 'Tests', 'Records', 'Conversations']);
  });

  // @plan:hn-nav-restructure-2026-08-15 @promote
  test('TP-navr-008 an unknown path renders the 404 card with zero active tabs', async ({ page }) => {
    await page.goto('/no-such-section');
    await page.waitForLoadState('networkidle');
    await expect(page.locator('.card h1')).toHaveText('Not found');
    await expect(page.locator('nav.sections a.active')).toHaveCount(0);
  });
});
