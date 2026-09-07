'use strict';

/**
 * Custom pages framework core (design hub-home-custom-pages-design Part 2,
 * phase 2; central-DB test plan hub-pages-framework-core-2026-08-29): the
 * browser half. The app server runs with HUB_PAGES_DIR pointed at
 * e2e/fixtures/pages — all three tiers plus a skipped no-index folder — so
 * every tab, tier render, sandbox property, and placeholder is exercised
 * against real files with zero network beyond the two managed servers.
 */

const { test, expect } = require('@playwright/test');

const PAGE_TABS = ['▲ Fleet App', 'Broken Board', 'My Notes', 'Ops Board', 'Plain Note'];

test.describe('Custom pages: tabs and tier rendering', () => {
  // @plan:hub-pages-framework-core-2026-08-29 @promote
  test('TP-pages-030 page tabs follow the built-ins in manifest-then-alphabetical order; skipped folders get no tab', async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle');
    // Built-ins first, then the fixture pages: fleet-app pins order 1 (with
    // its manifest icon + title), the rest alphabetical by title.
    await expect(page.locator('nav.sections a')).toHaveText(['Home', 'Documents', 'Claude', ...PAGE_TABS]);
    // The no-index folder is skipped, never a tab.
    await expect(page.locator('nav.sections a', { hasText: 'Drafts' })).toHaveCount(0);
  });

  // @plan:hub-pages-framework-core-2026-08-29 @promote
  test('TP-pages-031 a tier-1 page renders like the Guide: sections, sticky TOC, working anchors, its own tab lit', async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle');
    await page.locator('nav.sections a', { hasText: 'My Notes' }).click();
    await page.waitForLoadState('networkidle');
    await expect(page).toHaveURL(/\/pages\/my-notes$/);
    await expect(page.locator('.guide-main h1')).toHaveText('My Notes');
    // Intro (preamble) + both sections through the shared sectioned layout.
    await expect(page.locator('.guide-main')).toContainText('this preamble lands in the intro');
    await expect(page.locator('.guide-main section.guide-section')).toHaveCount(2);
    const position = await page.locator('.guide-toc').evaluate((el) => getComputedStyle(el).position);
    expect(position).toBe('sticky');
    await page.locator('.guide-toc a[href="#second-note"]').click();
    await expect(page).toHaveURL(/#second-note$/);
    await expect(page.locator('section#second-note')).toBeInViewport();
    // The page's OWN tab is active — one active link, no subtab strip.
    const active = page.locator('nav.sections a.active');
    await expect(active).toHaveCount(1);
    await expect(active).toHaveText('My Notes');
    await expect(page.locator('nav.subtabs')).toHaveCount(0);
  });

  // @plan:hub-pages-framework-core-2026-08-29 @promote
  test('TP-pages-032 a tier-1 page with fewer than two sections renders single-column, no TOC', async ({ page }) => {
    await page.goto('/pages/plain-note');
    await page.waitForLoadState('networkidle');
    await expect(page.locator('.guide-main h1')).toHaveText('Plain Note');
    await expect(page.locator('.guide-main')).toContainText('no section headings');
    await expect(page.locator('.guide-toc')).toHaveCount(0);
    await expect(page.locator('.guide-layout')).toHaveCount(0);
  });

  // @plan:hub-pages-framework-core-2026-08-29 @promote
  test('TP-pages-033 a tier-3 page runs inside the sandboxed iframe — scripts execute, assets load, the hub shell is unreachable', async ({ page }) => {
    await page.goto('/pages/fleet-app');
    await page.waitForLoadState('networkidle');
    const iframe = page.locator('iframe.page-frame');
    await expect(iframe).toHaveCount(1);
    // The sandbox is the security posture: scripts and forms, NEVER
    // allow-same-origin (security review docs/security-review-pages-serving.md).
    await expect(iframe).toHaveAttribute('sandbox', 'allow-scripts allow-forms');
    await expect(iframe).toHaveAttribute('src', /^\/pages-view\/[^/]+\/fleet-app\/$/);
    const app = page.frameLocator('iframe.page-frame');
    // Scripts executed…
    await expect(app.locator('#status')).toHaveText('script ran');
    // …the sandbox held: window.parent.document threw inside the frame…
    await expect(app.locator('#isolation')).toHaveText('isolated');
    // …and sibling assets served under the page's own path: the stylesheet
    // painted the title, the image resolved to real bytes.
    await expect(app.locator('#app-title')).toHaveCSS('color', 'rgb(0, 128, 0)');
    const naturalWidth = await app.locator('#logo').evaluate((img) => img.naturalWidth);
    expect(naturalWidth).toBeGreaterThan(0);
  });

  // (Phase 2's TP-pages-034 — the tier-2 later-phase placeholder — retired
  // with the placeholder itself: phase 3 ships the real widget renderer,
  // covered by TP-widg-030/032 in e2e/pages-widgets.spec.js.)

  // @plan:hub-pages-framework-core-2026-08-29 @promote
  test('TP-pages-035 an unknown page slug renders the error card with no tab lit', async ({ page }) => {
    await page.goto('/pages/nope');
    await page.waitForLoadState('networkidle');
    await expect(page.locator('.card h1')).toHaveText('Not found');
    await expect(page.locator('nav.sections a.active')).toHaveCount(0);
  });

  // @plan:hub-guide-ask-orchestrator-2026-08-29 @promote
  // (TP-guide4-001/002 in the browser, amending TP-widg-034's amendment of
  // phase 2's TP-pages-036 to the final truth: phase 4 filled the
  // ask-the-orchestrator section, so no stub section remains in the guide.)
  test('TP-pages-036 the guide onboards all three tiers and the orchestrator path — no stub sections remain', async ({ page }) => {
    await page.goto('/guide');
    await page.waitForLoadState('networkidle');
    // Shipped tiers: the five-minute walks, no placeholder.
    for (const id of ['tier-1-markdown-pages', 'tier-2-widget-layouts', 'tier-3-full-html-js-sites']) {
      await expect(page.locator(`section#${id}`)).not.toContainText('Coming in a later phase');
    }
    await expect(page.locator('section#tier-1-markdown-pages')).toContainText('index.md');
    await expect(page.locator('section#tier-3-full-html-js-sites')).toContainText('sandbox');
    await expect(page.locator('section#custom-pages-build-your-own-tabs')).toContainText('HUB_PAGES_DIR');
    // The tier-2 section documents the catalog (the design: the Guide owns it).
    await expect(page.locator('section#tier-2-widget-layouts')).toContainText('index.json');
    for (const widget of ['digest-list', 'plan-list', 'plan-view', 'feature-cells', 'stat-tiles']) {
      await expect(page.locator('section#tier-2-widget-layouts')).toContainText(widget);
    }
    // Phase 4 filled the last stub: the ask-the-orchestrator section exists,
    // carries the real walk (asking, folder/tab delivery, the audit trail),
    // and no "Coming in a later phase" marker survives anywhere on the page.
    const ask = page.locator('section#ask-the-orchestrator-agent-built-pages');
    await expect(ask).toHaveCount(1);
    await expect(ask).toContainText('pages folder');
    await expect(ask).toContainText('audit trail');
    await expect(page.locator('.guide-main')).not.toContainText('Coming in a later phase');
    // The TOC still enumerates every section, one link each.
    const count = await page.locator('.guide-main section.guide-section').count();
    await expect(page.locator('.guide-toc a')).toHaveCount(count);
  });

  // @plan:hub-pages-framework-core-2026-08-29 @promote
  test('TP-pages-037 built-in navigation is unchanged with pages enabled', async ({ page }) => {
    // The Home section still owns its subtab bar and landing behavior.
    await page.goto('/');
    await page.waitForLoadState('networkidle');
    await expect(page.locator('nav.sections a.active')).toHaveText('Home');
    await expect(page.locator('nav.subtabs a')).toHaveText(['Digests', 'Guide']);
    // Documents keeps its bar; no page tab lights outside its own routes.
    await page.goto('/plans');
    await page.waitForLoadState('networkidle');
    await expect(page.locator('nav.sections a.active')).toHaveText('Documents');
    await expect(page.locator('nav.subtabs a')).toHaveText(['Plans', 'Tests', 'Records', 'Conversations']);
  });
});
