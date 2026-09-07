'use strict';

/**
 * Design-system + CSP invariants in a real browser (React refactor).
 * Test plan: hn-test-plan-2026-07-26-react-refactor (central DB).
 */

const { test, expect } = require('@playwright/test');

test.describe('design system and CSP', () => {
  test('TP-react-030 tokens resolve and interactive elements carry a 150–300ms transition', async ({ page }) => {
    await page.goto('/plans');
    await page.waitForLoadState('networkidle');

    // The token system is live on :root.
    const accent = await page.evaluate(() =>
      getComputedStyle(document.documentElement).getPropertyValue('--accent').trim()
    );
    expect(accent).not.toBe('');

    // Every representative interactive element transitions within the mandated band.
    for (const selector of ['nav.sections a', '.filters a', 'ul.conv-index a']) {
      const durations = await page
        .locator(selector)
        .first()
        .evaluate((el) => getComputedStyle(el).transitionDuration.split(',').map((d) => parseFloat(d) * 1000));
      for (const ms of durations) {
        expect(ms, `${selector} transition ${ms}ms`).toBeGreaterThanOrEqual(150);
        expect(ms, `${selector} transition ${ms}ms`).toBeLessThanOrEqual(300);
      }
    }
  });

  test('TP-react-031 a full section sweep raises zero CSP violations', async ({ page }) => {
    await page.addInitScript(() => {
      window.__cspViolations = [];
      document.addEventListener('securitypolicyviolation', (e) => {
        window.__cspViolations.push(`${e.violatedDirective}: ${e.blockedURI}`);
      });
    });
    await page.goto('/');
    await page.waitForLoadState('networkidle');
    for (const path of ['/conversations', '/plans', '/agents', '/skills', '/knowledge/claude-md']) {
      await page.goto(path);
      await page.waitForLoadState('networkidle');
      const violations = await page.evaluate(() => window.__cspViolations);
      expect(violations, `CSP violations on ${path}`).toEqual([]);
    }
  });
});
