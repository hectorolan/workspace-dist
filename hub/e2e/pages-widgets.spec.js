'use strict';

/**
 * Tier-2 widget boards (design hub-home-custom-pages-design "Tier semantics",
 * phase 3; central-DB test plan hub-pages-tier2-widgets-2026-08-29): the
 * browser half. The app server runs with HUB_PAGES_DIR at e2e/fixtures/pages —
 * `ops-board/` is a valid layout exercising all five catalog widgets plus an
 * unknown `crystal-ball` entry, `broken-board/` is deliberately malformed —
 * and every widget's data comes from the stub log API's fixtures: the suite
 * stays deterministic, the real API is never contacted, nothing writes to
 * the central DB.
 */

const { test, expect } = require('@playwright/test');
const { resetStub, failNextFeatures } = require('./helpers');

test.describe('Custom pages: tier-2 widget boards', () => {
  test.beforeEach(async ({ request }) => {
    await resetStub(request);
  });

  // @plan:hub-pages-tier2-widgets-2026-08-29 @promote
  test('TP-widg-030 ops-board renders every catalog widget as a card, in layout order, with live-linked hub data', async ({ page }) => {
    await page.goto('/pages/ops-board');
    await page.waitForLoadState('networkidle');
    await expect(page.locator('.widget-board-head h1')).toHaveText('Ops Board');
    // Layout order, one card each (the sixth is the unknown-widget entry).
    const cards = page.locator('.widget-card');
    await expect(cards).toHaveCount(6);
    const order = await cards.evaluateAll((els) => els.map((el) => el.dataset.widget));
    expect(order).toEqual(['stat-tiles', 'digest-list', 'plan-list', 'feature-cells', 'plan-view', 'crystal-ball']);
    // stat-tiles: counted from the stub's own fixtures — 4 open documents,
    // newest digest date, 1 healthy of 4 configured stations (green fresh;
    // red + legacy stale; silent never-reported; rogue not configured).
    const tiles = page.locator('.stat-tile');
    await expect(tiles.nth(0)).toContainText('4');
    await expect(tiles.nth(0)).toContainText('Open plans');
    await expect(tiles.nth(1)).toContainText('2026-01-03');
    await expect(tiles.nth(2)).toContainText('1/4');
    // digest-list: newest two, linked into the Digests section; the entry
    // title override renames the card.
    const digestCard = page.locator('.widget-card[data-widget="digest-list"]');
    await expect(digestCard.locator('h2')).toHaveText('Morning reads');
    await expect(digestCard.locator('a[href="/digests/2026-01-03"]')).toHaveText('Quiet markets, loud agents');
    await expect(digestCard.locator('.widget-rows li')).toHaveCount(2);
    // plan-list (kind=test-plan): open test plans, linked into Documents.
    const planCard = page.locator('.widget-card[data-widget="plan-list"]');
    await expect(planCard.locator('a[href="/plans/e2e-nexus-test-plan"]')).toHaveText('E2E hub test plan');
    // feature-cells: the shared chip vocabulary, verdicts straight from the feed.
    const cellCard = page.locator('.widget-card[data-widget="feature-cells"]');
    await expect(cellCard.locator('th', { hasText: 'station-green' })).toHaveCount(1);
    await expect(cellCard.locator('.feature-chip.fc-ready').first()).toHaveText('ready');
    await expect(cellCard.locator('.feature-chip.fc-missing').first()).toHaveText('missing');
    // plan-view: the document body rendered in place.
    const viewCard = page.locator('.widget-card[data-widget="plan-view"]');
    await expect(viewCard).toContainText('E2E active plan');
    await expect(viewCard.locator('a[href="/plans/e2e-active-plan"]')).toHaveCount(1);
    // The page's own tab is active, no subtab strip — same as every tier.
    await expect(page.locator('nav.sections a.active')).toHaveText('Ops Board');
    await expect(page.locator('nav.subtabs')).toHaveCount(0);
  });

  // @plan:hub-pages-tier2-widgets-2026-08-29 @promote
  test('TP-widg-031 an unknown widget renders a visible placeholder naming it; every other widget still renders', async ({ page }) => {
    await page.goto('/pages/ops-board');
    await page.waitForLoadState('networkidle');
    const unknown = page.locator('.widget-card[data-widget="crystal-ball"]');
    await expect(unknown).toHaveClass(/widget-unknown/);
    await expect(unknown).toContainText('crystal-ball');
    await expect(unknown).toContainText('catalog');
    // Neighbours unaffected.
    await expect(page.locator('.widget-card[data-widget="digest-list"] .widget-rows li')).toHaveCount(2);
  });

  // @plan:hub-pages-tier2-widgets-2026-08-29 @promote
  test('TP-widg-032 a malformed layout shows one clear layout-error card — tab present, hub intact, never a crash', async ({ page }) => {
    await page.goto('/pages/broken-board');
    await page.waitForLoadState('networkidle');
    await expect(page.locator('.widget-board-head h1')).toHaveText('Broken Board');
    await expect(page.locator('.widget-layout-error')).toContainText('not valid JSON');
    await expect(page.locator('nav.sections a.active')).toHaveText('Broken Board');
  });

  // @plan:hub-pages-tier2-widgets-2026-08-29 @promote
  test('TP-widg-033 a failing data source degrades only its widget — the rest of the board still renders', async ({ page, request }) => {
    await failNextFeatures(request);
    await page.goto('/pages/ops-board');
    await page.waitForLoadState('networkidle');
    const cellCard = page.locator('.widget-card[data-widget="feature-cells"]');
    await expect(cellCard).toHaveClass(/widget-error/);
    await expect(cellCard).toContainText('did not answer');
    await expect(page.locator('.widget-card[data-widget="digest-list"] .widget-rows li')).toHaveCount(2);
    await expect(page.locator('.widget-card[data-widget="plan-view"]')).toContainText('E2E active plan');
  });

  // @plan:hub-pages-tier2-widgets-2026-08-29 @promote
  test('TP-widg-035 built-in navigation is unchanged with widget boards live', async ({ page }) => {
    await page.goto('/pages/ops-board');
    await page.waitForLoadState('networkidle');
    await page.locator('nav.sections a', { hasText: 'Home' }).click();
    await page.waitForLoadState('networkidle');
    await expect(page.locator('nav.sections a.active')).toHaveText('Home');
    await expect(page.locator('nav.subtabs a')).toHaveText(['Digests', 'Guide']);
  });
});
