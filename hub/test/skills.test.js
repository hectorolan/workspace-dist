'use strict';

// Skills API suite (TP-agents-skills-009..012 + TP-skill-upstream-* carried over;
// JSON surface since the React refactor — central-DB test plan
// hn-test-plan-2026-07-26-react-refactor, TP-react-017).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const request = require('supertest');
const { makeApp, makeClaudeDir } = require('./helpers');

const asOwner = (overrides = {}) => makeApp({ authBypass: true, ...overrides });

test('TP-agents-skills-009: skills list sorted, non-skill dirs and stray files skipped', async () => {
  const res = await request(asOwner()).get('/api/skills');
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.skills.map((s) => s.name), ['skill-one', 'skill-two'], 'sorted; no-skill-here and notes.md skipped');
  assert.match(res.body.skills[0].description, /skill-one skill/);
});

test('TP-agents-skills-010: skill detail carries sanitized html; internal skill has null upstream', async () => {
  const res = await request(asOwner()).get('/api/skills/skill-one');
  assert.equal(res.status, 200);
  const s = res.body.skill;
  assert.equal(s.name, 'skill-one');
  assert.match(s.html, /<strong>bold text<\/strong>/);
  assert.equal(s.upstream, null, 'no sources.json entry = internal skill, no source line');
  assert.ok(!('source' in s), 'raw file content stays server-side');
});

test('TP-agents-skills-011: unknown/path-shaped skill name → 404 (listing whitelist = traversal guard)', async () => {
  for (const bad of ['no-such-skill', '..%2F..%2Fetc', 'no-skill-here']) {
    const res = await request(asOwner()).get(`/api/skills/${bad}`);
    assert.equal(res.status, 404, `expected 404 for ${bad}`);
  }
});

const SHA = '0123456789abcdef0123456789abcdef01234567';
const pinOne = (dir, entry) =>
  fs.writeFileSync(
    path.join(dir, 'skills', 'sources.json'),
    JSON.stringify({ skills: { 'skill-one': { repo: 'example-org/example-skills', path: 'skills/skill-one', sha: SHA, ...entry } } })
  );

test('TP-skill-upstream-001 + TP-skills-origin-002: vendored skill exposes repo/path/shaShort + sha-pinned GitHub URL', async () => {
  const dir = makeClaudeDir();
  pinOne(dir);
  const res = await request(asOwner({ workspaceClaudeDir: dir })).get('/api/skills/skill-one');
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.skill.upstream, {
    repo: 'example-org/example-skills',
    path: 'skills/skill-one',
    shaShort: '0123456',
    url: `https://github.com/example-org/example-skills/tree/${SHA}/skills/skill-one`,
  });
  // The sibling skill has no entry — still internal.
  const other = await request(asOwner({ workspaceClaudeDir: dir })).get('/api/skills/skill-two');
  assert.equal(other.body.skill.upstream, null);
});

test('TP-skills-origin-001: the index carries upstream for vendored skills and null for internal ones', async () => {
  const dir = makeClaudeDir();
  pinOne(dir);
  const res = await request(asOwner({ workspaceClaudeDir: dir })).get('/api/skills');
  assert.equal(res.status, 200);
  const byName = Object.fromEntries(res.body.skills.map((s) => [s.name, s]));
  assert.equal(byName['skill-one'].upstream.url, `https://github.com/example-org/example-skills/tree/${SHA}/skills/skill-one`);
  assert.equal(byName['skill-one'].upstream.shaShort, '0123456');
  assert.equal(byName['skill-two'].upstream, null, 'no sources.json entry = workspace-authored');
  assert.match(byName['skill-one'].description, /skill-one skill/, 'description still on the index');
});

test('TP-skills-origin-003: entry without a sha degrades to tree/main, never breaks', async () => {
  const dir = makeClaudeDir();
  pinOne(dir, { sha: undefined });
  const res = await request(asOwner({ workspaceClaudeDir: dir })).get('/api/skills');
  assert.equal(res.status, 200);
  const one = res.body.skills.find((s) => s.name === 'skill-one');
  assert.equal(one.upstream.url, 'https://github.com/example-org/example-skills/tree/main/skills/skill-one');
  assert.equal(one.upstream.shaShort, '');
});

test('TP-skill-upstream-002 + TP-skills-origin-004: malformed sources.json never breaks detail or index', async () => {
  const dir = makeClaudeDir();
  fs.writeFileSync(path.join(dir, 'skills', 'sources.json'), '{ broken json');
  const res = await request(asOwner({ workspaceClaudeDir: dir })).get('/api/skills/skill-one');
  assert.equal(res.status, 200);
  assert.equal(res.body.skill.upstream, null);
  const index = await request(asOwner({ workspaceClaudeDir: dir })).get('/api/skills');
  assert.equal(index.status, 200);
  assert.ok(index.body.skills.every((s) => s.upstream === null), 'index degrades to all-internal');
});

test('TP-skills-origin-005: detail JSON shape is exactly {name, description, html, upstream}', async () => {
  const dir = makeClaudeDir();
  pinOne(dir);
  const res = await request(asOwner({ workspaceClaudeDir: dir })).get('/api/skills/skill-one');
  assert.equal(res.status, 200);
  assert.deepEqual(Object.keys(res.body.skill).sort(), ['description', 'html', 'name', 'upstream']);
  assert.match(res.body.skill.description, /skill-one skill/);
});

test('TP-agents-skills-012: missing skills dir → empty list, page still serves; unauthenticated gets 401', async () => {
  const dir = makeClaudeDir();
  fs.rmSync(path.join(dir, 'skills'), { recursive: true });
  const res = await request(asOwner({ workspaceClaudeDir: dir })).get('/api/skills');
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.skills, []);
  const unauth = await request(makeApp()).get('/api/skills');
  assert.equal(unauth.status, 401);
});

// ---- document threads N3: comment counts on the skills index -------------------
// (central-DB test plan test-plan-document-threads-n3)

const http = require('node:http');

// @plan:test-plan-document-threads-n3 @promote
test('TP-agents-skills-014: /api/skills joins comment counts best-effort; zero-count rows have no field', async () => {
  const server = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ ok: true, threads: [{ doc_kind: 'skill', doc_ref: 'skill-one', entries: 3 }] }));
  });
  const url = await new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`));
  });
  try {
    const res = await request(asOwner({ logApiUrl: url, logApiKey: 'k' })).get('/api/skills');
    assert.equal(res.status, 200);
    const byName = Object.fromEntries(res.body.skills.map((s) => [s.name, s]));
    assert.equal(byName['skill-one'].comments, 3);
    assert.ok(!('comments' in byName['skill-two']), 'zero is silent — no field (quiet ledger)');
  } finally {
    server.close();
  }
  // Unconfigured log API: the section still serves, rows just carry no counts.
  const unconfigured = await request(asOwner()).get('/api/skills');
  assert.equal(unconfigured.status, 200);
  assert.ok(unconfigured.body.skills.every((s) => !('comments' in s)));
});
