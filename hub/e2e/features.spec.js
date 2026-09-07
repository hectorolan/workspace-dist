'use strict';

/**
 * The Features matrix page in a real browser (Part B + C of the feature-registry
 * restructure — design: central-DB plan features-ui-restructure-design — plus
 * the CEO's live-review layout pass: central-DB test plan
 * hub-features-kind-tabs-2026-08-27). The stub's `GET /feature` aggregate
 * hardcodes one row per cell state the page must render distinctly, plus one
 * UNKNOWN kind (`probe`) proving the tab row derives from the data; see the
 * FEATURES fixture in e2e/fixtures/stub-log-api.js.
 *
 * Layout under test: kinds render as an in-page tab row (`nav.kind-tabs`,
 * `?kind=` deep link — the Records-subtab idiom for a data-derived axis), one
 * kind's rows visible at a time; scope is an inline tag right after the title
 * inside the name cell (the scope COLUMN is retired) and the description owns
 * the freed width. Station column headers wear the /station feed's verdicts and
 * link to the `/stations/:env` drill-down; rows carry their registry
 * description as the second line. Earlier plans on this surface:
 * hub-features-matrix-2026-08-27, hub-features-stations-merge-2026-08-27.
 */

const { test, expect } = require('@playwright/test');
const { failNextStations } = require('./helpers');

/** The matrix row carrying a given feature title (exact-match its <strong>). */
const rowFor = (page, title) =>
  page.locator('table.feature-matrix tr', { has: page.locator('td.fm-feature strong', { hasText: title }) });

/** Open the Features page on a given kind tab (the ?kind= deep link). */
async function gotoKind(page, kind) {
  await page.goto(`/features?kind=${encodeURIComponent(kind)}`);
  await page.waitForLoadState('networkidle');
}

