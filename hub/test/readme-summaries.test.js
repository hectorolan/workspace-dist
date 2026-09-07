'use strict';

// Curated README-table summaries for the Agents/Skills indexes
// (central-DB test plan hn-test-plan-2026-07-26-readme-summaries).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const request = require('supertest');
const { readmeSummaries } = require('../src/lib/claude-workspace');
const { makeApp, makeClaudeDir } = require('./helpers');

const asOwner = (overrides = {}) => makeApp({ authBypass: true, ...overrides });

/** A bare temp dir with just a README.md — parser-level tests. */
function dirWithReadme(content) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-readme-'));
  if (content !== null) fs.writeFileSync(path.join(dir, 'README.md'), content);
  return dir;
}

test('TP-readme-summ-001: parser maps name → summary cell; header matched case-insensitively', () => {
  const dir = dirWithReadme(`# Index

Some prose, then a table:

| Skill | Origin | WHAT IT DOES |
|---|---|---|
| \`one\` | workspace | Does one thing. |
| \`two\` | external | Does two things. |
`);
  assert.deepEqual(readmeSummaries(dir, 'What it does'), {
    one: 'Does one thing.',
    two: 'Does two things.',
  });
});

test('TP-readme-summ-002: escaped pipes split correctly and become literal | in the cell', () => {
  const dir = dirWithReadme(`| Skill | Origin | What it does |
|---|---|---|
| \`piped\` | workspace | Runs \`a \\| b\` and keeps going. |
`);
  assert.deepEqual(readmeSummaries(dir, 'What it does'), {
    piped: 'Runs a | b and keeps going.',
  });
});

test('TP-readme-summ-003: markdown stripped to plain text (code spans, bold, italics, links)', () => {
  const dir = dirWithReadme(`| Agent | Model | Role |
|---|---|---|
| \`fancy\` | opus | Handles **bold**, *italic*, \`code\`, and [linked](https://example.com) words. |
`);
  assert.deepEqual(readmeSummaries(dir, 'Role'), {
    fancy: 'Handles bold, italic, code, and linked words.',
  });
});

test('TP-readme-summ-004: summary column found by header name wherever it sits', () => {
  const dir = dirWithReadme(`## Reordered

| Skill | What it does | Origin |
|---|---|---|
| \`moved\` | Summary in the middle column. | workspace |

## Decoy table without the header

| Thing | Notes |
|---|---|
| \`moved\` | Not a summary. |
`);
  assert.deepEqual(readmeSummaries(dir, 'What it does'), {
    moved: 'Summary in the middle column.',
  });
});

test('TP-readme-summ-005: missing README or no matching table → empty map, never throws', () => {
  assert.deepEqual(readmeSummaries(dirWithReadme(null), 'What it does'), {});
  assert.deepEqual(readmeSummaries(dirWithReadme('# No tables here\n\nJust prose.\n'), 'What it does'), {});
  // Malformed rows (missing cells) are skipped, well-formed neighbors survive.
  const dir = dirWithReadme(`| Skill | Origin | What it does |
|---|---|---|
| \`short-row\` |
| \`fine\` | workspace | Survives its malformed neighbor. |
`);
  assert.deepEqual(readmeSummaries(dir, 'What it does'), {
    fine: 'Survives its malformed neighbor.',
  });
});

test('TP-readme-summ-006: /api/skills carries README summary; row-less skill falls back to frontmatter', async () => {
  const res = await request(asOwner()).get('/api/skills');
  assert.equal(res.status, 200);
  const byName = Object.fromEntries(res.body.skills.map((s) => [s.name, s]));
  // skill-one has a README row (with markdown + escaped pipe) — summary is its plain text.
  assert.equal(byName['skill-one'].summary, 'Curated skill-one summary with a | pipe, code, and a link.');
  assert.match(byName['skill-one'].description, /skill-one skill/, 'frontmatter description still in the payload');
  // skill-two has no README row — summary degrades to the frontmatter description.
  assert.equal(byName['skill-two'].summary, byName['skill-two'].description);
});

test('TP-readme-summ-007: /api/agents carries README Role summary; row-less agent falls back to frontmatter', async () => {
  const res = await request(asOwner()).get('/api/agents');
  assert.equal(res.status, 200);
  const byName = Object.fromEntries(res.body.agents.map((a) => [a.name, a]));
  assert.equal(byName.alpha.summary, 'Curated alpha role from the README table.');
  assert.match(byName.alpha.description, /alpha agent/, 'frontmatter description still in the payload');
  assert.equal(byName.beta.summary, byName.beta.description);
});

test('TP-readme-summ-005 (API half): deleted README never breaks either index', async () => {
  const dir = makeClaudeDir();
  fs.rmSync(path.join(dir, 'README.md'));
  const skills = await request(asOwner({ workspaceClaudeDir: dir })).get('/api/skills');
  assert.equal(skills.status, 200);
  assert.ok(skills.body.skills.every((s) => s.summary === s.description), 'all summaries degrade to frontmatter');
  const agents = await request(asOwner({ workspaceClaudeDir: dir })).get('/api/agents');
  assert.equal(agents.status, 200);
  assert.ok(agents.body.agents.every((a) => a.summary === a.description));
});
