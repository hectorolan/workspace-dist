'use strict';

// Document threads API suite (design: central-DB plan nexus-document-threads-design,
// N1; test plan test-plan-document-threads-n1). The route reads the workspace log
// API's GET /thread server-side, maps pageType -> doc_kind with the SAME map W1
// records, and renders every entry body through the one sanitized-markdown
// pipeline — thread bodies are untrusted quoted data (WS-H2).

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const request = require('supertest');
const { makeApp } = require('./helpers');

const API_KEY = 'stub-api-key';

/** The intake contract body shape (src/lib/page-comments.js buildComment). */
const ceoBody = (instruction, context) =>
  `## Instruction\n${instruction}\n\n## Page context (plans/p-thread)\n${context}\n`;

const ENTRY = (id, role, created, message) => ({ id, role, created, message_id: 700 + id, message });

/** A live-shaped thread for anchor plan/p-thread: CEO comment then agent reply.
 *  The entries' `created` (the LINK time) deliberately diverges from the
 *  messages' own date/ts — backfilled history, the CEO's reported bug shape.
 *  The CEO message has NO conversation_id key (pre-de7b932 API); the agent
 *  reply carries one (his literal example: conversation 3). */
const THREAD_ENTRIES = [
  ENTRY(1, 'ceo', '2026-08-01T10:00:00Z', {
    id: 701, ts: '2026-07-25T09:30:00Z', date: '2026-07-25',
    kind: 'page-comment', ref: 'page-comment-1', subject: 'Page comment: T (plans/p-thread)',
    meta: '{"source":"hub","pageType":"plans","slug":"p-thread"}',
    body: ceoBody('Please **tighten** section two.', 'FULL PAGE CONTEXT ECHO — must never render'),
  }),
  ENTRY(2, 'agent', '2026-08-01T10:12:00Z', {
    id: 702, ts: '2026-07-25T09:42:00Z', date: '2026-07-25', conversation_id: 3,
    kind: 'inbox-reply', ref: 'page-comment-1-reply', subject: 'Re: T', meta: null,
    body: 'Done — section two now reads *tighter*.',
  }),
];

/**
 * Stub log API serving GET /thread by (doc_kind, doc_ref). `threads` keys are
 * `kind/ref`; unknown anchors answer the W1 empty-thread envelope (ok, entries: []).
 */
function startStubApi({ threads = {}, failAll = false } = {}) {
  const seen = [];
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    seen.push({ path: u.pathname, query: Object.fromEntries(u.searchParams), key: req.headers['x-api-key'] });
    res.setHeader('Content-Type', 'application/json');
    if (failAll) { res.statusCode = 500; return res.end(JSON.stringify({ ok: false, error: 'boom' })); }
    if (u.pathname === '/thread') {
      const k = u.searchParams.get('doc_kind');
      const r = u.searchParams.get('doc_ref');
      const entries = threads[`${k}/${r}`] || [];
      return res.end(JSON.stringify({ ok: true, doc_kind: k, doc_ref: r, count: entries.length, entries }));
    }
    res.statusCode = 404;
    res.end(JSON.stringify({ ok: false }));
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ url: `http://127.0.0.1:${server.address().port}`, seen, close: () => server.close() }));
  });
}

const appFor = (stubUrl, overrides = {}) =>
  makeApp({ authBypass: true, logApiUrl: stubUrl, logApiKey: API_KEY, ...overrides });

// @plan:test-plan-document-threads-n1 @promote
test('TP-nexus-thr-001: plan thread returns role/created/html in order; raw body and meta stay server-side', async () => {
  const stub = await startStubApi({ threads: { 'plan/p-thread': THREAD_ENTRIES } });
  try {
    const res = await request(appFor(stub.url)).get('/api/threads/plans/p-thread');
    assert.equal(res.status, 200);
    const { entries } = res.body.thread;
    assert.deepEqual(entries.map((e) => e.role), ['ceo', 'agent'], 'flat created order, roles carried');
    assert.deepEqual(entries.map((e) => e.created), ['2026-08-01T10:00:00Z', '2026-08-01T10:12:00Z']);
    assert.match(entries[1].html, /<em>tighter<\/em>/, 'markdown rendered server-side');
    for (const e of entries) {
      assert.equal(e.body, undefined, 'raw body never leaves the server');
      assert.equal(e.meta, undefined, 'meta never leaves the server');
    }
    const call = stub.seen.find((r) => r.path === '/thread');
    assert.equal(call.query.doc_kind, 'plan', 'pageType plans maps to doc_kind plan (W1 map)');
    assert.equal(call.query.doc_ref, 'p-thread');
    assert.equal(call.key, API_KEY, 'X-Api-Key rides the server-side call');
  } finally {
    stub.close();
  }
});

