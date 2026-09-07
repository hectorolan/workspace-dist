'use strict';

/**
 * Index-row chip placement (test plan
 * hub-conversation-index-chip-line1-2026-08-17): chips rendered through
 * IndexRow's `after` slot — the Conversations artifact chip, the Skills origin
 * chip — sit ON line 1 of the two-line ledger row, immediately after the
 * title's badges, instead of stretching into their own column beside the row
 * (the CEO's 2026-08-17 live-site bug). The stretched row link keeps the whole
 * row clickable while the chips stay independently clickable SIBLINGS of the
 * row anchor — never nested anchors.
 */

const { test, expect } = require('@playwright/test');
const { resetStub } = require('./helpers');

/** True when two bounding boxes overlap vertically (share a text line). */
const yOverlaps = (a, b) => a.y < b.y + b.height && b.y < a.y + a.height;

test.describe('index-row chips sit on line 1', () => {
  test.beforeEach(async ({ request }) => {
    await resetStub(request);
  });

  // @plan:hub-conversation-index-chip-line1-2026-08-17 @promote
  test('TP-chipline1-001/004 the artifact chip renders inside line 1 beside the badges, outside the row anchor', async ({ page }) => {
    await page.goto('/conversations');
    await page.waitForLoadState('networkidle');
    const row = page.locator('ul.conv-index li', { hasText: 'E2E active thread' });
    const chip = row.locator('a.artifact-chip');
    await expect(chip).toHaveText('→ plan');

    // TP-chipline1-004: a SIBLING of the row anchor inside the line-1
    // container — valid HTML, never a nested anchor.
    await expect(row.locator('.conv-line1 > a.artifact-chip')).toHaveCount(1);
    await expect(row.locator('a.row-link a.artifact-chip')).toHaveCount(0);

    // TP-chipline1-001: visually ON line 1 — the chip's box shares the
    // title's text line and sits fully above the machine-facts line.
    const title = await row.locator('.conv-title').boundingBox();
    const chipBox = await chip.boundingBox();
    const meta = await row.locator('.conv-meta').boundingBox();
    expect(yOverlaps(chipBox, title), 'chip must share line 1 with the title').toBe(true);
    expect(chipBox.y + chipBox.height, 'chip must sit above the facts line').toBeLessThanOrEqual(meta.y + 1);
  });

  // @plan:hub-conversation-index-chip-line1-2026-08-17 @promote
  test('TP-chipline1-003 the stretched row link leaves no dead zones: the facts line still opens the conversation', async ({ page }) => {
    await page.goto('/conversations');
    await page.waitForLoadState('networkidle');
    const row = page.locator('ul.conv-index li', { hasText: 'E2E active thread' });
    // Click the machine-facts line — outside both the title text and the chip.
    // The stretched-link overlay receives the click, so this goes through the
    // raw mouse (locator.click would refuse: the overlay is not a descendant
    // of .meta-facts).
    const facts = await row.locator('.meta-facts').boundingBox();
    await page.mouse.click(facts.x + facts.width / 2, facts.y + facts.height / 2);
    await page.waitForLoadState('networkidle');
    await expect(page).toHaveURL(/\/conversations\/4001$/);
    await expect(page.locator('.card h1')).toContainText('E2E active thread');
  });

  // @plan:hub-conversation-index-chip-line1-2026-08-17 @promote
  test('TP-chipline1-005 the Skills origin chip rides the same idiom: line 1, links intact', async ({ page }) => {
    await page.goto('/skills');
    await page.waitForLoadState('networkidle');

    const external = page.locator('ul.conv-index li', { hasText: 'e2e-external-skill' });
    const chip = external.locator('a.origin-chip');
    await expect(chip).toHaveCount(1);
    const title = await external.locator('.conv-title').boundingBox();
    const chipBox = await chip.boundingBox();
    const meta = await external.locator('.conv-meta').boundingBox();
    expect(yOverlaps(chipBox, title), 'origin chip must share line 1 with the name').toBe(true);
    expect(chipBox.y + chipBox.height, 'origin chip must sit above the facts line').toBeLessThanOrEqual(meta.y + 1);

    // The workspace chip stays a non-link span, on line 1 of its own row.
    const internal = page.locator('ul.conv-index li', { hasText: 'e2e-internal-skill' });
    await expect(internal.locator('.conv-line1 .origin-chip')).toHaveText('workspace');
    await expect(internal.locator('a.origin-chip')).toHaveCount(0);
  });
});
