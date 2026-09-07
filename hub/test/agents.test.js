'use strict';

// Agents/Knowledge API suite (TP-agents-skills-* IDs carried over from the EJS
// era; JSON surface since the React refactor — central-DB test plan
// hn-test-plan-2026-07-26-react-refactor, TP-react-017).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const request = require('supertest');
const { makeApp, makeClaudeDir } = require('./helpers');

const asOwner = (overrides = {}) => makeApp({ authBypass: true, ...overrides });

test('TP-agents-skills-001: agents list sorted by name, README skipped, frontmatter meta included', async () => {
  const res = await request(asOwner()).get('/api/agents');
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.agents.map((a) => a.name), ['alpha', 'beta'], 'sorted, README.md skipped');
  const alpha = res.body.agents[0];
  assert.equal(alpha.model, 'fable');
  assert.match(alpha.description, /alpha agent/);
});

test('TP-agents-skills-002: agent detail carries frontmatter meta + sanitized html body', async () => {
  const res = await request(asOwner()).get('/api/agents/alpha');
  assert.equal(res.status, 200);
  const a = res.body.agent;
  assert.equal(a.name, 'alpha');
  assert.equal(a.model, 'fable');
  assert.equal(a.tools, 'Read, Write, Bash');
  assert.match(a.html, /<strong>Bold rule<\/strong>/, 'markdown rendered');
  assert.doesNotMatch(a.html, /^---/, 'frontmatter not rendered into the body');
  assert.ok(!('source' in a), 'raw file content stays server-side');
});

test('TP-react-017b: CRLF agent files (autocrlf checkouts) parse frontmatter correctly', async () => {
  const dir = makeClaudeDir();
  const crlf = '---\r\nname: gamma\r\ndescription: "CRLF agent: survives Windows checkouts"\r\nmodel: sonnet\r\n---\r\n\r\nBody line.\r\n';
  fs.writeFileSync(path.join(dir, 'agents', 'gamma.md'), crlf);
  const res = await request(asOwner({ workspaceClaudeDir: dir })).get('/api/agents/gamma');
  assert.equal(res.status, 200);
  assert.equal(res.body.agent.model, 'sonnet');
  assert.match(res.body.agent.description, /CRLF agent/);
});

test('TP-agents-skills-003: unknown agent → 404 JSON', async () => {
  const res = await request(asOwner()).get('/api/agents/no-such-agent');
  assert.equal(res.status, 404);
  assert.equal(res.body.ok, false);
});

test('TP-agents-skills-004: path-shaped agent name rejected (listing whitelist = traversal guard)', async () => {
  for (const bad of ['..%2F..%2Fetc', '..%5C..%5Csecrets', 'README']) {
    const res = await request(asOwner()).get(`/api/agents/${bad}`);
    assert.equal(res.status, 404, `expected 404 for ${bad}`);
  }
});

test('TP-agents-skills-005: knowledge docs listed and loadable by whitelisted slug', async () => {
  const index = await request(asOwner()).get('/api/agents');
  assert.deepEqual(index.body.knowledge.map((d) => d.slug), ['claude-md', 'setup-md']);
  const doc = await request(asOwner()).get('/api/knowledge/claude-md');
  assert.equal(doc.status, 200);
  assert.match(doc.body.doc.html, /<strong>log<\/strong>/);
});

test('TP-agents-skills-006: unknown knowledge slug → 404 (whitelist, never a file read)', async () => {
  for (const bad of ['system-md', '..%2FCLAUDE.md', 'claude.md']) {
    const res = await request(asOwner()).get(`/api/knowledge/${bad}`);
    assert.equal(res.status, 404, `expected 404 for ${bad}`);
  }
});

test('TP-agents-skills-007: missing agents dir → empty list, page still serves', async () => {
  const dir = makeClaudeDir();
  fs.rmSync(path.join(dir, 'agents'), { recursive: true });
  const res = await request(asOwner({ workspaceClaudeDir: dir })).get('/api/agents');
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.agents, []);
});

test('TP-agents-skills-008: unauthenticated /api/agents gets 401', async () => {
  const res = await request(makeApp()).get('/api/agents');
  assert.equal(res.status, 401);
});

// ---- document threads N3: comment counts on the index --------------------------
// (central-DB test plan test-plan-document-threads-n3)

const http = require('node:http');

/** Minimal /thread anchor-listing stub (the count-join upstream). */
function startThreadStub({ threads = [], failAll = false } = {}) {
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    res.setHeader('Content-Type', 'application/json');
    if (failAll) { res.statusCode = 500; return res.end(JSON.stringify({ ok: false })); }
    if (u.pathname === '/thread') {
      const k = u.searchParams.get('doc_kind');
      return res.end(JSON.stringify({ ok: true, threads: threads.filter((t) => t.doc_kind === k) }));
    }
    res.statusCode = 404;
    res.end(JSON.stringify({ ok: false }));
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ url: `http://127.0.0.1:${server.address().port}`, close: () => server.close() }));
  });
}

// @plan:test-plan-document-threads-n3 @promote
test('TP-agents-skills-013: /api/agents joins comment counts onto agent AND knowledge rows, best-effort', async () => {
  const stub = await startThreadStub({
    threads: [
      { doc_kind: 'agent', doc_ref: 'alpha', entries: 2 },
      { doc_kind: 'knowledge', doc_ref: 'claude-md', entries: 1 },
      { doc_kind: 'agent', doc_ref: 'not-an-agent-here', entries: 4 }, // stray anchor: harmless
    ],
  });
  try {
    const res = await request(asOwner({ logApiUrl: stub.url, logApiKey: 'k' })).get('/api/agents');
    assert.equal(res.status, 200);
    const byName = Object.fromEntries(res.body.agents.map((a) => [a.name, a]));
    assert.equal(byName.alpha.comments, 2);
    assert.ok(!('comments' in byName.beta), 'zero is silent — no field (quiet ledger)');
    const bySlug = Object.fromEntries(res.body.knowledge.map((d) => [d.slug, d]));
    assert.equal(bySlug['claude-md'].comments, 1);
    assert.ok(!('comments' in bySlug['setup-md']));
  } finally {
    stub.close();
  }

  // Join failure → no counts, never a broken index; unconfigured → same.
  const failing = await startThreadStub({ failAll: true });
  try {
    const res = await request(asOwner({ logApiUrl: failing.url, logApiKey: 'k' })).get('/api/agents');
    assert.equal(res.status, 200);
    assert.ok(res.body.agents.every((a) => !('comments' in a)), 'failure degrades to countless rows');
  } finally {
    failing.close();
  }
  const unconfigured = await request(asOwner()).get('/api/agents');
  assert.equal(unconfigured.status, 200);
  assert.ok(unconfigured.body.agents.every((a) => !('comments' in a)));
});

// @plan:test-plan-document-threads-n3 @promote
test('TP-agents-skills-015: /api/knowledge/:slug never exposes the raw source', async () => {
  const res = await request(asOwner()).get('/api/knowledge/claude-md');
  assert.equal(res.status, 200);
  assert.deepEqual(Object.keys(res.body.doc).sort(), ['file', 'html', 'slug', 'title']);
  assert.ok(!('source' in res.body.doc), 'the raw file (page-comment context) stays server-side');
});