// @plan:test-plan-document-threads-n1 @promote
test('TP-nexus-thr-002: pageType digests maps to doc_kind digest with the date as doc_ref', async () => {
  const stub = await startStubApi();
  try {
    const res = await request(appFor(stub.url)).get('/api/threads/digests/2026-01-02');
    assert.equal(res.status, 200);
    const call = stub.seen.find((r) => r.path === '/thread');
    assert.equal(call.query.doc_kind, 'digest');
    assert.equal(call.query.doc_ref, '2026-01-02');
  } finally {
    stub.close();
  }
});

// @plan:test-plan-document-threads-n1 @promote
test('TP-nexus-thr-003: a CEO page-comment renders the Instruction section only — the page-context echo never renders', async () => {
  const stub = await startStubApi({ threads: { 'plan/p-thread': THREAD_ENTRIES } });
  try {
    const res = await request(appFor(stub.url)).get('/api/threads/plans/p-thread');
    const ceo = res.body.thread.entries[0];
    assert.match(ceo.html, /<strong>tighten<\/strong>/, 'the instruction renders');
    assert.ok(!ceo.html.includes('FULL PAGE CONTEXT ECHO'), 'the context echo is stripped from display');
    assert.ok(!ceo.html.includes('Page context'), 'no contract scaffolding renders');
  } finally {
    stub.close();
  }
});

// @plan:test-plan-document-threads-n1 @promote
test('TP-nexus-thr-004: a body without the contract shape renders in full', async () => {
  const oddball = [ENTRY(9, 'ceo', '2026-08-01T09:00:00Z', {
    id: 709, kind: 'page-comment', ref: 'x', subject: 'x', meta: null,
    body: 'A pre-contract comment with **no sections** at all.',
  })];
  const stub = await startStubApi({ threads: { 'plan/p-thread': oddball } });
  try {
    const res = await request(appFor(stub.url)).get('/api/threads/plans/p-thread');
    assert.match(res.body.thread.entries[0].html, /<strong>no sections<\/strong>/);
  } finally {
    stub.close();
  }
});

// @plan:test-plan-document-threads-n1 @promote
test('TP-nexus-thr-005: thread bodies pass the sanitizer — script/onerror payloads are stripped (WS-H2)', async () => {
  const hostile = [ENTRY(3, 'agent', '2026-08-01T11:00:00Z', {
    id: 703, kind: 'inbox-reply', ref: 'r', subject: 'r', meta: null,
    body: 'Hello <script>alert(1)</script> <img src=x onerror="alert(2)"> world',
  })];
  const stub = await startStubApi({ threads: { 'plan/p-thread': hostile } });
  try {
    const res = await request(appFor(stub.url)).get('/api/threads/plans/p-thread');
    const html = res.body.thread.entries[0].html;
    assert.ok(!html.includes('<script'), 'script tags stripped');
    assert.ok(!html.includes('onerror'), 'event handlers stripped');
    assert.match(html, /Hello/, 'benign text survives');
  } finally {
    stub.close();
  }
});

// @plan:test-plan-document-threads-n1 @promote
test('TP-nexus-thr-006: an anchor with no entries is an empty thread (200), never a 404', async () => {
  const stub = await startStubApi();
  try {
    const res = await request(appFor(stub.url)).get('/api/threads/plans/nothing-here');
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.thread.entries, []);
  } finally {
    stub.close();
  }
});

// @plan:test-plan-document-threads-n1 @promote
test('TP-nexus-thr-007: trigger entries partition to the top; the rest keep created order', async () => {
  const withTrigger = [
    ...THREAD_ENTRIES,
    ENTRY(5, 'trigger', '2026-08-01T12:00:00Z', {
      id: 705, kind: 'page-comment', ref: 'origin-1', subject: 'origin', meta: null,
      body: 'The exchange that caused this document.',
    }),
  ];
  const stub = await startStubApi({ threads: { 'plan/p-thread': withTrigger } });
  try {
    const res = await request(appFor(stub.url)).get('/api/threads/plans/p-thread');
    assert.deepEqual(res.body.thread.entries.map((e) => e.role), ['trigger', 'ceo', 'agent'],
      'origin first even though its created is latest');
  } finally {
    stub.close();
  }
});

// @plan:test-plan-document-threads-n1 @promote
test('TP-nexus-thr-008: unknown pageType / path-shaped slug 404 before any upstream call; 503 unconfigured; 502 upstream failure', async () => {
  const stub = await startStubApi();
  try {
    const app = appFor(stub.url);
    assert.equal((await request(app).get('/api/threads/nonsense/p-thread')).status, 404);
    assert.equal((await request(app).get('/api/threads/plans/..%2F..%2Fetc')).status, 404);
    assert.equal(stub.seen.filter((r) => r.path === '/thread').length, 0, 'guards fire before the API');

    const unconfigured = await request(makeApp({ authBypass: true })).get('/api/threads/plans/p-thread');
    assert.equal(unconfigured.status, 503);
  } finally {
    stub.close();
  }
  const failing = await startStubApi({ failAll: true });
  try {
    const res = await request(appFor(failing.url)).get('/api/threads/plans/p-thread');
    assert.equal(res.status, 502);
    assert.match(res.body.error, /thread could not be loaded/i);
  } finally {
    failing.close();
  }
});

