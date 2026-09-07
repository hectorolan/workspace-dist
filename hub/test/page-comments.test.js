'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const request = require('supertest');
const { makeApp, digestStubHandler, IDENTITY_FIXTURE, identityStubHandler } = require('./helpers');

const API_KEY = 'stub-api-key';

const PLAN = {
  slug: 'income-pipeline',
  title: 'Income pipeline',
  status: 'active',
  repo: null,
  updated_at: '2026-07-21T08:00:00Z',
  body: 'Score ideas with **evidence** before building.\n\n- validate first',
};

const CONVERSATION = {
  conversation: { id: 7, title: 'Deploy question', created_at: '2026-07-20T10:00:00Z' },
  messages: [
    { id: 1, kind: 'inbox-request', date: '2026-07-20', ts: '2026-07-20T10:00:00Z', body: 'Can we deploy tonight?' },
    { id: 2, kind: 'inbox-reply', date: '2026-07-20', ts: '2026-07-20T11:00:00Z', body: 'Yes — staging is **green**.' },
  ],
};

/**
 * Stub log API for the page-comments suite: GET /plan/:slug, GET /conversation/:id,
 * POST /message. Records every request (path, method, api key, parsed JSON body).
 */
function startStubApi() {
  const seen = [];
  const handleDigest = digestStubHandler(); // GET /message?kind=daily-digest + GET /message/:id
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    const record = { method: req.method, path: u.pathname, key: req.headers['x-api-key'], body: null };
    seen.push(record);
    if (identityStubHandler(req, res, u)) return; // transcript speaker labels (TP-ceoconf-011)
    res.setHeader('Content-Type', 'application/json');
    if (req.method === 'POST' && u.pathname === '/message') {
      let raw = '';
      req.on('data', (c) => (raw += c));
      req.on('end', () => {
        try {
          record.body = JSON.parse(raw);
        } catch {
          record.body = raw;
        }
        res.end(JSON.stringify({ ok: true, line: 'stored', conversation: { id: 99 } }));
      });
      return;
    }
    // Digest reads (GET /message?kind=daily-digest, GET /message/:id) for the digest page.
    if (handleDigest(req, res, u)) return;
    if (u.pathname === `/plan/${PLAN.slug}`) return res.end(JSON.stringify({ ok: true, plan: PLAN }));
    if (u.pathname === '/plan') return res.end(JSON.stringify({ ok: true, entries: [{ ...PLAN, body: undefined }] }));
    if (u.pathname === `/conversation/${CONVERSATION.conversation.id}`) return res.end(JSON.stringify(CONVERSATION));
    if (u.pathname === '/conversation') {
      return res.end(JSON.stringify({ conversations: [{ ...CONVERSATION.conversation, updated_at: '2026-07-20T11:00:00Z', message_count: 2 }] }));
    }
    res.statusCode = 404;
    res.end(JSON.stringify({ ok: false, error: 'not found' }));
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({ url: `http://127.0.0.1:${server.address().port}`, seen, close: () => server.close() });
    });
  });
}

const appFor = (stubUrl, overrides = {}) =>
  makeApp({ authBypass: true, logApiUrl: stubUrl, logApiKey: API_KEY, ...overrides });

const postComment = (app, payload) =>
  request(app).post('/api/page-comments').set('Content-Type', 'application/json').send(payload);

/** The single POST /message the stub saw, or undefined. */
const storedMessage = (stub) => stub.seen.find((r) => r.method === 'POST' && r.path === '/message');

// TP-page-comments-001 (comment box + modal on the detail pages, none on index
// pages) moved to the browser suite with the React refactor: TP-nexus-e2e-048
// drives the box on every detail page. Knowledge pages joined the enum with
// document-threads N3 (TP-page-comments-015/016); the PAGE_TYPES guard itself
// stays under TP-page-comments-007.

