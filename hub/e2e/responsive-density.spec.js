'use strict';

/**
 * Responsive density guards — assert the mobile-density rework, don't describe
 * it. Metrics are shared with the report tool (e2e/density-metrics.js, run via
 * e2e/measure-density.js). Test plan: hn-test-plan-2026-08-01-mobile-density
 * (central DB). Baseline being guarded against: 375px used to spend 22% of its
 * width on chrome, show ~37 characters per line, and scroll horizontally;
 * desktop's 72ch measure rendered ~92 cpl.
 */

const { test, expect } = require('@playwright/test');
const { measureDensity } = require('./density-metrics.js');

const PAGE = '/digests/2026-01-03'; // stub fixture digest with a .prose body

// One parameterised spec over the three reference widths (suite-lean rule).
const CASES = [
  // 45 cpl is unreachable at 375px without the phone type step-down (17px serif
  // ≈ 8px/glyph → ≤44 cpl even at zero chrome); ≥42 guards the band's floor.
  { id: 'TP-nexus-e2e-054', width: 375, height: 812, minCpl: 42, maxCpl: 75, maxChromePct: 13 },
  // 768 and 1280: the reading column caps below the shell width, so
  // viewport − card includes the centering margins — deliberate whitespace,
  // not chrome; the chrome bound binds only at 375 where the card fills the
  // viewport. The shared-edge guard (TP-nexus-e2e-062) replaces it here.
  // 768 and 1280: the CEO chose END-TO-END prose on 2026-08-01, superseding the
  // centred column of earlier that day — so these no longer assert the 45-75
  // readable band. They were NOT deleted: an assertion that quietly disappears
  // takes the decision with it. They now guard the CURRENT intent — prose fills
  // its container, bounded only by --shell-max — with the band recorded here as
  // the thing deliberately traded away (~121 cpl at 1280 vs the <=80 that WCAG
  // and dyslexia guidance suggest). Restoring narrow prose is one token
  // (--measure in tokens.css); these bounds move with it.
  { id: 'TP-nexus-e2e-055', width: 768, height: 1024, minCpl: 70, maxCpl: 110, maxChromePct: null },
  { id: 'TP-nexus-e2e-056', width: 1280, height: 800, minCpl: 100, maxCpl: 140, maxChromePct: null },
];

test.describe('responsive density', () => {
  for (const c of CASES) {
    // @plan:hn-test-plan-2026-08-01-mobile-density @promote
    test(`${c.id} at ${c.width}px the reading column holds its intended width`, async ({ page }) => {
      await page.setViewportSize({ width: c.width, height: c.height });
      await page.goto(PAGE);
      await page.waitForSelector('.prose');
      const m = await page.evaluate(measureDensity);

      expect(m.error, 'metrics found .prose/.card').toBeUndefined();
      expect(m.cpl, `cpl ${m.cpl} at ${c.width}px`).toBeGreaterThanOrEqual(c.minCpl);
      expect(m.cpl, `cpl ${m.cpl} at ${c.width}px`).toBeLessThanOrEqual(c.maxCpl);
      if (c.maxChromePct !== null) {
        expect(m.chromePct, `chrome ${m.chromePct}% at ${c.width}px`).toBeLessThanOrEqual(c.maxChromePct);
      }
      expect(m.hasHorizontalOverflow, `horizontal overflow at ${c.width}px`).toBe(false);
    });
  }

  // @plan:hn-test-plan-2026-08-01-mobile-density @promote
  test('TP-nexus-e2e-057 the phone reading scale steps down below the desktop 17px', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto(PAGE);
    await page.waitForSelector('.prose');
    const desktopFs = await page.evaluate(() => parseFloat(getComputedStyle(document.querySelector('.prose')).fontSize));

    await page.setViewportSize({ width: 375, height: 812 });
    const phoneFs = await page.evaluate(() => parseFloat(getComputedStyle(document.querySelector('.prose')).fontSize));

    expect(desktopFs).toBe(17);
    expect(phoneFs, `phone reading size ${phoneFs}px`).toBeLessThan(desktopFs);
  });

  // The desktop reading column (CEO decision 2026-08-01): on a READING page the
  // card narrows to hug the measure and centres, so card edge, heading
  // hairlines, and prose share one edge instead of a wide card holding a
  // left-pinned 551px column. Also guards the --measure/--measure-col token
  // pairing — ch resolves per-element, so the pair drifting apart shows up
  // here as a card/prose width mismatch.
  // @plan:hn-test-plan-2026-08-01-mobile-density @promote
  test('TP-nexus-e2e-062 at 1280px the reading card hugs the prose (shared edge)', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto(PAGE);
    await page.waitForSelector('.prose');
    const m = await page.evaluate(measureDensity);

    expect(m.error, 'metrics found .prose/.card').toBeUndefined();
    expect(
      Math.abs(m.cardContentPx - m.prosePx),
      `card content box ${m.cardContentPx}px vs prose ${m.prosePx}px`
    ).toBeLessThanOrEqual(8);
  });

  // The converse split: an INDEX page (row-shaped main content) stays full
  // width — scanning benefits from width, prose does not. Shell-capped card
  // content is ~964px at 1280 (1080 shell max − paddings/borders); a wrongly
  // applied reading column would drop it to ~551px.
  // @plan:hn-test-plan-2026-08-01-mobile-density @promote
  test('TP-nexus-e2e-063 at 1280px an index page card stays full width', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto('/plans');
    await page.waitForSelector('.card');
    const cardContentPx = await page.evaluate(() => {
      const card = document.querySelector('.card');
      const s = getComputedStyle(card);
      return card.clientWidth - parseFloat(s.paddingLeft) - parseFloat(s.paddingRight);
    });
    expect(cardContentPx, `index card content box ${cardContentPx}px`).toBeGreaterThan(900);
  });
});
