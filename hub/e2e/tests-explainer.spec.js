'use strict';

/**
 * The Tests-subtab explainer (central-DB test plan
 * hn-tests-explainer-2026-08-16): a short standfirst at the top of the
 * Documents → Tests view telling a user who didn't build the system what test
 * plans are, what an open entry means, and what to do about one. Static copy
 * on the existing IndexCard `sub` pattern — scoped to /tests only.
 */

const { test, expect } = require('@playwright/test');

/** The Tests index card (h1 "Tests" — not the "Closed" history card). */
function testsCard(page) {
  return page.locator('.card', { has: page.locator('h1', { hasText: /^Tests$/ }) });
}

test.describe('Tests subtab explainer banner', () => {
  // @plan:hn-tests-explainer-2026-08-16 @promote
  test('TP-testsx-001 /tests opens with the explainer standfirst above the list, carrying the three copy beats', async ({ page }) => {
    await page.goto('/tests');
    await page.waitForLoadState('networkidle');
    const sub = testsCard(page).locator('p.sub');
    await expect(sub).toHaveCount(1);
    // The three beats: what tests are, what an open entry means, what to do.
    await expect(sub).toContainText('proof of correctness');
    await expect(sub).toContainText('closes automatically');
    await expect(sub).toContainText('follow up in a Claude session');
    await expect(sub).toContainText('Closed plans stay here as history');
    // Position: the standfirst precedes the filters and the list inside the card.
    const order = await testsCard(page).evaluate((card) => {
      const kids = [...card.children].map((el) => el.className || el.tagName.toLowerCase());
      return { sub: kids.findIndex((c) => c === 'sub'), filters: kids.findIndex((c) => c === 'filters') };
    });
    expect(order.sub).toBeGreaterThan(-1);
    expect(order.filters).toBeGreaterThan(order.sub);
  });

  // @plan:hn-tests-explainer-2026-08-16 @promote
  test('TP-testsx-002 the explainer is scoped to /tests — no other Documents subtab carries the copy', async ({ page }) => {
    for (const path of ['/plans', '/records', '/conversations']) {
      await page.goto(path);
      await page.waitForLoadState('networkidle');
      // Assert on the copy, not p.sub — the Conversations compose box has its
      // own unrelated standfirst.
      await expect(page.locator('body'), `no explainer on ${path}`).not.toContainText('proof of correctness');
    }
  });

  // @plan:hn-tests-explainer-2026-08-16 @promote
  test('TP-testsx-003 the explainer survives view state: closed-history toggle and repo filter', async ({ page }) => {
    await page.goto('/tests?closed=1');
    await page.waitForLoadState('networkidle');
    await expect(testsCard(page).locator('p.sub')).toContainText('proof of correctness');
    await page.goto('/tests?repo=hub');
    await page.waitForLoadState('networkidle');
    await expect(testsCard(page).locator('p.sub')).toContainText('proof of correctness');
  });
});
