'use strict';

// The index-row template's pure mapping seam (central-DB test plan
// test-plan-index-row-template). Every two-line index row renders through
// client/src/components/IndexRow.jsx; the string mapping it applies lives in
// row-format.mjs precisely so this suite can pin its edges without a JSX
// transform — the component's DOM stays pinned by the Playwright cases the
// plan lists under Regression (TP-nexus-e2e-075..078, 089). The module is ESM
// (Vite client code); this CJS suite reaches it via dynamic import.

const test = require('node:test');
const assert = require('node:assert/strict');

const mod = () => import('../client/src/components/row-format.mjs');

test('TP-index-template-001 metaFacts joins date · key, truncating ISO stamps to the date', async () => {
  const { metaFacts } = await mod();
  // Plans rows feed updated_at (full ISO stamp) — the facts line shows the date only.
  assert.equal(metaFacts('2026-08-02T09:15:00.000Z', 'e2e-active-plan'), '2026-08-02 · e2e-active-plan');
  // Digest rows feed a bare date — passes through unchanged.
  assert.equal(metaFacts('2026-01-03', 'digests/2026-01-03'), '2026-01-03 · digests/2026-01-03');
});

test('TP-index-template-002 metaFacts without a date is the key alone — no separator', async () => {
  const { metaFacts } = await mod();
  // Filesystem-backed rows (agents/skills/knowledge) carry no date.
  assert.equal(metaFacts(undefined, 'agents/orchestrator'), 'agents/orchestrator');
  assert.equal(metaFacts(null, 'skills/webapp-testing'), 'skills/webapp-testing');
  assert.equal(metaFacts('', 'knowledge/claude-md'), 'knowledge/claude-md');
});

test('TP-index-template-003 conversation refs pass through verbatim — the template never re-derives a key', async () => {
  const { metaFacts } = await mod();
  // Page-born (conv-<epoch-ms>) and legacy (numeric) keys are caller-built.
  assert.equal(metaFacts('2026-08-01T10:00:00Z', 'conversations/conv-8100'), '2026-08-01 · conversations/conv-8100');
  assert.equal(metaFacts('2026-07-30', 'conversations/4001'), '2026-07-30 · conversations/4001');
});

test('TP-index-template-004 countLabel: silent at zero, singular at one, plural above', async () => {
  const { countLabel } = await mod();
  // Zero (and absent) stays silent — the quiet-ledger convention.
  assert.equal(countLabel(0), '');
  assert.equal(countLabel(undefined), '');
  assert.equal(countLabel(null), '');
  assert.equal(countLabel(1), '1 comment');
  assert.equal(countLabel(2), '2 comments');
});
