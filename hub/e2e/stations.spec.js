'use strict';

/**
 * The station drill-down after the merge (Part C — design: central-DB plan
 * features-ui-restructure-design, C-1; test plan
 * hub-features-stations-merge-2026-08-27). The Stations PAGE is retired:
 * `/stations` redirects to the Features matrix and `/stations/:env` is the
 * per-station machine detail reached from a matrix column header. Fixtures:
 * station-green (all OK, age 4m), station-red (failing + stale, age 120m),
 * station-legacy (OLD-format bare `cp-env` FAIL), station-silent (never
 * reported), station-rogue (reporting but NOT in configs) —
 * e2e/fixtures/stub-log-api.js. Supersedes TP-stations-e2e-001..006 and
 * TP-hubfeat-e2e-027..030 (the per-station feature panel retired with the
 * page — the matrix column owns that fact now).
 */

const { test, expect } = require('@playwright/test');

test.describe('station detail + redirect', () => {
  // @plan:hub-features-stations-merge-2026-08-27 @promote
  test('TP-fsm-e2e-020 /stations redirects to the merged surface, preserving stale_minutes', async ({ page }) => {
    await page.goto('/stations');
    await page.waitForLoadState('networkidle');
    await expect(page).toHaveURL(/\/features$/);
    await expect(page.locator('.card h1')).toContainText('Features');
    await expect(page.locator('nav.subtabs a.active')).toHaveText('Features');
    await page.goto('/stations?stale_minutes=1');
    await page.waitForLoadState('networkidle');
    await expect(page).toHaveURL(/\/features\?stale_minutes=1$/);
    await expect(page.locator('.card').first()).toContainText('no report in 1 min');
  });

  // @plan:hub-features-stations-merge-2026-08-27 @promote
  test('TP-fsm-e2e-021 clicking a station header opens its detail: full check table, no interaction needed', async ({ page }) => {
    await page.goto('/features');
    await page.waitForLoadState('networkidle');
    await page.locator('th.fm-station a', { hasText: 'station-green' }).first().click();
    await page.waitForLoadState('networkidle');
    await expect(page).toHaveURL(/\/stations\/station-green$/);
    await expect(page.locator('.card h1')).toHaveText('station-green');
    // The subtab stays lit: the detail lives under the merged surface.
    await expect(page.locator('nav.subtabs a.active')).toHaveText('Features');
    const card = page.locator('.card.station');
    await expect(card.locator('.station-badge.sn-ok')).toHaveText('ok');
    await expect(card.locator('.ledger-meta')).toContainText('4m ago');
    await expect(card.locator('.ledger-meta')).toContainText('ip 203.0.113.7');
    await expect(card.locator('.ledger-meta')).toContainText('win32');
    await expect(card.locator('.station-allclear')).toContainText('14 checks ok');
    // The FULL check table is the page's point: visible without a disclosure
    // click (the old <details> fold retired with the Stations page).
    const table = card.locator('.station-checks table');
    await expect(table).toBeVisible();
    await expect(table).toContainText('scopes: gist, read:org, repo, workflow');
    await expect(table).toContainText('2.96.0');
  });

  // @plan:hub-features-stations-merge-2026-08-27 @promote
  test('TP-fsm-e2e-022 a failing + stale station reads loud: badges, alert rail, headline FAIL/WARN rows', async ({ page }) => {
    await page.goto('/stations/station-red');
    await page.waitForLoadState('networkidle');
    const card = page.locator('.card.station');
    await expect(card).toHaveClass(/rail-alert/);
    await expect(card.locator('.station-badge.sn-failing')).toHaveText('failing');
    await expect(card.locator('.station-badge.sn-stale')).toHaveText('stale');
    // Four FAILs: harness, pull-task, and the two cp-env rows.
    await expect(card.locator('ul.check-list li.check-fail')).toHaveCount(4);
    await expect(card.locator('ul.check-list')).toContainText("'fallbackModel' not set");
    await expect(card.locator('ul.check-list')).toContainText('Claude-WorkspacePull not registered');
    await expect(card.locator('ul.check-list')).toContainText('GMAIL_APP_PASSWORD');
    await expect(card.locator('ul.check-list li.check-warn')).toContainText('lockfile drift');
  });

  // @plan:hub-features-stations-merge-2026-08-27 @promote
  test('TP-fsm-e2e-023 regression: an OLD-format bare cp-env FAIL stays a visible failure on the detail', async ({ page }) => {
    await page.goto('/stations/station-legacy');
    await page.waitForLoadState('networkidle');
    const card = page.locator('.card.station');
    await expect(card.locator('.station-badge.sn-failing')).toHaveText('failing');
    const fail = card.locator('ul.check-list li.check-fail', { hasText: 'cp-env' });
    await expect(fail).toBeVisible();
    await expect(fail).toContainText('missing 2 of 14 required vars');
  });

  // @plan:hub-features-stations-merge-2026-08-27 @promote
  test('TP-fsm-e2e-024 never-reported detail is a quiet normal state; an unknown env is a clean not-found', async ({ page }) => {
    await page.goto('/stations/station-silent');
    await page.waitForLoadState('networkidle');
    const card = page.locator('.card.station');
    await expect(card).toHaveClass(/station-never/);
    await expect(card).not.toHaveClass(/rail-alert/);
    await expect(card.locator('.station-badge.sn-never')).toHaveText('never reported');
    await expect(card).toContainText('normal for a new box or a fresh registry');
    await page.goto('/stations/no-such-station');
    await page.waitForLoadState('networkidle');
    await expect(page.locator('.card h1')).toContainText('Not found');
    await expect(page.locator('.card')).toContainText('no report on record');
  });

  // @plan:hub-features-stations-merge-2026-08-27 @promote
  test('TP-fsm-e2e-025 a reporter outside configs keeps its visible badge on the detail', async ({ page }) => {
    await page.goto('/stations/station-rogue');
    await page.waitForLoadState('networkidle');
    const card = page.locator('.card.station');
    await expect(card.locator('.station-badge.sn-ok')).toHaveText('ok');
    await expect(card).toContainText('not in configs');
  });

  // @plan:check-explainers-hub-2026-08-27 @promote
  test('TP-checkexp-e2e-005 a check row renders its explain as plain-language secondary text in the table', async ({ page }) => {
    await page.goto('/stations/station-green');
    await page.waitForLoadState('networkidle');
    const table = page.locator('.card.station .station-checks table');
    const nodeRow = table.locator('tr', { hasText: 'v24.18.0' });
    await expect(nodeRow.locator('.check-explain')).toContainText('Verifies the Node.js runtime installed here');
    // A row the feed did not explain (tool:gh) renders no secondary element.
    const ghRow = table.locator('tr', { hasText: '2.96.0' });
    await expect(ghRow.locator('.check-explain')).toHaveCount(0);
  });

  // @plan:check-explainers-hub-2026-08-27 @promote
  test('TP-checkexp-e2e-006 a FAIL headline row carries its explain sentence — the strip shares the idiom', async ({ page }) => {
    await page.goto('/stations/station-red');
    await page.waitForLoadState('networkidle');
    const fail = page.locator('.card.station ul.check-list li.check-fail', { hasText: 'Claude-WorkspacePull not registered' });
    await expect(fail.locator('.check-explain')).toContainText('If it is missing or disabled, syncing and queued log delivery stop');
  });

  // @plan:check-explainers-hub-2026-08-27 @promote
  test('TP-checkexp-e2e-007 an older cached report without explain renders exactly as today — zero explain nodes', async ({ page }) => {
    await page.goto('/stations/station-legacy');
    await page.waitForLoadState('networkidle');
    const card = page.locator('.card.station');
    await expect(card.locator('.station-checks table')).toBeVisible();
    await expect(card.locator('.check-explain')).toHaveCount(0);
    await expect(card.locator('ul.check-list li.check-fail', { hasText: 'cp-env' })).toBeVisible();
  });

  // @plan:hub-features-stations-merge-2026-08-27 @promote
  test('TP-fsm-e2e-026 ?stale_minutes= forwards to the detail read', async ({ page }) => {
    await page.goto('/stations/station-green?stale_minutes=1');
    await page.waitForLoadState('networkidle');
    await expect(page.locator('.card').first()).toContainText('no report in 1 min');
    await expect(page.locator('.card.station .station-badge.sn-stale')).toHaveText('stale');
  });
});