// @plan:test-plan-thread-entry-provenance @promote
test('TP-nexus-thr-010: entries carry the MESSAGE\'s date/ts and provenance keys — never entry.created as the display date', async () => {
  const stub = await startStubApi({ threads: { 'plan/p-thread': THREAD_ENTRIES } });
  try {
    const res = await request(appFor(stub.url)).get('/api/threads/plans/p-thread');
    const [ceo, agent] = res.body.thread.entries;
    // The bug at the API seam: entry.created is 2026-08-01 (the LINK time) but
    // the exposed date is the message's own — backfilled history keeps its day.
    assert.equal(ceo.date, '2026-07-25', "the message's date, not created's 2026-08-01");
    assert.equal(ceo.ts, '2026-07-25T09:30:00Z', "the message's ts rides along for the time part");
    assert.equal(ceo.created, '2026-08-01T10:00:00Z', 'created stays exposed as ordering plumbing');
    // Provenance keys: message id + kind always, conversation_id when present.
    assert.equal(ceo.message_id, 701);
    assert.equal(ceo.kind, 'page-comment');
    assert.equal(agent.message_id, 702);
    assert.equal(agent.kind, 'inbox-reply');
    assert.equal(agent.conversation_id, 3, "the agent reply's source conversation");
  } finally {
    stub.close();
  }
});

// @plan:test-plan-thread-entry-provenance @promote
test('TP-nexus-thr-011: a message without conversation_id (pre-de7b932 API) yields null; body/meta still never leave the server', async () => {
  const stub = await startStubApi({ threads: { 'plan/p-thread': THREAD_ENTRIES } });
  try {
    const res = await request(appFor(stub.url)).get('/api/threads/plans/p-thread');
    const [ceo, agent] = res.body.thread.entries;
    assert.equal(ceo.conversation_id, null, 'absent upstream field degrades to null, never undefined-noise');
    for (const e of [ceo, agent]) {
      assert.equal(e.body, undefined, 'raw body never leaves the server (WS-H2 holds with the new fields)');
      assert.equal(e.meta, undefined, 'meta never leaves the server');
    }
  } finally {
    stub.close();
  }
});

// @plan:test-plan-document-threads-n3 @promote
test('TP-nexus-thr-012: pageType knowledge maps to doc_kind knowledge; entries come back display-ready, raw body stays server-side', async () => {
  const doc = [ENTRY(7, 'ceo', '2026-08-02T10:00:00Z', {
    id: 707, ts: '2026-08-02T09:00:00Z', date: '2026-08-02',
    kind: 'page-comment', ref: 'page-comment-7', subject: 'Page comment: CLAUDE.md — workspace conventions (knowledge/claude-md)',
    meta: '{"source":"hub","pageType":"knowledge","slug":"claude-md"}',
    body: '## Instruction\nClarify the **logging** rule.\n\n## Page context (knowledge/claude-md)\nCONTEXT ECHO — must never render\n',
  })];
  const stub = await startStubApi({ threads: { 'knowledge/claude-md': doc } });
  try {
    const res = await request(appFor(stub.url)).get('/api/threads/knowledge/claude-md');
    assert.equal(res.status, 200);
    const call = stub.seen.find((r) => r.path === '/thread');
    assert.equal(call.query.doc_kind, 'knowledge', 'the N3 map addition — mirrors workspace server/threads.js');
    assert.equal(call.query.doc_ref, 'claude-md');
    const entry = res.body.thread.entries[0];
    assert.match(entry.html, /<strong>logging<\/strong>/, 'instruction renders sanitized');
    assert.ok(!entry.html.includes('CONTEXT ECHO'), 'the context echo never renders');
    assert.equal(entry.body, undefined, 'raw body never leaves the server');
    assert.equal(entry.meta, undefined, 'meta never leaves the server');
  } finally {
    stub.close();
  }
});

// @plan:test-plan-document-threads-n3 @promote
test('TP-nexus-thr-013: threadCounts returns {} when the log API is unconfigured — no fetch attempted', async () => {
  const { threadCounts } = require('../src/lib/threads');
  assert.deepEqual(await threadCounts({}, 'agent'), {}, 'unconfigured: quiet empty map, never a fetch to nowhere');
});

// @plan:test-plan-document-threads-n1 @promote
test('TP-nexus-thr-009: /api/threads sits behind requireAuth — 401 JSON without a session', async () => {
  const stub = await startStubApi();
  try {
    const res = await request(makeApp({ logApiUrl: stub.url, logApiKey: API_KEY }))
      .get('/api/threads/plans/p-thread')
      .set('Accept', 'application/json');
    assert.equal(res.status, 401);
  } finally {
    stub.close();
  }
});
