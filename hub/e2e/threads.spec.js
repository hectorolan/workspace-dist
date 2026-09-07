'use strict';

/**
 * Document threads below their documents (design: central-DB plan
 * nexus-document-threads-design, N1; test plan test-plan-document-threads-n1).
 * The thread renders as part of the ledger under the digest/plan detail pages:
 * CEO and agent entries visually distinct, a trigger entry pinned to the top as
 * the document's origin, the comment box relabeled "Add to this thread" at the
 * foot — and a posted comment appears in the thread without a reload.
 */

const { test, expect } = require('@playwright/test');
const { resetStub, capturedPosts, commentBox } = require('./helpers');

const entries = (page) => page.locator('#doc-thread article.thread-entry');

test.describe('document threads', () => {
  test.beforeEach(async ({ request }) => {
    await resetStub(request);
  });

  // @plan:test-plan-document-threads-n1 @promote
  test('TP-nexus-e2e-064 a plan page renders its thread in order with CEO and Agent distinct', async ({ page }) => {
    await page.goto('/plans/e2e-active-plan');
    await expect(entries(page)).toHaveCount(2);

    const first = entries(page).nth(0);
    await expect(first).toHaveAttribute('data-role', 'ceo');
    await expect(first.locator('.who')).toHaveText('CEO');
    // The instruction renders; the captured page-context echo never does.
    await expect(first).toContainText('split section one into tasks');
    await expect(first).not.toContainText('CONTEXT-ECHO-MUST-NOT-RENDER');

    const second = entries(page).nth(1);
    await expect(second).toHaveAttribute('data-role', 'agent');
    await expect(second.locator('.who')).toHaveText('Agent');
    await expect(second).toContainText('Split into three tasks');

    // The thread sits below the document, above the comment box.
    await expect(page.locator('#doc-thread .thread-eyebrow')).toHaveText('Thread');
    await expect(page.locator('#comment-box h2')).toHaveText('Add to this thread');
  });

  // @plan:test-plan-document-threads-n1 @promote
  test('TP-nexus-e2e-065 an empty thread renders only the comment box — no thread chrome', async ({ page }) => {
    await page.goto('/plans/e2e-done-plan');
    await expect(page.locator('#comment-box')).toBeVisible();
    await expect(page.locator('#comment-box h2')).toHaveText('Add to this thread');
    await expect(entries(page)).toHaveCount(0);
    await expect(page.locator('#doc-thread .thread-eyebrow')).toHaveCount(0);
  });

  // @plan:test-plan-document-threads-n1 @promote
  test('TP-nexus-e2e-066 a trigger entry renders at the top marked as the document origin', async ({ page }) => {
    await page.goto('/plans/e2e-nexus-test-plan');
    await expect(entries(page)).toHaveCount(3);
    const first = entries(page).nth(0);
    // Its `created` is the LATEST in the fixture — origin still pins to the top.
    await expect(first).toHaveAttribute('data-role', 'trigger');
    await expect(first.locator('.who')).toHaveText('Origin');
    await expect(first).toContainText('This document exists because of this exchange.');
    await expect(entries(page).nth(1)).toHaveAttribute('data-role', 'ceo');
    await expect(entries(page).nth(2)).toHaveAttribute('data-role', 'agent');
  });

  // @plan:test-plan-document-threads-n1 @promote
  test('TP-nexus-e2e-067 the comment box still posts via the confirm modal and the new CEO entry appears without a reload', async ({ page, request }) => {
    await page.goto('/plans/e2e-active-plan');
    await expect(entries(page)).toHaveCount(2);

    const c = commentBox(page);
    await c.text.fill('A brand **new** thread comment.');
    await c.open.click();
    await expect(c.modal).toBeVisible();
    await c.confirm.click();
    await expect(c.status).toHaveText('Added to the thread — the reply lands here in about 15 minutes, and by email.');

    // Same POST machinery as before: one page-comment with the page identity.
    const posts = await capturedPosts(request);
    expect(posts).toHaveLength(1);
    expect(posts[0].kind).toBe('page-comment');
    expect(JSON.parse(posts[0].meta)).toMatchObject({ pageType: 'plans', slug: 'e2e-active-plan' });

    // The refetched thread shows the new CEO entry (intake wrote it synchronously).
    await expect(entries(page)).toHaveCount(3);
    const added = entries(page).nth(2);
    await expect(added).toHaveAttribute('data-role', 'ceo');
    await expect(added).toContainText('A brand new thread comment.');
    await expect(added).not.toContainText('Page context');
  });

  // _2: PR #33's navigation.spec.js claimed 078 first — suffix, never renumber
  // (CEO 2026-08-02; grammar: workspace cli/util/baseline.js CASE_ID_SOURCE).
  // @plan:test-plan-thread-entry-provenance @promote
  test('TP-nexus-e2e-078_2 an entry shows its MESSAGE date, never entry.created', async ({ page }) => {
    await page.goto('/plans/e2e-nexus-test-plan');
    // The trigger entry is backfilled history: entry.created (the LINK time) is
    // 2026-01-02T13:00Z but its message was written 2026-01-01T09:00Z — the
    // CEO's reported bug. The stamp must be the message's date + ts time.
    await expect(entries(page).nth(0).locator('.when')).toHaveText('2026-01-01 09:00');
    // A same-day entry still stamps from the message (ts 12:00, created 12:00).
    await expect(entries(page).nth(1).locator('.when')).toHaveText('2026-01-02 12:00');
  });

  // @plan:test-plan-thread-entry-provenance @promote
  test('TP-nexus-e2e-079_2 the provenance line: conversation key when present, message id + kind always, below the date', async ({ page }) => {
    await page.goto('/plans/e2e-active-plan');
    await expect(entries(page)).toHaveCount(2);
    // CEO comment: born on the page, no source conversation — no conversations/ segment.
    await expect(entries(page).nth(0).locator('.prov')).toHaveText('message 701 · page-comment');
    // Agent reply: carries its source conversation key.
    await expect(entries(page).nth(1).locator('.prov')).toHaveText('conversations/12 · message 702 · inbox-reply');
    // "Below the date to have the key" — the provenance line sits under .when.
    const when = await entries(page).nth(1).locator('.when').boundingBox();
    const prov = await entries(page).nth(1).locator('.prov').boundingBox();
    expect(prov.y).toBeGreaterThanOrEqual(when.y + when.height - 1);
  });

  // @plan:test-plan-document-threads-n3 @promote
  test('TP-nexus-e2e-086 a skill page renders its thread below the document; a skill without one shows the box only', async ({ page }) => {
    await page.goto('/skills/e2e-internal-skill');
    await expect(entries(page)).toHaveCount(2);
    const first = entries(page).nth(0);
    await expect(first).toHaveAttribute('data-role', 'ceo');
    await expect(first).toContainText('Add a worked example to this skill.');
    await expect(first).not.toContainText('CONTEXT-ECHO-MUST-NOT-RENDER');
    await expect(entries(page).nth(1)).toHaveAttribute('data-role', 'agent');
    // The published document stays the top of the page: the SKILL.md prose card
    // renders ABOVE the thread section (the CEO's boundary).
    const doc = await page.locator('.reading-col .card .prose').first().boundingBox();
    const thread = await page.locator('#doc-thread').boundingBox();
    expect(thread.y).toBeGreaterThan(doc.y);
    await expect(page.locator('#comment-box h2')).toHaveText('Add to this thread');
    // Empty state: box only, no thread chrome.
    await page.goto('/skills/e2e-external-skill');
    await expect(entries(page)).toHaveCount(0);
    await expect(page.locator('#doc-thread .thread-eyebrow')).toHaveCount(0);
    await expect(page.locator('#comment-box h2')).toHaveText('Add to this thread');
  });

  // @plan:test-plan-document-threads-n3 @promote
  test('TP-nexus-e2e-087 an agent page renders its thread and the box posts with the agents pageType, entry appearing without a reload', async ({ page, request }) => {
    await page.goto('/agents/e2e-orchestrator');
    await expect(entries(page)).toHaveCount(2);
    await expect(entries(page).nth(0)).toContainText('Tighten the dispatch rules.');
    await expect(entries(page).nth(1)).toContainText('Dispatch rules tightened.');

    const c = commentBox(page);
    await c.text.fill('And document the fallback chain.');
    await c.open.click();
    await c.confirm.click();
    await expect(c.status).toHaveText('Added to the thread — the reply lands here in about 15 minutes, and by email.');
    const posts = await capturedPosts(request);
    expect(posts).toHaveLength(1);
    expect(JSON.parse(posts[0].meta)).toMatchObject({ pageType: 'agents', slug: 'e2e-orchestrator' });
    await expect(entries(page)).toHaveCount(3);
    await expect(entries(page).nth(2)).toHaveAttribute('data-role', 'ceo');
    await expect(entries(page).nth(2)).toContainText('And document the fallback chain.');
  });

  // @plan:test-plan-document-threads-n3 @promote
  test('TP-nexus-e2e-088 a knowledge page renders its thread and posts with the NEW knowledge pageType', async ({ page, request }) => {
    await page.goto('/knowledge/claude-md');
    await expect(entries(page)).toHaveCount(2);
    await expect(entries(page).nth(0)).toContainText('Clarify the logging convention.');
    await expect(entries(page).nth(0)).not.toContainText('CONTEXT-ECHO-MUST-NOT-RENDER');
    await expect(entries(page).nth(1)).toContainText('Logging convention clarified in the doc.');

    const c = commentBox(page);
    await c.text.fill('Also cross-link SETUP.md.');
    await c.open.click();
    await c.confirm.click();
    await expect(c.status).toHaveText('Added to the thread — the reply lands here in about 15 minutes, and by email.');
    const posts = await capturedPosts(request);
    expect(posts).toHaveLength(1);
    expect(posts[0].kind).toBe('page-comment');
    expect(JSON.parse(posts[0].meta)).toMatchObject({ pageType: 'knowledge', slug: 'claude-md' });
    await expect(entries(page)).toHaveCount(3);
    await expect(entries(page).nth(2)).toContainText('Also cross-link SETUP.md.');
    // The empty knowledge doc keeps the box-only state.
    await page.goto('/knowledge/setup-md');
    await expect(entries(page)).toHaveCount(0);
    await expect(page.locator('#comment-box h2')).toHaveText('Add to this thread');
  });

  // @plan:test-plan-document-threads-n1 @promote
  test('TP-nexus-e2e-068 a digest page renders its per-digest thread below the digest body', async ({ page }) => {
    await page.goto('/digests/2026-01-02');
    await expect(entries(page)).toHaveCount(2);
    await expect(entries(page).nth(0)).toContainText('Expand the tech section tomorrow.');
    await expect(entries(page).nth(1)).toContainText("tomorrow's digest will go deeper on tech");
    // A digest date with no comments shows only the box.
    await page.goto('/digests/2026-01-03');
    await expect(entries(page)).toHaveCount(0);
    await expect(page.locator('#comment-box h2')).toHaveText('Add to this thread');
  });
});
