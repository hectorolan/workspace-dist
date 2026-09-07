'use strict';

/**
 * Home restructure (design hub-home-custom-pages-design Part 1, the CEO
 * 2026-08-29; central-DB test plan hub-home-restructure-2026-08-29): the
 * Digests tab became HOME — the landing surface, lit on `/`, grouping
 * Digests (`/`, plus the carried-over /digests index + detail) and Guide
 * (`/guide`, the user manual with its sticky right-hand section TOC) as
 * subtabs on the shared template. No URL disappeared: /digests and
 * /digests/:date stay live routes, so old bookmarks and digest emails keep
 * working with zero new redirects (navigation.spec.js still guards the
 * legacy ?date= redirects).
 */

const { test, expect } = require('@playwright/test');

test.describe('Home section: tab, landing, subtabs', () => {
  // @plan:hub-pages-framework-core-2026-08-29 @promote
  // (Amended by phase 2: custom-page tabs now follow the built-ins — this
  // suite runs with the fixture pages root enabled — so the built-in roster
  // is asserted as the LEADING three; pages.spec.js TP-pages-030 owns the
  // full ordering.)
  test('TP-home-010 the top nav leads with Home, Documents and Claude, Home linking to /', async ({ page }) => {
    await page.goto('/plans');
    await page.waitForLoadState('networkidle');
    const tabs = page.locator('nav.sections a');
    await expect(tabs.nth(0)).toHaveText('Home');
    await expect(tabs.nth(1)).toHaveText('Documents');
    await expect(tabs.nth(2)).toHaveText('Claude');
    await expect(page.locator('nav.sections a', { hasText: 'Home' })).toHaveAttribute('href', '/');
    // Digests and Guide are Home SUBTABS, never top-level entries.
    for (const gone of ['Digests', 'Guide']) {
      await expect(page.locator('nav.sections a', { hasText: gone })).toHaveCount(0);
    }
  });

  // @plan:hub-home-restructure-2026-08-29 @promote
  test('TP-home-011 / renders the latest digest with Home lit and the Digests/Guide subtab bar, Digests active', async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle');
    // The morning read carries over: newest digest in full, thread below.
    await expect(page.locator('.card h1').first()).toContainText('Daily Digest — 2026-01-03');
    await expect(page.locator('#doc-thread')).toBeVisible();
    // Home is the active section — `/` is its own route now (supersedes the
    // 2026-08-15 no-tab-on-/ call; the CEO's Home design, 2026-08-29).
    const active = page.locator('nav.sections a.active');
    await expect(active).toHaveCount(1);
    await expect(active).toHaveText('Home');
    // The Home subtab bar, on the shared template, Digests selected.
    await expect(page.locator('nav.subtabs a')).toHaveText(['Digests', 'Guide']);
    await expect(page.locator('nav.subtabs a.active')).toHaveText('Digests');
  });

  // @plan:hub-home-restructure-2026-08-29 @promote
  test('TP-home-012 the brand click lands on Home with the Home tab lit — the landing surface', async ({ page }) => {
    await page.goto('/knowledge');
    await page.waitForLoadState('networkidle');
    await page.locator('.brand a').click();
    await page.waitForLoadState('networkidle');
    await expect(page).toHaveURL(/\/$/);
    await expect(page.locator('.card h1').first()).toContainText('Daily Digest — 2026-01-03');
    await expect(page.locator('nav.sections a.active')).toHaveText('Home');
  });

  // @plan:hub-home-restructure-2026-08-29 @promote
  test('TP-home-013 /digests and a digest detail carry over under Home: Home tab + Digests subtab lit', async ({ page }) => {
    for (const path of ['/digests', '/digests/2026-01-02']) {
      await page.goto(path);
      await page.waitForLoadState('networkidle');
      const active = page.locator('nav.sections a.active');
      await expect(active, `active tab on ${path}`).toHaveCount(1);
      await expect(active).toHaveText('Home');
      await expect(page.locator('nav.subtabs a.active')).toHaveText('Digests');
    }
    // The index itself is untouched — same rows, same history surface.
    await page.goto('/digests');
    await page.waitForLoadState('networkidle');
    await expect(page.locator('ul.conv-index.two-line li')).toHaveCount(3);
  });
});

