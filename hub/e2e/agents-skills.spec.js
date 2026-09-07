'use strict';

/**
 * The Claude section (Core/Agents/Skills/Features subtabs) in a real browser,
 * against the fixture .claude tree in e2e/fixtures/claude. Since
 * hn-nav-restructure-2026-08-15 the governing docs ("Knowledge") live on their
 * own /knowledge index — the Core subtab — instead of a card under /agents.
 * Test plans: hn-test-plan-2026-07-26-playwright-e2e,
 * hn-nav-restructure-2026-08-15 (central DB).
 */

const { test, expect } = require('@playwright/test');

test.describe('agents, skills and knowledge', () => {
  test('TP-nexus-e2e-030 the agents index lists agents with their model', async ({ page }) => {
    await page.goto('/agents');
    await page.waitForLoadState('networkidle');
    const body = page.locator('body');
    await expect(body).toContainText('e2e-orchestrator');
    await expect(body).toContainText('e2e-devops');
    await expect(body).toContainText('opus');
  });

  test('TP-nexus-e2e-031 an agent detail page renders frontmatter and body', async ({ page }) => {
    await page.goto('/agents');
    await page.locator('a', { hasText: 'e2e-orchestrator' }).first().click();
    await page.waitForLoadState('networkidle');
    await expect(page).toHaveURL(/\/agents\/e2e-orchestrator$/);
    await expect(page.locator('body')).toContainText('dispatches work in the browser test suite');
    await expect(page.locator('.card strong').first()).toHaveText('Dispatch');
  });

  test('TP-nexus-e2e-032 a knowledge doc detail renders by direct URL', async ({ page }) => {
    await page.goto('/knowledge/claude-md');
    await page.waitForLoadState('networkidle');
    await expect(page.locator('body')).toContainText('E2E fixture conventions');
    await expect(page.locator('.card strong').first()).toHaveText('log');
  });

  // @plan:hn-nav-restructure-2026-08-15 @promote
  test('TP-navr-005 /knowledge is the Core subtab: Claude lit, five subtabs, the governing docs listed', async ({ page }) => {
    await page.goto('/knowledge');
    await page.waitForLoadState('networkidle');
    // Top nav: the Claude tab owns this section.
    const active = page.locator('nav.sections a.active');
    await expect(active).toHaveCount(1);
    await expect(active).toHaveText('Claude');
    // The subtab bar, in order, with Core selected (Stations retired into the
    // Features matrix — features-ui-restructure-design C-1).
    await expect(page.locator('nav.subtabs a')).toHaveText(['Core', 'Agents', 'Skills', 'Features']);
    await expect(page.locator('nav.subtabs a.active')).toHaveText('Core');
    // The governing docs kept their two-line rows (keys + comment counts).
    const claudeMd = page.locator('ul.conv-index.two-line li', { hasText: 'claude-md' });
    await expect(claudeMd.locator('.meta-facts')).toHaveText('knowledge/claude-md');
    await expect(page.locator('body')).toContainText('SETUP.md');
  });

  // @plan:hn-nav-restructure-2026-08-15 @promote
  test('TP-navr-006 subtab selection follows the URL across the Claude section', async ({ page }) => {
    await page.goto('/knowledge');
    await page.waitForLoadState('networkidle');
    // Click-through: Core -> Agents -> Skills -> Features.
    for (const [label, url] of [
      ['Agents', /\/agents$/],
      ['Skills', /\/skills$/],
      ['Features', /\/features$/],
    ]) {
      await page.locator('nav.subtabs a', { hasText: label }).click();
      await page.waitForLoadState('networkidle');
      await expect(page).toHaveURL(url);
      await expect(page.locator('nav.subtabs a.active')).toHaveText(label);
      await expect(page.locator('nav.sections a.active')).toHaveText('Claude');
    }
    // Detail pages keep their subtab lit.
    await page.goto('/agents/e2e-orchestrator');
    await page.waitForLoadState('networkidle');
    await expect(page.locator('nav.subtabs a.active')).toHaveText('Agents');
    await page.goto('/knowledge/claude-md');
    await page.waitForLoadState('networkidle');
    await expect(page.locator('nav.subtabs a.active')).toHaveText('Core');
  });

  // @plan:hn-nav-restructure-2026-08-15 @promote
  test('TP-navr-009 the agents page no longer hosts the Knowledge card; the agents list is unchanged', async ({ page }) => {
    await page.goto('/agents');
    await page.waitForLoadState('networkidle');
    await expect(page.locator('.card h1', { hasText: 'Knowledge' })).toHaveCount(0);
    await expect(page.locator('body')).not.toContainText('claude-md');
    await expect(page.locator('.card:has(h1:text-is("Agents")) ul.conv-index li')).toHaveCount(2);
  });

  test('TP-nexus-e2e-033 the skills index lists every skill directory with a SKILL.md', async ({ page }) => {
    await page.goto('/skills');
    await page.waitForLoadState('networkidle');
    await expect(page.locator('body')).toContainText('e2e-internal-skill');
    await expect(page.locator('body')).toContainText('e2e-external-skill');
  });

  const PINNED_URL =
    'https://github.com/example-org/example-skills/tree/0123456789abcdef0123456789abcdef01234567/skills/e2e-external-skill';

  test('TP-nexus-e2e-034 + TP-skills-origin-008 a vendored skill shows its sha-pinned upstream source and description; an internal one shows neither', async ({ page }) => {
    await page.goto('/skills/e2e-external-skill');
    await page.waitForLoadState('networkidle');
    const link = page.locator(`a[href="${PINNED_URL}"]`);
    await expect(link).toBeVisible();
    await expect(page.locator('body')).toContainText('0123456');
    // Frontmatter description surfaces on the detail page (TP-skills-origin-008).
    await expect(page.locator('body')).toContainText('A vendored skill, used by the browser test suite');

    await page.goto('/skills/e2e-internal-skill');
    await page.waitForLoadState('networkidle');
    await expect(page.locator('a[href^="https://github.com/example-org"]')).toHaveCount(0);
    await expect(page.locator('body')).toContainText('A skill authored in this workspace');
  });

  test('TP-skills-origin-006 the skills index shows an origin chip per row; the external one is a new-tab link to the pinned tree', async ({ page }) => {
    await page.goto('/skills');
    await page.waitForLoadState('networkidle');
    const external = page.locator(`a.origin-chip[href="${PINNED_URL}"]`);
    await expect(external).toBeVisible();
    await expect(external).toHaveAttribute('target', '_blank');
    await expect(external).toHaveAttribute('rel', 'noopener noreferrer');
    // The internal skill's row carries a plain "workspace" chip and no GitHub anchor.
    const internalRow = page.locator('ul.conv-index li', { hasText: 'e2e-internal-skill' });
    await expect(internalRow.locator('.origin-chip')).toHaveText('workspace');
    await expect(internalRow.locator('a.origin-chip')).toHaveCount(0);
  });

  test('TP-skills-origin-007 the external chip does not hijack row navigation to the skill detail page', async ({ page }) => {
    await page.goto('/skills');
    await page.waitForLoadState('networkidle');
    await page.locator('a', { hasText: 'e2e-external-skill' }).first().click();
    await page.waitForLoadState('networkidle');
    await expect(page).toHaveURL(/\/skills\/e2e-external-skill$/);
  });

  test('TP-readme-summ-008 the skills index shows the curated README summary; the detail keeps the labeled frontmatter text', async ({ page }) => {
    await page.goto('/skills');
    await page.waitForLoadState('networkidle');
    const body = page.locator('body');
    await expect(body).toContainText('Curated external-skill summary from the fixture README table.');
    await expect(body).toContainText('Curated internal-skill summary from the fixture README table.');
    // The frontmatter trigger text stays off the index…
    await expect(body).not.toContainText('A vendored skill, used by the browser test suite');
    // …and stays on the detail page, clearly labeled as the routing contract.
    await page.goto('/skills/e2e-external-skill');
    await page.waitForLoadState('networkidle');
    await expect(page.locator('body')).toContainText('Trigger description (frontmatter)');
    await expect(page.locator('body')).toContainText('A vendored skill, used by the browser test suite');
  });

  test('TP-readme-summ-009 the agents index shows the curated README role; the detail keeps the labeled frontmatter text', async ({ page }) => {
    await page.goto('/agents');
    await page.waitForLoadState('networkidle');
    const body = page.locator('body');
    await expect(body).toContainText('Curated orchestrator role from the fixture README table.');
    await expect(body).toContainText('Curated devops role from the fixture README table.');
    await expect(body).not.toContainText('E2E fixture agent: dispatches work in the browser test suite');
    await page.goto('/agents/e2e-orchestrator');
    await page.waitForLoadState('networkidle');
    await expect(page.locator('body')).toContainText('Trigger description (frontmatter)');
    await expect(page.locator('body')).toContainText('E2E fixture agent: dispatches work in the browser test suite');
  });

  test('TP-nexus-e2e-036 + TP-readme-summ-011 every index row renders exactly its curated README summary, never the frontmatter fallback', async ({ page }) => {
    // Conversion of the manual case TP-readme-summ-011 (backlog 61): the fixture
    // README mirrors the real .claude/README.md shape — prose around the tables,
    // markdown + escaped `\|` pipes inside cells, `external — repo` origin cells,
    // a trailing non-table section. If readmeSummaries() trips on any of it, rows
    // silently fall back to the frontmatter trigger text and the exact-text
    // assertions below fail; the count assertions prove EVERY entry got a row.
    const skills = {
      'e2e-external-skill': 'Curated external-skill summary from the fixture README table.',
      'e2e-internal-skill':
        'Curated internal-skill summary from the fixture README table. Strips a link and an escaped a | b pipe.',
    };
    await page.goto('/skills');
    await page.waitForLoadState('networkidle');
    const skillRows = page.locator('ul.conv-index li');
    await expect(skillRows).toHaveCount(Object.keys(skills).length);
    for (const [name, summary] of Object.entries(skills)) {
      await expect(skillRows.filter({ hasText: name }).locator('.item-desc')).toHaveText(summary);
    }

    const agents = {
      'e2e-devops': 'Curated devops role from the fixture README table. Runs tests and CI.',
      'e2e-orchestrator': 'Curated orchestrator role from the fixture README table.',
    };
    await page.goto('/agents');
    await page.waitForLoadState('networkidle');
    // Scoped to the Agents card (the Knowledge list moved to /knowledge — Core).
    const agentRows = page.locator('.card:has(h1:text-is("Agents")) ul.conv-index li');
    await expect(agentRows).toHaveCount(Object.keys(agents).length);
    for (const [name, summary] of Object.entries(agents)) {
      await expect(agentRows.filter({ hasText: name }).locator('.item-desc')).toHaveText(summary);
    }
  });

  // @plan:test-plan-document-threads-n3 @promote
  test('TP-nexus-e2e-089 the Agents/Skills/Knowledge indexes are two-line rows with keys and comment counts, zero silent', async ({ page }) => {
    await page.goto('/agents');
    await page.waitForLoadState('networkidle');
    // Agents card: two-line idiom — the row key in the facts line, count right.
    const orchestrator = page.locator('.card:has(h1:text-is("Agents")) ul.conv-index.two-line li', { hasText: 'e2e-orchestrator' });
    await expect(orchestrator.locator('.meta-facts')).toHaveText('agents/e2e-orchestrator');
    await expect(orchestrator.locator('.thread-count')).toHaveText('2 comments');
    // Zero is silent (quiet ledger): no count node at all.
    const devops = page.locator('.card:has(h1:text-is("Agents")) ul.conv-index.two-line li', { hasText: 'e2e-devops' });
    await expect(devops.locator('.meta-facts')).toHaveText('agents/e2e-devops');
    await expect(devops.locator('.thread-count')).toHaveCount(0);
    // Knowledge rows carry their key + count too — on /knowledge (Core) since
    // hn-nav-restructure-2026-08-15.
    await page.goto('/knowledge');
    await page.waitForLoadState('networkidle');
    const claudeMd = page.locator('.card:has(h1:text-is("Knowledge")) ul.conv-index.two-line li', { hasText: 'claude-md' });
    await expect(claudeMd.locator('.meta-facts')).toHaveText('knowledge/claude-md');
    await expect(claudeMd.locator('.thread-count')).toHaveText('2 comments');

    await page.goto('/skills');
    await page.waitForLoadState('networkidle');
    const internal = page.locator('ul.conv-index.two-line li', { hasText: 'e2e-internal-skill' });
    await expect(internal.locator('.meta-facts')).toHaveText('skills/e2e-internal-skill');
    await expect(internal.locator('.thread-count')).toHaveText('2 comments');
    const external = page.locator('ul.conv-index.two-line li', { hasText: 'e2e-external-skill' });
    await expect(external.locator('.thread-count')).toHaveCount(0);
    // The curated summary survives the layout change (guards TP-nexus-e2e-036 content).
    await expect(internal.locator('.item-desc')).toContainText('Curated internal-skill summary');
  });

  test('TP-nexus-e2e-035 an unknown skill renders the 404 state', async ({ page }) => {
    const apiResponse = page.waitForResponse((r) => r.url().includes('/api/skills/no-such-skill'));
    await page.goto('/skills/no-such-skill');
    expect((await apiResponse).status()).toBe(404);
    await expect(page.locator('body')).toContainText(/not found/i);
  });
});