test.describe('features', () => {
  // @plan:hub-features-kind-tabs-2026-08-27 @promote
  test('TP-hubfeat-e2e-020 Features is the fourth Claude subtab, reachable from the shell nav', async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle');
    await page.locator('nav.sections a', { hasText: 'Claude' }).click();
    await page.waitForLoadState('networkidle');
    await expect(page.locator('nav.subtabs a')).toHaveText(['Core', 'Agents', 'Skills', 'Features']);
    await page.locator('nav.subtabs a', { hasText: 'Features' }).click();
    await page.waitForLoadState('networkidle');
    await expect(page).toHaveURL(/\/features$/);
    await expect(page.locator('.card h1')).toContainText('Features');
    await expect(page.locator('nav.subtabs a.active')).toHaveText('Features');
  });

  // --- the kind tab row (hub-features-kind-tabs-2026-08-27) ---

  // @plan:hub-features-kind-tabs-2026-08-27 @promote
  test('TP-fkt-e2e-001 the kind tab row derives from the feed; the first kind is the default, only its rows render', async ({ page }) => {
    await page.goto('/features');
    await page.waitForLoadState('networkidle');
    // Known kinds in display order, then the feed's unknown kind — never a
    // hardcoded list, so a future kind appears automatically (fkt assumption 2).
    await expect(page.locator('nav.kind-tabs a')).toHaveText(['Jobs', 'Services', 'Tools', 'Checks', 'Pages', 'probe']);
    await expect(page.locator('nav.kind-tabs a.active')).toHaveText('Jobs');
    // One kind at a time: the Jobs table only — no stacked groups.
    await expect(page.locator('.feature-group h2')).toHaveText(['Jobs']);
    await expect(rowFor(page, 'Daily digest')).toHaveCount(1);
    await expect(rowFor(page, 'gh CLI')).toHaveCount(0);
  });

  // @plan:hub-features-kind-tabs-2026-08-27 @promote
  test('TP-fkt-e2e-002 clicking a tab switches the rows and the URL reflects the active tab', async ({ page }) => {
    await page.goto('/features');
    await page.waitForLoadState('networkidle');
    await page.locator('nav.kind-tabs a', { hasText: 'Tools' }).click();
    await page.waitForLoadState('networkidle');
    await expect(page).toHaveURL(/\/features\?kind=tool$/);
    await expect(page.locator('nav.kind-tabs a.active')).toHaveText('Tools');
    await expect(page.locator('.feature-group h2')).toHaveText(['Tools']);
    await expect(rowFor(page, 'gh CLI')).toHaveCount(1);
    await expect(rowFor(page, 'Daily digest')).toHaveCount(0);
  });

  // @plan:hub-features-kind-tabs-2026-08-27 @promote
  test('TP-fkt-e2e-003 ?kind= deep-links a tab; an unknown value falls back to the default, never a broken page', async ({ page }) => {
    await gotoKind(page, 'check');
    await expect(page.locator('nav.kind-tabs a.active')).toHaveText('Checks');
    await expect(rowFor(page, 'ssh tunnel transport')).toHaveCount(1);
    await gotoKind(page, 'bogus');
    await expect(page.locator('nav.kind-tabs a.active')).toHaveText('Jobs');
    await expect(rowFor(page, 'Daily digest')).toHaveCount(1);
    await expect(page.locator('.card h1')).toContainText('Features');
  });

  // @plan:hub-features-kind-tabs-2026-08-27 @promote
  test('TP-fkt-e2e-004 an unknown kind gets its own auto-derived tab with the full cell machinery', async ({ page }) => {
    await gotoKind(page, 'probe');
    await expect(page.locator('nav.kind-tabs a.active')).toHaveText('probe');
    const row = rowFor(page, 'Network probe');
    await expect(row).toHaveCount(1);
    await expect(row.locator('td.fm-cell')).toHaveCount(4);
    await expect(row.locator('td.fm-cell').nth(0).locator('.feature-chip')).toHaveText('unmeasured');
  });

  // @plan:hub-features-kind-tabs-2026-08-27 @promote
  test('TP-fkt-e2e-005 tab links preserve the ?stale_minutes= override', async ({ page }) => {
    await page.goto('/features?stale_minutes=1');
    await page.waitForLoadState('networkidle');
    await page.locator('nav.kind-tabs a', { hasText: 'Tools' }).click();
    await page.waitForLoadState('networkidle');
    await expect(page).toHaveURL(/\/features\?kind=tool&stale_minutes=1$/);
    await expect(page.locator('.card').first()).toContainText('no report in 1 min');
    await expect(page.locator('.feature-group h2')).toHaveText(['Tools']);
  });

  // --- the inline scope tag (hub-features-kind-tabs-2026-08-27) ---

  // @plan:hub-features-kind-tabs-2026-08-27 @promote
  test('TP-fkt-e2e-006 the scope column is gone: scope is an inline tag after the title, registry grammar verbatim', async ({ page }) => {
    await page.goto('/features');
    await page.waitForLoadState('networkidle');
    // Header = feature + one th per station; no scope column anywhere.
    const head = page.locator('table.feature-matrix thead th');
    await expect(head).toHaveCount(5);
    await expect(head.nth(0)).toHaveText('feature');
    await expect(head.nth(1)).toHaveClass(/fm-station/);
    await expect(page.locator('td.fm-scope')).toHaveCount(0);
    // The tag sits right after the title, inside the name cell.
    await expect(rowFor(page, 'Daily digest').locator('td.fm-feature strong + .scope-badge')).toHaveText('schedule-owner');
    // Grammar verbatim across kinds — no invented vocabulary.
    await gotoKind(page, 'service');
    await expect(rowFor(page, 'Hub prod service env').locator('td.fm-feature .scope-badge')).toHaveText('env:station-green');
    await gotoKind(page, 'check');
    await expect(rowFor(page, 'ssh tunnel transport').locator('td.fm-feature .scope-badge')).toHaveText('kind:interactive + rollback host');
    await gotoKind(page, 'tool');
    await expect(rowFor(page, 'gh CLI').locator('td.fm-feature .scope-badge')).toHaveText('all');
  });

  // @plan:hub-features-kind-tabs-2026-08-27 @promote
  test('TP-fkt-e2e-007 the freed width goes to the description: the name cell owns most of the row', async ({ page }) => {
    await page.goto('/features');
    await page.waitForLoadState('networkidle');
    const cellBox = await rowFor(page, 'Daily digest').locator('td.fm-feature').boundingBox();
    const tableBox = await page.locator('table.feature-matrix').boundingBox();
    expect(cellBox.width / tableBox.width).toBeGreaterThan(0.4);
  });

  // --- state rendering on the tabbed layout (regressions, IDs kept) ---

  // @plan:hub-features-kind-tabs-2026-08-27 @promote
  test('TP-hubfeat-e2e-021 station columns render on every kind tab, feed order', async ({ page }) => {
    await page.goto('/features');
    await page.waitForLoadState('networkidle');
    const stations = ['station-green', 'station-red', 'station-legacy', 'station-silent'];
    await expect(page.locator('thead th.fm-station a')).toHaveText(stations);
    await gotoKind(page, 'tool');
    await expect(page.locator('thead th.fm-station a')).toHaveText(stations);
  });

  // @plan:hub-features-kind-tabs-2026-08-27 @promote
  test('TP-hubfeat-e2e-022 state chips read differently — and n/a is not missing', async ({ page }) => {
    await gotoKind(page, 'tool');
    const claude = rowFor(page, 'claude CLI');
    const claudeGreen = claude.locator('td.fm-cell').nth(0);
    await expect(claudeGreen.locator('.feature-chip')).toHaveText('missing');
    await expect(claudeGreen.locator('.feature-chip')).toHaveClass(/fc-missing/);
    const gh = rowFor(page, 'gh CLI');
    await expect(gh.locator('td.fm-cell').nth(0).locator('.feature-chip')).toHaveClass(/fc-ready/);
    await expect(rowFor(page, 'az CLI').locator('td.fm-cell').nth(0).locator('.feature-chip')).toHaveClass(/fc-warn/);
    // An out-of-scope cell reads n/a — its own quiet class, never the alert one.
    await page.goto('/features');
    await page.waitForLoadState('networkidle');
    const digestRed = rowFor(page, 'Daily digest').locator('td.fm-cell').nth(1);
    await expect(digestRed.locator('.feature-chip')).toHaveText('n/a');
    await expect(digestRed.locator('.feature-chip')).toHaveClass(/fc-na/);
    await expect(digestRed.locator('.feature-chip')).not.toHaveClass(/fc-missing/);
  });

  // @plan:hub-features-kind-tabs-2026-08-27 @promote
  test('TP-hubfeat-e2e-023 a declared-unmeasured feature never reads ready', async ({ page }) => {
    await gotoKind(page, 'page');
    const row = rowFor(page, 'Hub pages inventory');
    await expect(row.locator('td.fm-feature .feature-chip.fc-unmeasured')).toHaveText('declared, unmeasured');
    await expect(row.locator('td.fm-cell').nth(0).locator('.feature-chip')).toHaveText('unmeasured');
    await expect(row.locator('.feature-chip.fc-ready')).toHaveCount(0);
    await expect(row.locator('.fm-meta')).toContainText('no machine evidence yet');
  });

  // @plan:hub-features-kind-tabs-2026-08-27 @promote
  test('TP-hubfeat-e2e-024 job rows carry their last-run outcome and disabled state', async ({ page }) => {
    await page.goto('/features');
    await page.waitForLoadState('networkidle');
    const digest = rowFor(page, 'Daily digest');
    await expect(digest.locator('.fm-meta')).toContainText('job daily-digest');
    await expect(digest.locator('.fm-meta')).toContainText('last done 2026-01-03');
    const backup = rowFor(page, 'Daily DB backup');
    await expect(backup.locator('td.fm-feature .feature-chip.fc-off')).toHaveText('off');
    await expect(backup.locator('.fm-meta')).toContainText('disabled');
    await expect(backup.locator('td.fm-cell').nth(0).locator('.feature-chip')).toHaveClass(/fc-off/);
  });

  // @plan:hub-features-kind-tabs-2026-08-27 @promote
  test('TP-hubfeat-e2e-025 station-level verdicts render in cells: stale and never-reported', async ({ page }) => {
    await gotoKind(page, 'tool');
    const gh = rowFor(page, 'gh CLI');
    const red = gh.locator('td.fm-cell').nth(1);
    await expect(red.locator('.feature-chip')).toHaveText('stale');
    await expect(red.locator('.feature-chip')).toHaveClass(/fc-stale/);
    const silent = gh.locator('td.fm-cell').nth(3);
    await expect(silent.locator('.feature-chip')).toHaveText('never-reported');
    await expect(silent.locator('.feature-chip')).toHaveClass(/fc-never/);
  });

  // @plan:hub-features-kind-tabs-2026-08-27 @promote
  test('TP-hubfeat-e2e-026 ?stale_minutes= forwards end to end', async ({ page }) => {
    await page.goto('/features?stale_minutes=1');
    await page.waitForLoadState('networkidle');
    await expect(page.locator('.card').first()).toContainText('no report in 1 min');
  });

  // --- the merged surface (Part C — hub-features-stations-merge-2026-08-27) ---

  // @plan:hub-features-kind-tabs-2026-08-27 @promote
  test('TP-fsm-e2e-010 every feature row renders its registry description as the second line, verbatim', async ({ page }) => {
    await page.goto('/features');
    await page.waitForLoadState('networkidle');
    // One description per row on the active tab — both Jobs rows, from the feed.
    await expect(page.locator('.fm-desc')).toHaveCount(2);
    await expect(rowFor(page, 'Daily digest').locator('.fm-desc')).toHaveText(
      'Composes and emails the morning digest so the day starts with one briefing.'
    );
    // The description sits between the title line and the data meta line.
    const cell = rowFor(page, 'Daily digest').locator('td.fm-feature');
    await expect(cell.locator('.fm-desc + .fm-meta')).toHaveCount(1);
    await gotoKind(page, 'tool');
    await expect(rowFor(page, 'gh CLI').locator('.fm-desc')).toHaveText(
      'The GitHub command-line tool agents use to open and check pull requests.'
    );
  });

  // @plan:hub-features-kind-tabs-2026-08-27 @promote
  test('TP-fsm-e2e-012 station headers carry the control plane verdicts: badge, staleness, humanized age', async ({ page }) => {
    await page.goto('/features');
    await page.waitForLoadState('networkidle');
    const green = page.locator('th.fm-station', { hasText: 'station-green' });
    await expect(green.locator('a')).toHaveText('station-green');
    await expect(green.locator('.station-badge.sn-ok')).toHaveText('ok');
    await expect(green.locator('.fmh-age')).toHaveText('4m ago');
    const red = page.locator('th.fm-station', { hasText: 'station-red' });
    await expect(red.locator('.station-badge.sn-failing')).toHaveText('failing');
    await expect(red.locator('.station-badge.sn-stale')).toHaveText('stale');
    await expect(red.locator('.fmh-age')).toHaveText('2h 0m ago');
  });

  // @plan:hub-features-kind-tabs-2026-08-27 @promote
  test('TP-fsm-e2e-013 a never-reported station is a dimmed column with the quiet badge — never alert-styled', async ({ page }) => {
    await gotoKind(page, 'tool');
    const silent = page.locator('th.fm-station', { hasText: 'station-silent' });
    await expect(silent).toHaveClass(/fm-col-never/);
    await expect(silent.locator('.station-badge.sn-never')).toHaveText('never reported');
    await expect(silent.locator('.station-badge.sn-failing')).toHaveCount(0);
    // The cells under it dim with the header — the whole column reads quiet.
    const ghSilentCell = rowFor(page, 'gh CLI').locator('td.fm-cell').nth(3);
    await expect(ghSilentCell).toHaveClass(/fm-col-never/);
    await expect(ghSilentCell.locator('.feature-chip')).toHaveText('never-reported');
  });

  // @plan:hub-features-kind-tabs-2026-08-27 @promote
  test('TP-fsm-e2e-014 a reporter outside configs is never a column; it lands in the Also-reporting strip on every tab', async ({ page }) => {
    await page.goto('/features');
    await page.waitForLoadState('networkidle');
    await expect(page.locator('th.fm-station', { hasText: 'station-rogue' })).toHaveCount(0);
    const row = page.locator('ul.rogue-list li', { hasText: 'station-rogue' });
    await expect(row).toBeVisible();
    await expect(row).toContainText('not in configs');
    await expect(row.locator('a')).toHaveAttribute('href', '/stations/station-rogue');
    await gotoKind(page, 'tool');
    await expect(page.locator('ul.rogue-list li', { hasText: 'station-rogue' })).toBeVisible();
  });

  // @plan:hub-features-kind-tabs-2026-08-27 @promote
  test('TP-fsm-e2e-015 a stations-feed failure degrades softly: plain header names, full matrix, no error', async ({ page, request }) => {
    await failNextStations(request);
    await page.goto('/features');
    await page.waitForLoadState('networkidle');
    await expect(page.locator('.card h1')).toContainText('Features');
    const green = page.locator('th.fm-station', { hasText: 'station-green' });
    await expect(green.locator('a')).toHaveText('station-green');
    await expect(green.locator('.station-badge')).toHaveCount(0);
    await expect(page.locator('ul.rogue-list')).toHaveCount(0);
  });

  // @plan:hub-features-kind-tabs-2026-08-27 @promote
  test('TP-fsm-e2e-028 the stale_minutes override reaches the header verdicts end to end', async ({ page }) => {
    await page.goto('/features?stale_minutes=1');
    await page.waitForLoadState('networkidle');
    const green = page.locator('th.fm-station', { hasText: 'station-green' });
    await expect(green.locator('.station-badge.sn-stale')).toHaveText('stale');
  });
});