test('TP-page-comments-002: plan comment stores the exact contract message', async () => {
  const stub = await startStubApi();
  try {
    const res = await postComment(appFor(stub.url), {
      pageType: 'plans',
      slug: 'income-pipeline',
      instruction: 'Archive this plan.',
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true);
    const msg = storedMessage(stub);
    assert.ok(msg, 'a POST /message must reach the log API');
    assert.equal(msg.body.kind, 'page-comment');
    assert.match(msg.body.ref, /^page-comment-\d+$/);
    assert.equal(msg.body.subject, 'Page comment: Income pipeline (plans/income-pipeline)');
    assert.match(msg.body.body, /^## Instruction\nArchive this plan\.\n/);
    assert.match(msg.body.body, /## Page context \(plans\/income-pipeline\)\n/);
    assert.ok(msg.body.body.includes('Score ideas with **evidence** before building.'), 'raw markdown, not HTML');
    assert.ok(!msg.body.body.includes('<strong>'), 'page context must be source, not rendered HTML');
    assert.deepEqual(JSON.parse(msg.body.meta), { source: 'hub', pageType: 'plans', slug: 'income-pipeline' });
  } finally {
    stub.close();
  }
});

test('TP-page-comments-003: digest comment embeds the raw digest markdown', async () => {
  const stub = await startStubApi();
  try {
    const res = await postComment(appFor(stub.url), {
      pageType: 'digests',
      slug: '2026-01-02',
      instruction: 'Follow up on the tech item.',
    });
    assert.equal(res.status, 200);
    const msg = storedMessage(stub);
    assert.equal(msg.body.subject, 'Page comment: Digest 2026-01-02 (digests/2026-01-02)');
    assert.ok(msg.body.body.includes('# Daily Digest — 2026-01-02'), 'raw digest markdown');
    assert.ok(msg.body.body.includes('**Something happened**'));
    assert.match(msg.body.body, /## Page context \(digests\/2026-01-02\)/);
  } finally {
    stub.close();
  }
});

test('TP-page-comments-004: agent comment embeds the full agent file including frontmatter', async () => {
  const stub = await startStubApi();
  try {
    const res = await postComment(appFor(stub.url), {
      pageType: 'agents',
      slug: 'alpha',
      instruction: 'Add a rule about logging.',
    });
    assert.equal(res.status, 200);
    const msg = storedMessage(stub);
    assert.equal(msg.body.subject, 'Page comment: Agent: alpha (agents/alpha)');
    assert.ok(msg.body.body.includes('model: fable'), 'frontmatter must be included');
    assert.ok(msg.body.body.includes('You are the alpha agent.'));
  } finally {
    stub.close();
  }
});

test('TP-page-comments-005: skill comment embeds the full SKILL.md', async () => {
  const stub = await startStubApi();
  try {
    const res = await postComment(appFor(stub.url), {
      pageType: 'skills',
      slug: 'skill-one',
      instruction: 'Clarify step 2.',
    });
    assert.equal(res.status, 200);
    const msg = storedMessage(stub);
    assert.equal(msg.body.subject, 'Page comment: Skill: skill-one (skills/skill-one)');
    assert.ok(msg.body.body.includes('# skill-one skill'));
    assert.ok(msg.body.body.includes('description: The skill-one skill'), 'frontmatter must be included');
  } finally {
    stub.close();
  }
});

test('TP-page-comments-006 / TP-ceoconf-011: conversation comment embeds a transcript with raw bodies', async () => {
  const stub = await startStubApi();
  try {
    const res = await postComment(appFor(stub.url), {
      pageType: 'conversations',
      slug: '7',
      instruction: 'Summarize the outcome.',
    });
    assert.equal(res.status, 200);
    const msg = storedMessage(stub);
    assert.equal(msg.body.subject, 'Page comment: Deploy question (conversations/7)');
    assert.ok(msg.body.body.includes(IDENTITY_FIXTURE.name), 'speaker names come from the identity fixture');
    assert.ok(msg.body.body.includes('Can we deploy tonight?'));
    assert.ok(msg.body.body.includes('Yes — staging is **green**.'), 'raw markdown bodies');
    assert.ok(!msg.body.body.includes('<strong>'));
  } finally {
    stub.close();
  }
});

test('TP-page-comments-007: unknown pageType is rejected with 400, no API call', async () => {
  // `knowledge` was the guard's example until it became a real pageType (N3,
  // TP-page-comments-015) — a genuinely unknown type keeps the case honest.
  const stub = await startStubApi();
  try {
    const res = await postComment(appFor(stub.url), { pageType: 'wiki', slug: 'claude-md', instruction: 'x' });
    assert.equal(res.status, 400);
    assert.equal(res.body.ok, false);
    assert.equal(stub.seen.length, 0, 'no log API request for a rejected pageType');
  } finally {
    stub.close();
  }
});

// @plan:test-plan-document-threads-n3 @promote
test('TP-page-comments-015: knowledge comment stores the contract message with the raw doc as context', async () => {
  const stub = await startStubApi();
  try {
    const res = await postComment(appFor(stub.url), {
      pageType: 'knowledge',
      slug: 'claude-md',
      instruction: 'Clarify the logging rule.',
    });
    assert.equal(res.status, 200);
    const msg = storedMessage(stub);
    assert.ok(msg, 'a POST /message must reach the log API');
    assert.equal(msg.body.subject, 'Page comment: CLAUDE.md — workspace conventions (knowledge/claude-md)');
    assert.match(msg.body.body, /^## Instruction\nClarify the logging rule\.\n/);
    assert.match(msg.body.body, /## Page context \(knowledge\/claude-md\)\n/);
    assert.ok(msg.body.body.includes('Always **log** everything.'), 'raw markdown source, not HTML');
    assert.ok(!msg.body.body.includes('<strong>'), 'page context must be source, not rendered HTML');
    // The meta slug is what W1 anchors the thread with: (knowledge, claude-md).
    assert.deepEqual(JSON.parse(msg.body.meta), { source: 'hub', pageType: 'knowledge', slug: 'claude-md' });
  } finally {
    stub.close();
  }
});

// @plan:test-plan-document-threads-n3 @promote
test('TP-page-comments-016: unknown knowledge slug is a 404 and /message is never called (whitelist guard)', async () => {
  const stub = await startStubApi();
  try {
    for (const bad of ['system-md', '..%2FCLAUDE.md']) {
      const res = await postComment(appFor(stub.url), { pageType: 'knowledge', slug: bad, instruction: 'x' });
      assert.equal(res.status, 404, `expected 404 for ${bad}`);
    }
    assert.equal(storedMessage(stub), undefined, '/message must never be called for unknown docs');
  } finally {
    stub.close();
  }
});

test('TP-page-comments-008: unknown or path-shaped slug is a 404 and /message is never called', async () => {
  const stub = await startStubApi();
  try {
    const app = appFor(stub.url);
    for (const payload of [
      { pageType: 'plans', slug: 'no-such-plan', instruction: 'x' },
      { pageType: 'digests', slug: '../../etc/passwd', instruction: 'x' },
      { pageType: 'agents', slug: 'no-such-agent', instruction: 'x' },
      { pageType: 'conversations', slug: 'abc', instruction: 'x' },
    ]) {
      const res = await postComment(app, payload);
      assert.equal(res.status, 404, `${payload.pageType}/${payload.slug} must 404`);
      assert.equal(res.body.ok, false);
    }
    assert.equal(storedMessage(stub), undefined, '/message must never be called for unknown pages');
  } finally {
    stub.close();
  }
});

test('TP-page-comments-009: empty, missing, or oversized instruction is a 400, no API call', async () => {
  const stub = await startStubApi();
  try {
    const app = appFor(stub.url);
    for (const instruction of ['', '   \n ', undefined, 'x'.repeat(20001)]) {
      const res = await postComment(app, { pageType: 'plans', slug: 'income-pipeline', instruction });
      assert.equal(res.status, 400);
      assert.equal(res.body.ok, false);
    }
    assert.equal(stub.seen.length, 0, 'no log API request for invalid instructions');
  } finally {
    stub.close();
  }
});

test('TP-page-comments-010: server re-fetches page content itself; spoofed content field is ignored', async () => {
  const stub = await startStubApi();
  try {
    const res = await postComment(appFor(stub.url), {
      pageType: 'plans',
      slug: 'income-pipeline',
      instruction: 'Review this.',
      content: 'FAKE INJECTED CONTEXT',
    });
    assert.equal(res.status, 200);
    const fetches = stub.seen.map((r) => `${r.method} ${r.path}`);
    assert.deepEqual(fetches, ['GET /plan/income-pipeline', 'POST /message'], 'content must be re-fetched server-side');
    const msg = storedMessage(stub);
    assert.ok(!msg.body.body.includes('FAKE INJECTED CONTEXT'), 'browser-supplied content must be ignored');
    assert.ok(msg.body.body.includes('Score ideas with **evidence**'));
  } finally {
    stub.close();
  }
});

test('TP-page-comments-011: log API unreachable → 502 JSON, app keeps serving', async () => {
  const stub = await startStubApi();
  stub.close(); // connection refused from now on
  const app = appFor(stub.url);
  const res = await postComment(app, { pageType: 'digests', slug: '2026-01-02', instruction: 'x' });
  assert.equal(res.status, 502);
  assert.equal(res.body.ok, false);
  assert.match(res.body.error, /unreachable|could not/i);
  const health = await request(app).get('/healthz');
  assert.equal(health.status, 200);
});

test('TP-page-comments-012: unset LOG_API_URL → 503 not-configured JSON', async () => {
  const res = await postComment(makeApp({ authBypass: true, logApiUrl: '', logApiKey: '' }), {
    pageType: 'digests',
    slug: '2026-01-02',
    instruction: 'x',
  });
  assert.equal(res.status, 503);
  assert.equal(res.body.ok, false);
  assert.match(res.body.error, /not configured/i);
});

test('TP-page-comments-013: unauthenticated POST hits the auth wall (401 JSON), no API call', async () => {
  const stub = await startStubApi();
  try {
    const res = await postComment(makeApp({ logApiUrl: stub.url, logApiKey: API_KEY }), {
      pageType: 'plans',
      slug: 'income-pipeline',
      instruction: 'x',
    });
    assert.equal(res.status, 401);
    assert.equal(res.body.ok, false);
    assert.equal(stub.seen.length, 0, 'no API call before auth');
  } finally {
    stub.close();
  }
});

test('TP-page-comments-014: POST /message carries X-Api-Key; the key never renders in pages', async () => {
  const stub = await startStubApi();
  try {
    const app = appFor(stub.url);
    await postComment(app, { pageType: 'plans', slug: 'income-pipeline', instruction: 'x' });
    for (const r of stub.seen) assert.equal(r.key, API_KEY);
    const page = await request(app).get('/api/plans/income-pipeline');
    assert.ok(!page.text.includes(API_KEY), 'key must never reach the browser');
  } finally {
    stub.close();
  }
});