test.describe('Guide: the manual + its section TOC', () => {
  // @plan:hub-home-restructure-2026-08-29 @promote
  test('TP-home-014 the Guide subtab opens the manual: content left, sticky TOC right enumerating every section', async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle');
    await page.locator('nav.subtabs a', { hasText: 'Guide' }).click();
    await page.waitForLoadState('networkidle');
    await expect(page).toHaveURL(/\/guide$/);
    await expect(page.locator('nav.sections a.active')).toHaveText('Home');
    await expect(page.locator('nav.subtabs a.active')).toHaveText('Guide');
    // The manual renders on the left…
    await expect(page.locator('.guide-main h1')).toHaveText('Hub guide');
    const sections = page.locator('.guide-main section.guide-section');
    const count = await sections.count();
    expect(count).toBeGreaterThanOrEqual(6);
    // …and the TOC enumerates EVERY section, one link each, in order —
    // including the stubbed framework structure (tiers + ask-the-orchestrator).
    const tocLinks = page.locator('.guide-toc a');
    await expect(tocLinks).toHaveCount(count);
    for (const id of [
      'what-the-hub-is',
      'tier-1-markdown-pages',
      'tier-2-widget-layouts',
      'tier-3-full-html-js-sites',
      'ask-the-orchestrator-agent-built-pages',
    ]) {
      await expect(page.locator(`.guide-toc a[href="#${id}"]`), `TOC link #${id}`).toHaveCount(1);
    }
    // Layout: the TOC is the sticky right-hand column.
    const position = await page.locator('.guide-toc').evaluate((el) => getComputedStyle(el).position);
    expect(position).toBe('sticky');
    const main = await page.locator('.guide-main').boundingBox();
    const toc = await page.locator('.guide-toc').boundingBox();
    expect(toc.x).toBeGreaterThanOrEqual(main.x + main.width - 1);
  });

  // @plan:hub-home-restructure-2026-08-29 @promote
  test('TP-home-015 a TOC link jumps to its section', async ({ page }) => {
    await page.goto('/guide');
    await page.waitForLoadState('networkidle');
    await page.locator('.guide-toc a[href="#tier-3-full-html-js-sites"]').click();
    await expect(page).toHaveURL(/#tier-3-full-html-js-sites$/);
    await expect(page.locator('section#tier-3-full-html-js-sites')).toBeInViewport();
  });

  // TP-home-016 (phase 1's @throwaway stub proof) was deleted by phase 2 as
  // designed: pages.spec.js TP-pages-036 now owns the stubbed-vs-filled split.

  // @plan:hub-home-restructure-2026-08-29 @promote
  test('TP-home-017 the subtab strip stays scoped: Home bar on home routes, others unchanged, none on the 404', async ({ page }) => {
    for (const path of ['/', '/digests', '/guide']) {
      await page.goto(path);
      await page.waitForLoadState('networkidle');
      await expect(page.locator('nav.subtabs a'), `Home bar on ${path}`).toHaveText(['Digests', 'Guide']);
    }
    await page.goto('/plans');
    await page.waitForLoadState('networkidle');
    await expect(page.locator('nav.subtabs a')).toHaveText(['Plans', 'Tests', 'Records', 'Conversations']);
    await page.goto('/no-such-section');
    await page.waitForLoadState('networkidle');
    await expect(page.locator('nav.subtabs')).toHaveCount(0);
    await expect(page.locator('nav.sections a.active')).toHaveCount(0);
  });

  // @plan:hub-home-restructure-2026-08-29 @promote
  test('TP-home-018 on a narrow viewport the guide collapses to one column with the jump list on top', async ({ page }) => {
    await page.setViewportSize({ width: 600, height: 900 });
    await page.goto('/guide');
    await page.waitForLoadState('networkidle');
    const columns = await page
      .locator('.guide-layout')
      .evaluate((el) => getComputedStyle(el).gridTemplateColumns.trim().split(/\s+/).length);
    expect(columns).toBe(1);
    const main = await page.locator('.guide-main').boundingBox();
    const toc = await page.locator('.guide-toc').boundingBox();
    expect(toc.y).toBeLessThan(main.y);
  });
});
