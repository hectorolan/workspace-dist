'use strict';

/**
 * Page-comment box: the confirm-only-sends modal flow.
 *
 * This is the coverage gap the 2026-07-24 audit recorded as HN-G (backlog item 31):
 * the design contract "ONLY the modal's confirm sends" lives in an inline script in
 * partials/comment-box.ejs, so the node:test/supertest suite could only reach the
 * POST route directly and the modal itself was manual-only. Every branch of that
 * script is driven here in a real browser.
 * Test plan: hn-test-plan-2026-07-26-playwright-e2e (central DB).
 */

const { test, expect } = require('@playwright/test');
const { resetStub, capturedPosts, failNextPost, commentBox } = require('./helpers');

// The box is included on every content detail page; the plan page is representative
// and its slug is stable. Since document-threads N3 EVERY detail page runs the box
// in thread mode ("add to this thread") — the legacy presentation is retired.
const PAGE = '/plans/e2e-active-plan';
const THREAD_SENT = 'Added to the thread — the reply lands here in about 15 minutes, and by email.';

test.describe('page comments — confirm-only-sends modal', () => {
  test.beforeEach(async ({ page, request }) => {
    await resetStub(request);
    await page.goto(PAGE);
    await page.waitForLoadState('networkidle');
  });

  test('TP-nexus-e2e-040 an empty box refuses to open the modal and sends nothing', async ({ page, request }) => {
    const c = commentBox(page);
    await c.open.click();
    await expect(c.status).toHaveText('Type an instruction first.');
    await expect(c.modal).not.toBeVisible();
    expect(await capturedPosts(request)).toHaveLength(0);
  });

  test('TP-nexus-e2e-041 Send… opens the modal pre-filled and still sends nothing', async ({ page, request }) => {
    const c = commentBox(page);
    await c.text.fill('Please summarize this plan.');
    await c.open.click();
    await expect(c.modal).toBeVisible();
    await expect(c.modalText).toHaveValue('Please summarize this plan.');
    expect(await capturedPosts(request)).toHaveLength(0);
  });

  test('TP-nexus-e2e-042 Cancel closes the modal, sends nothing and keeps the typed text', async ({ page, request }) => {
    const c = commentBox(page);
    await c.text.fill('Draft a follow-up.');
    await c.open.click();
    await expect(c.modal).toBeVisible();
    await c.cancel.click();
    await expect(c.modal).not.toBeVisible();
    await expect(c.text).toHaveValue('Draft a follow-up.');
    expect(await capturedPosts(request)).toHaveLength(0);
  });

  test('TP-nexus-e2e-043 Escape dismisses the modal and sends nothing', async ({ page, request }) => {
    const c = commentBox(page);
    await c.text.fill('Escape must not send.');
    await c.open.click();
    await expect(c.modal).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(c.modal).not.toBeVisible();
    await expect(c.text).toHaveValue('Escape must not send.');
    expect(await capturedPosts(request)).toHaveLength(0);
  });

  test('TP-nexus-e2e-044 Confirm sends exactly one comment, clears the box and reports success', async ({ page, request }) => {
    const c = commentBox(page);
    await c.text.fill('Turn this plan into tasks.');
    await c.open.click();
    await c.confirm.click();
    await expect(c.status).toHaveText(THREAD_SENT);
    await expect(c.text).toHaveValue('');
    await expect(c.modal).not.toBeVisible();

    const posts = await capturedPosts(request);
    expect(posts).toHaveLength(1);
    expect(posts[0].kind).toBe('page-comment');
    expect(posts[0].subject).toContain('plans/e2e-active-plan');
    expect(posts[0].body).toContain('Turn this plan into tasks.');
    // Page context is re-fetched server-side, never supplied by the browser.
    expect(posts[0].body).toContain('Body text with **bold**');
    expect(JSON.parse(posts[0].meta)).toMatchObject({ source: 'hub', pageType: 'plans', slug: 'e2e-active-plan' });
    // The API key stays on the server, but the request that carries it is the server's.
    expect(posts[0].apiKey).toBe('e2e-api-key');
  });

  test('TP-nexus-e2e-045 edits made in the modal are what gets sent', async ({ page, request }) => {
    const c = commentBox(page);
    await c.text.fill('First draft.');
    await c.open.click();
    await c.modalText.fill('Final wording only.');
    await c.confirm.click();
    await expect(c.status).toHaveText(THREAD_SENT);

    const posts = await capturedPosts(request);
    expect(posts).toHaveLength(1);
    expect(posts[0].body).toContain('Final wording only.');
    expect(posts[0].body).not.toContain('First draft.');
  });

  test('TP-nexus-e2e-046 a failed send reports the error and keeps the text for a retry', async ({ page, request }) => {
    await failNextPost(request);
    const c = commentBox(page);
    await c.text.fill('This send will fail.');
    await c.open.click();
    await c.confirm.click();
    await expect(c.status).toContainText('NOT sent');
    await expect(c.text).toHaveValue('This send will fail.');
    expect(await capturedPosts(request)).toHaveLength(0);

    // The retry works and nothing was lost.
    await c.open.click();
    await c.confirm.click();
    await expect(c.status).toHaveText(THREAD_SENT);
    expect(await capturedPosts(request)).toHaveLength(1);
  });

  test('TP-nexus-e2e-047 the in-flight guard prevents a double send', async ({ page, request }) => {
    // Hold the POST open so the second click lands while the first is in flight.
    let release;
    const held = new Promise((resolve) => { release = resolve; });
    await page.route('**/page-comments', async (route) => {
      await held;
      await route.continue();
    });

    const c = commentBox(page);
    await c.text.fill('Only once, please.');
    await c.open.click();
    await c.confirm.click();
    await expect(c.status).toHaveText('Sending…');
    await expect(c.open).toBeDisabled();
    await expect(c.confirm).toBeDisabled();
    release();

    await expect(c.status).toHaveText(THREAD_SENT);
    expect(await capturedPosts(request)).toHaveLength(1);
  });

  test('TP-nexus-e2e-048 the box is present on every content detail page and carries that page identity', async ({ page, request }) => {
    const pages = [
      ['/digests/2026-01-02', 'digests', '2026-01-02'],
      // Conversation pages run in thread mode since N2 (their thread renders below).
      ['/conversations/4001', 'conversations', '4001'],
      // Agents/skills/knowledge joined thread mode with N3 (knowledge is the new pageType).
      ['/agents/e2e-devops', 'agents', 'e2e-devops'],
      ['/skills/e2e-internal-skill', 'skills', 'e2e-internal-skill'],
      ['/knowledge/claude-md', 'knowledge', 'claude-md'],
    ];
    for (const [url, pageType, slug] of pages) {
      await page.goto(url);
      await page.waitForLoadState('networkidle');
      const c = commentBox(page);
      await expect(c.box).toHaveAttribute('data-page-type', pageType);
      await expect(c.box).toHaveAttribute('data-slug', slug);
      await c.text.fill(`Comment on ${pageType}.`);
      await c.open.click();
      await c.confirm.click();
      await expect(c.status).toHaveText(THREAD_SENT);
    }
    const posts = await capturedPosts(request);
    expect(posts).toHaveLength(5);
    expect(posts.map((p) => JSON.parse(p.meta).pageType)).toEqual(['digests', 'conversations', 'agents', 'skills', 'knowledge']);
  });
});
