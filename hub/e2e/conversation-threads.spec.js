'use strict';

/**
 * Document threads N2 in a real browser (design: central-DB plan
 * nexus-document-threads-design; test plan test-plan-document-threads-n2):
 * thread-entry counts on the Documents indexes (zero silent), the merged
 * conversation listing (document-less threads + legacy email conversations),
 * the compose box that starts a conversation through the confirm modal, and
 * the thread-only conversation page. Since hn-documents-subtabs-2026-08-15 the
 * listing lives on /conversations (the Documents subtab) and the old
 * `/plans?kind=conversation` URL redirects there — the reverse of the N2-era
 * redirect, with every guarantee carried over.
 */

const { test, expect } = require('@playwright/test');
const { resetStub, capturedPosts, commentBox } = require('./helpers');

test.describe('conversations on the Documents tab (N2)', () => {
  test.beforeEach(async ({ request }) => {
    await resetStub(request);
  });

  // @plan:test-plan-document-threads-n2 @promote
  // Updated by hn-documents-subtabs-2026-08-15: the rows moved to their
  // subtabs; the count join must survive on each of them.
  test('TP-nexus-e2e-069 Documents index rows show thread counts; a row without a thread shows none', async ({ page }) => {
    const rowFor = (title) => page.locator('ul.conv-index li', { hasText: title });
    await page.goto('/plans');
    await page.waitForLoadState('networkidle');
    await expect(rowFor('E2E active plan').locator('.thread-count')).toHaveText('2 comments');
    await page.goto('/tests');
    await page.waitForLoadState('networkidle');
    await expect(rowFor('E2E hub test plan').locator('.thread-count')).toHaveText('3 comments');
    // Zero is silent: the done design (no thread, a Records row) shows none.
    await page.goto('/records');
    await page.waitForLoadState('networkidle');
    await expect(rowFor('E2E done plan')).toBeVisible();
    await expect(rowFor('E2E done plan').locator('.thread-count')).toHaveCount(0);
  });

  // @plan:test-plan-document-threads-n2 @promote
  test('TP-nexus-e2e-070 the Conversations subtab lists both populations and each opens its own shape', async ({ page }) => {
    await page.goto('/conversations');
    await page.waitForLoadState('networkidle');

    const rows = page.locator('ul.conv-index li');
    await expect(rows).toHaveCount(2);
    // Newest activity first: the page-born thread (2026-01-03) over legacy (2026-01-02).
    await expect(rows.nth(0)).toContainText('Wire the beach house alarm');
    await expect(rows.nth(1)).toContainText('E2E active thread');
    // The archived legacy conversation stays out of the listing.
    await expect(page.locator('ul.conv-index')).not.toContainText('E2E archived thread');

    // Page-born row -> thread-only page: the thread IS the content, no document
    // body. The row link, not the artifact chip beside it (TP-convarch-010).
    await rows.nth(0).locator('a:not(.artifact-chip)').click();
    await page.waitForLoadState('networkidle');
    await expect(page).toHaveURL(/\/conversations\/conv-8100$/);
    // toContainText: the h1 also carries the archive StatusBadge (TP-convarch-011).
    await expect(page.locator('.card h1')).toContainText('Wire the beach house alarm');
    const entries = page.locator('#doc-thread article.thread-entry');
    await expect(entries).toHaveCount(2);
    await expect(entries.nth(0)).toHaveAttribute('data-role', 'ceo');
    // The instruction-only opener renders bare — no contract scaffolding.
    await expect(entries.nth(0)).toContainText('Wire the beach house alarm to the dashboard.');
    await expect(entries.nth(0)).not.toContainText('## Instruction');
    await expect(entries.nth(1)).toHaveAttribute('data-role', 'agent');

    // Legacy row -> the read-only transcript page (again: the row link, not
    // the artifact chip).
    await page.goto('/conversations');
    await page.locator('ul.conv-index li', { hasText: 'E2E active thread' }).locator('a:not(.artifact-chip)').click();
    await page.waitForLoadState('networkidle');
    await expect(page).toHaveURL(/\/conversations\/4001$/);
    await expect(page.locator('.card h1')).toContainText('E2E active thread');
  });

  // @plan:test-plan-document-threads-n2 @promote
  test('TP-nexus-e2e-071 the compose box starts a conversation via the confirm modal and lands on its thread', async ({ page, request }) => {
    await page.goto('/conversations');
    await page.waitForLoadState('networkidle');
    await expect(page.locator('#comment-box h2')).toHaveText('Start a conversation');

    const c = commentBox(page);
    await c.text.fill('Compare **fiber** providers for the office.');
    await c.open.click();
    await expect(c.modal).toBeVisible();
    await c.confirm.click();

    // Same intake machinery as every comment: one page-comment message whose
    // meta anchors it to its own conversation ref — and NO page-context section.
    await expect(page).toHaveURL(/\/conversations\/conv-\d+$/);
    const posts = await capturedPosts(request);
    expect(posts).toHaveLength(1);
    expect(posts[0].kind).toBe('page-comment');
    const meta = JSON.parse(posts[0].meta);
    expect(meta.pageType).toBe('conversations');
    expect(meta.slug).toMatch(/^conv-\d+$/);
    expect(posts[0].body).toContain('Compare **fiber** providers');
    expect(posts[0].body).not.toContain('## Page context');

    // The thread-only page shows the CEO opening entry (intake wrote it synchronously).
    const entries = page.locator('#doc-thread article.thread-entry');
    await expect(entries).toHaveCount(1);
    await expect(entries.nth(0)).toHaveAttribute('data-role', 'ceo');
    await expect(entries.nth(0)).toContainText('Compare fiber providers for the office.');
  });

  // @plan:test-plan-document-threads-n2 @promote
  // Reversed by hn-documents-subtabs-2026-08-15 (TP-docsub-015): /conversations
  // is a real page again (the fourth Documents subtab) and the N2-era
  // /plans?kind=conversation URL redirects HERE — old bookmarks never 404.
  test('TP-nexus-e2e-072 /plans?kind=conversation redirects to the Conversations subtab; no top-level nav entry', async ({ page }) => {
    await page.goto('/plans?kind=conversation');
    await page.waitForLoadState('networkidle');
    await expect(page).toHaveURL(/\/conversations$/);
    await expect(page.locator('ul.conv-index')).toContainText('E2E active thread');

    // No Conversations nav entry; Documents is the active section on conversation pages.
    await expect(page.locator('nav.sections a', { hasText: 'Conversations' })).toHaveCount(0);
    await page.goto('/conversations/4001');
    await page.waitForLoadState('networkidle');
    await expect(page.locator('nav.sections a', { hasText: 'Documents' })).toHaveClass(/active/);
  });

  // @plan:test-plan-document-threads-n2 @promote
  test('TP-nexus-e2e-073 a legacy conversation renders its transcript read-only plus its document thread', async ({ page }) => {
    await page.goto('/conversations/4001');
    await page.waitForLoadState('networkidle');
    // The transcript, from the /conversation store (never migrated).
    await expect(page.locator('.card h1')).toContainText('E2E active thread');
    await expect(page.locator('article.msg:not(.thread-entry)')).toHaveCount(2);
    // Its document thread (numeric anchor) + the thread-mode box below.
    const entries = page.locator('#doc-thread article.thread-entry');
    await expect(entries).toHaveCount(2);
    await expect(entries.nth(0)).toContainText('Keep this thread warm.');
    await expect(entries.nth(1)).toContainText('Warm and threaded.');
    await expect(page.locator('#comment-box h2')).toHaveText('Add to this thread');
  });

  // @plan:test-plan-two-line-index-rows
  test('TP-nexus-e2e-077 conversation rows carry their key: conversations/<ref>, date first, two lines', async ({ page }) => {
    await page.goto('/conversations');
    await page.waitForLoadState('networkidle');
    const rowFor = (title) => page.locator('ul.conv-index li', { hasText: title });
    // Page-born and legacy rows both show their key (the gap the CEO called out).
    await expect(rowFor('Wire the beach house alarm').locator('.meta-facts')).toHaveText(
      /^\d{4}-\d{2}-\d{2} · conversations\/conv-8100$/
    );
    await expect(rowFor('E2E active thread').locator('.meta-facts')).toHaveText(
      /^\d{4}-\d{2}-\d{2} · conversations\/4001$/
    );
    // Two lines here too: meta below the title block.
    const row = rowFor('Wire the beach house alarm');
    const title = await row.locator('.conv-title').boundingBox();
    const meta = await row.locator('.conv-meta').boundingBox();
    expect(meta.y).toBeGreaterThanOrEqual(title.y + title.height - 1);
  });

  // _2: PR #33's navigation.spec.js claimed 080 first — suffix, never renumber
  // (CEO 2026-08-02; grammar: workspace cli/util/baseline.js CASE_ID_SOURCE).
  // @plan:test-plan-thread-entry-provenance @promote
  test('TP-nexus-e2e-080_2 conversation pages render provenance keys on their thread entries', async ({ page }) => {
    // The conversation view's own thread page: keys on opener and reply. The
    // fixture carries the piece-1 shape (both messages ride backing
    // conversation 4101 — archive state lives there); the null-conversation
    // provenance shape stays covered by TP-nexus-e2e-079_2 on plan pages.
    await page.goto('/conversations/conv-8100');
    await page.waitForLoadState('networkidle');
    const entries = page.locator('#doc-thread article.thread-entry');
    await expect(entries.nth(0).locator('.prov')).toHaveText('conversations/4101 · message 708 · page-comment');
    await expect(entries.nth(1).locator('.prov')).toHaveText('conversations/4101 · message 709 · inbox-reply');
    // A legacy conversation's doc thread carries keys too.
    await page.goto('/conversations/4001');
    await page.waitForLoadState('networkidle');
    const legacy = page.locator('#doc-thread article.thread-entry');
    await expect(legacy.nth(1).locator('.prov')).toHaveText('conversations/27 · message 711 · inbox-reply');
  });

  // TP-nexus-e2e-074 (digest picker counts) retired with the digest index page
  // (backlog item 70): the picker is gone and per-date counts moved to the index
  // rows — covered by TP-nexus-e2e-079 in navigation.spec.js.
});
