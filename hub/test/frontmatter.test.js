'use strict';

// YAML block-scalar frontmatter support (central-DB test plan
// hn-test-plan-2026-07-26-readme-summaries, TP-readme-summ-012..014): real skills
// write `description: >` / `>-`, which the same-line-only parser rendered as
// literally ">" on the detail pages (bug found by the CEO on the live Skills page).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { parseFrontmatter, listAgents, listSkills } = require('../src/lib/claude-workspace');
const { makeClaudeDir } = require('./helpers');

const wrap = (frontmatter) => `---\n${frontmatter}\n---\n\nBody.\n`;

test('TP-readme-summ-012a: folded block scalar `>` — the cicd/jest shape — captures the full text', () => {
  const { meta } = parseFrontmatter(
    wrap(['name: cicd-like', 'description: >', '  Generates CI/CD pipeline configurations,', '  across two source lines.', 'model: opus'].join('\n'))
  );
  assert.equal(meta.description, 'Generates CI/CD pipeline configurations, across two source lines.\n', 'folded joins with spaces; default chomping clips to one trailing newline');
  assert.equal(meta.name, 'cicd-like', 'same-line keys around the block still parse');
  assert.equal(meta.model, 'opus', 'a non-indented key line ends the block scalar');
});

test('TP-readme-summ-012b: folded-strip `>-` — the cloud-solution-architect shape — no trailing newline', () => {
  const { meta } = parseFrontmatter(
    wrap(['name: csa-like', 'description: >-', '  Transform the agent into an architect.', '  Use when designing cloud architectures.'].join('\n'))
  );
  assert.equal(meta.description, 'Transform the agent into an architect. Use when designing cloud architectures.');
});

test('TP-readme-summ-012c: literal `|` and `|-` keep line breaks; blank lines fold to paragraph breaks in `>`', () => {
  const literal = parseFrontmatter(wrap(['description: |', '  line one', '  line two'].join('\n'))).meta;
  assert.equal(literal.description, 'line one\nline two\n');
  const literalStrip = parseFrontmatter(wrap(['description: |-', '  line one', '  line two'].join('\n'))).meta;
  assert.equal(literalStrip.description, 'line one\nline two');
  const folded = parseFrontmatter(wrap(['description: >-', '  para one a', '  para one b', '', '  para two'].join('\n'))).meta;
  assert.equal(folded.description, 'para one a para one b\npara two', 'blank line = paragraph break, folded style');
});

test('TP-readme-summ-012d: regression — single-line and quoted values still parse as before', () => {
  const { meta } = parseFrontmatter(wrap(['name: plain', 'description: "quoted: with a colon"', 'tools: Read, Bash'].join('\n')));
  assert.equal(meta.description, 'quoted: with a colon');
  assert.equal(meta.tools, 'Read, Bash');
});

/** The sanity net: every description parses to real text, never a stray indicator. */
function assertDescriptionsSane(items, label) {
  assert.ok(items.length > 0, `${label}: tree listed`);
  for (const it of items) {
    assert.ok(it.description.trim().length > 0, `${label} ${it.name}: description non-empty`);
    assert.ok(!/^[>|]/.test(it.description.trim()), `${label} ${it.name}: description must not start with a block-scalar indicator`);
  }
}

test('TP-readme-summ-013: fixture-tree net — every agent/skill description is non-empty, no ">"/"|" leak', () => {
  const dir = makeClaudeDir(); // beta and skill-two use block scalars (helpers.js)
  assertDescriptionsSane(listAgents(dir), 'agent');
  assertDescriptionsSane(listSkills(dir), 'skill');
  const two = listSkills(dir).find((s) => s.name === 'skill-two');
  assert.match(two.description, /folded across two source lines/, 'the full folded text, not ">-"');
});

test('TP-readme-summ-014: real workspace .claude tree net (skipped where the sibling repo is absent, e.g. CI)', (t) => {
  const real = path.resolve(__dirname, '..', '..', 'workspace', '.claude');
  if (!fs.existsSync(real)) return t.skip('sibling workspace repo not present');
  assertDescriptionsSane(listAgents(real), 'real agent');
  assertDescriptionsSane(listSkills(real), 'real skill');
});
