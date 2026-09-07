'use strict';

// Conversations API suite. Absorbs the EJS-era conversations + archive-filter
// suites (TP IDs kept): thread roles, archive/unarchive PATCH round-trip — JSON
// surface since the React refactor (central-DB test plan
// hn-test-plan-2026-07-26-react-refactor + predecessors). The INDEX route
// retired with the Conversations page (document-threads N2,
// test-plan-document-threads-n2): the listing lives in the Plans conversation
// view (test/conversation-threads.test.js); its old filter cases
// (TP-conv-filter-001..003/006, TP-conversations-viewer-001/002) retired with it.

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const request = require('supertest');
const { makeApp, IDENTITY_FIXTURE, identityStubHandler } = require('./helpers');

const API_KEY = 'stub-api-key';

const CONVERSATIONS = [
  { id: 2, title: 'Digest job health check', status: 'active', created_at: '2026-07-17T10:00:00Z', updated_at: '2026-07-17T12:00:00Z', message_count: 3 },
  { id: 1, title: 'Ship the feature', status: 'archived', created_at: '2026-07-16T09:00:00Z', updated_at: '2026-07-16T09:30:00Z', message_count: 2 },
  { id: 3, title: 'Legacy row (pre-status API)', created_at: '2026-07-15T09:00:00Z', updated_at: '2026-07-15T09:30:00Z', message_count: 1 },
];

const THREADS = {
  2: {
    conversation: CONVERSATIONS[0],
    messages: [
      { id: 10, kind: 'inbox-request', ts: '2026-07-17T10:00:00Z', date: '2026-07-17', subject: 'Agent: digest', body: 'Is the **digest job** healthy?' },
      { id: 11, kind: 'inbox-reply', ts: '2026-07-17T10:05:00Z', date: '2026-07-17', subject: 'digest', body: 'Yes — last run *succeeded*.' },
      { id: 12, kind: 'inbox-error', ts: '2026-07-17T12:00:00Z', date: '2026-07-17', subject: 'digest', body: 'No reply produced for the follow-up.' },
    ],
  },
};

/** Stub log API: /conversation list (?status=) + /conversation/:id GET/PATCH. */
function startStubApi({ conversations = CONVERSATIONS, threads = THREADS, failPatch = false } = {}) {
  const seen = [];
  const patches = [];
  const server = http.createServer(async (req, res) => {
    const u = new URL(req.url, 'http://x');
    seen.push({ url: req.url, method: req.method, key: req.headers['x-api-key'] });
    if (identityStubHandler(req, res, u)) return; // speaker labels come from GET /identity (TP-ceoconf-010)
    res.setHeader('Content-Type', 'application/json');
    const m = u.pathname.match(/^\/conversation\/(\d+)$/);
    if (m && req.method === 'PATCH') {
      if (failPatch) { res.statusCode = 500; return res.end(JSON.stringify({ ok: false })); }
      const chunks = [];
      for await (const c of req) chunks.push(c);
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
      patches.push({ id: m[1], status: body.status });
      return res.end(JSON.stringify({ ok: true }));
    }
    if (m) {
      const t = threads[m[1]];
      if (!t) { res.statusCode = 404; return res.end(JSON.stringify({ ok: false, error: 'not found' })); }
      return res.end(JSON.stringify({ ok: true, ...t }));
    }
    if (u.pathname === '/conversation') {
      const status = u.searchParams.get('status');
      const rows = conversations.filter((c) => !status || c.status === status);
      return res.end(JSON.stringify({ ok: true, count: rows.length, conversations: rows }));
    }
    res.statusCode = 404;
    res.end(JSON.stringify({ ok: false }));
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({ url: `http://127.0.0.1:${server.address().port}`, seen, patches, close: () => server.close() });
    });
  });
}

const appFor = (stubUrl, overrides = {}) =>
  makeApp({ authBypass: true, logApiUrl: stubUrl, logApiKey: API_KEY, ...overrides });

// @plan:test-plan-document-threads-n2 @promote
test('TP-nexus-n2-012: the conversations INDEX route is gone (JSON 404) — the detail and status routes stand', async () => {
  const stub = await startStubApi();
  try {
    const res = await request(appFor(stub.url)).get('/api/conversations');
    assert.equal(res.status, 404, 'the listing retired with the Conversations page');
    assert.equal(res.body.ok, false);
    assert.equal(stub.seen.length, 0, 'no upstream call for a dead route');
  } finally {
    stub.close();
  }
});

test('TP-conversations-viewer-003/010 / TP-ceoconf-010: thread carries roles in order with sanitized html per message', async () => {
  const stub = await startStubApi();
  try {
    const res = await request(appFor(stub.url)).get('/api/conversations/2');
    assert.equal(res.status, 200);
    const msgs = res.body.messages;
    // The CEO-side speaker is the FIXTURE identity name (naming-is-config) and
    // wears the generic `ceo` rail class — never a hardcoded person.
    assert.deepEqual(msgs.map((m) => m.who), [IDENTITY_FIXTURE.name, 'Agent', 'Agent · failure notice']);
    assert.deepEqual(msgs.map((m) => m.cls), ['ceo', 'agent', 'agent-error']);
    assert.match(msgs[0].html, /<strong>digest job<\/strong>/);
    assert.match(msgs[1].html, /<em>succeeded<\/em>/);
    assert.ok(!('body' in msgs[0]), 'raw markdown stays server-side');
  } finally {
    stub.close();
  }
});

test('TP-conversations-viewer-004: unknown conversation id → 404 JSON', async () => {
  const stub = await startStubApi();
  try {
    const res = await request(appFor(stub.url)).get('/api/conversations/999');
    assert.equal(res.status, 404);
    assert.match(res.body.error, /not found/i);
  } finally {
    stub.close();
  }
});

test('TP-conversations-viewer-005: non-numeric id is rejected without an API call', async () => {
  const stub = await startStubApi();
  try {
    const res = await request(appFor(stub.url)).get('/api/conversations/evil-path');
    assert.equal(res.status, 404);
    assert.equal(stub.seen.length, 0, 'the guard must reject before any log API request');
  } finally {
    stub.close();
  }
});

test('TP-archive-003/004 / TP-react-016: archive + unarchive PATCH the log API server-side', async () => {
  const stub = await startStubApi();
  try {
    const app = appFor(stub.url);
    const archive = await request(app).post('/api/conversations/2/status').send({ status: 'archived' });
    assert.equal(archive.status, 200);
    assert.equal(archive.body.ok, true);
    const unarchive = await request(app).post('/api/conversations/2/status').send({ status: 'active' });
    assert.equal(unarchive.status, 200);
    assert.deepEqual(stub.patches, [
      { id: '2', status: 'archived' },
      { id: '2', status: 'active' },
    ]);
    for (const r of stub.seen) assert.equal(r.key, API_KEY, 'the PATCH carries the key server-side');
  } finally {
    stub.close();
  }
});

test('TP-archive-006/007: invalid target status → 400 without an API call; bad id → 404', async () => {
  const stub = await startStubApi();
  try {
    const app = appFor(stub.url);
    const bad = await request(app).post('/api/conversations/2/status').send({ status: 'deleted' });
    assert.equal(bad.status, 400);
    assert.equal(stub.seen.length, 0, 'invalid status rejected before any log API request');
    const badId = await request(app).post('/api/conversations/evil/status').send({ status: 'archived' });
    assert.equal(badId.status, 404);
    assert.equal(stub.seen.length, 0, 'invalid id rejected before any log API request');
  } finally {
    stub.close();
  }
});

test('TP-archive-008: log API rejecting the PATCH → 502 JSON, text preserved for the client', async () => {
  const stub = await startStubApi({ failPatch: true });
  try {
    const res = await request(appFor(stub.url)).post('/api/conversations/2/status').send({ status: 'archived' });
    assert.equal(res.status, 502);
    assert.equal(res.body.ok, false);
    assert.match(res.body.error, /could not be updated/i);
  } finally {
    stub.close();
  }
});

test('TP-conversations-viewer-006: log API unreachable → 502, app keeps serving', async () => {
  const stub = await startStubApi();
  stub.close();
  const app = appFor(stub.url);
  const res = await request(app).get('/api/conversations/2');
  assert.equal(res.status, 502);
  assert.match(res.body.error, /reached/i);
  const health = await request(app).get('/healthz');
  assert.equal(health.status, 200);
});

test('TP-conversations-viewer-007: unset LOG_API_URL → 503 not-configured JSON', async () => {
  const res = await request(makeApp({ authBypass: true, logApiUrl: '', logApiKey: '' })).get('/api/conversations/2');
  assert.equal(res.status, 503);
  assert.match(res.body.error, /not configured/i);
});

test('TP-conversations-viewer-008: an unauthenticated conversation detail gets 401, no API call', async () => {
  const stub = await startStubApi();
  try {
    const res = await request(makeApp({ logApiUrl: stub.url, logApiKey: API_KEY })).get('/api/conversations/2');
    assert.equal(res.status, 401);
    assert.equal(stub.seen.length, 0, 'no API call before auth');
  } finally {
    stub.close();
  }
});

test('TP-conversations-viewer-009: every API call carries X-Api-Key; the key never appears in a response', async () => {
  const stub = await startStubApi();
  try {
    const thread = await request(appFor(stub.url)).get('/api/conversations/2');
    for (const r of stub.seen) assert.equal(r.key, API_KEY);
    assert.ok(!thread.text.includes(API_KEY), 'key must never reach the browser');
  } finally {
    stub.close();
  }
});

// ---------------------------------------------------------------------------
// Conversation archive for both populations + artifact linkage (piece 2 of
// hub-conversation-archive-api-2026-08-17; test plan
// hub-conversation-archive-ui-2026-08-17). One stub models the piece-1 log API:
// anchor rows carry the opener's conversation_id/conversation_status, `?role=`
// is the flat-entries reverse lookup, and page-born archive PATCHes every
// backing conversation row.
// ---------------------------------------------------------------------------

const ARCH_CONVERSATIONS = [
  { id: 4001, title: 'Email thread', status: 'active', created_at: '2026-08-01T08:00:00Z', updated_at: '2026-08-01T09:00:00Z', message_count: 2 },
  { id: 4002, title: 'Archived email', status: 'archived', created_at: '2026-07-30T08:00:00Z', updated_at: '2026-07-30T09:00:00Z', message_count: 1 },
  // The backing row of page-born conv-9001's OPENER — must dedupe out of the
  // merged listing (TP-convarch-008).
  { id: 4101, title: 'Conversation: Alpha', status: 'active', created_at: '2026-08-02T08:00:00Z', updated_at: '2026-08-02T09:00:00Z', message_count: 2 },
];

const ARCH_ANCHORS = [
  { doc_kind: 'conversation', doc_ref: 'conv-9001', entries: 3, first: '2026-08-02T08:00:00Z', last: '2026-08-02T09:00:00Z', subject: 'Conversation: Alpha (conversations/conv-9001)', conversation_id: 4101, conversation_status: 'active' },
  // Archived page-born thread (opener's conversation row is archived).
  { doc_kind: 'conversation', doc_ref: 'conv-9002', entries: 1, first: '2026-08-01T10:00:00Z', last: '2026-08-01T10:00:00Z', subject: 'Conversation: Beta (conversations/conv-9002)', conversation_id: 4103, conversation_status: 'archived' },
  // Old-API row shape: NO conversation_id/conversation_status fields.
  { doc_kind: 'conversation', doc_ref: 'conv-9003', entries: 1, first: '2026-08-01T07:00:00Z', last: '2026-08-01T07:00:00Z', subject: null },
  // Digits-only ref = comments ON legacy conversation 4001 (N2 regression).
  { doc_kind: 'conversation', doc_ref: '4001', entries: 1, first: '2026-08-01T11:00:00Z', last: '2026-08-01T11:00:00Z', subject: 'Page comment: Email thread (conversations/4001)', conversation_id: null, conversation_status: null },
];

const ARCH_TRIGGERS = [
  // Legacy link: matched by the trigger message's conversation_id.
  { id: 1, doc_kind: 'plan', doc_ref: 'artifact-a', role: 'trigger', created: '2026-08-03T08:00:00Z', message_id: 900, message_ref: 'inbox-1', conversation_id: 4001, subject: 'Email thread' },
  // The same artifact attached twice (idempotent re-attach) — rows dedupe.
  { id: 2, doc_kind: 'plan', doc_ref: 'artifact-a', role: 'trigger', created: '2026-08-03T08:05:00Z', message_id: 900, message_ref: 'inbox-1', conversation_id: 4001, subject: 'Email thread' },
  // Page-born link by message_ref (the opener's ref IS the conv-* doc_ref).
  { id: 3, doc_kind: 'plan', doc_ref: 'artifact-b', role: 'trigger', created: '2026-08-03T09:00:00Z', message_id: 901, message_ref: 'conv-9001', conversation_id: null, subject: 'Conversation: Alpha' },
  // Page-born link by the anchor's backing conversation id (pre-alignment
  // openers whose message ref is page-comment-<ts>).
  { id: 4, doc_kind: 'plan', doc_ref: 'artifact-c', role: 'trigger', created: '2026-08-03T10:00:00Z', message_id: 902, message_ref: 'page-comment-777', conversation_id: 4103, subject: 'Conversation: Beta' },
];

/** conv-9001 spans an opener + a follow-up conversation row; one message has none. */
const ARCH_THREADS = {
  'conv-9001': [
    { id: 11, role: 'ceo', created: '2026-08-02T08:00:00Z', message_id: 801, message: { id: 801, kind: 'page-comment', ref: 'conv-9001', conversation_id: 4101, subject: 'Conversation: Alpha (conversations/conv-9001)', body: '## Instruction\nAlpha.\n' } },
    { id: 12, role: 'agent', created: '2026-08-02T08:30:00Z', message_id: 802, message: { id: 802, kind: 'inbox-reply', ref: 'conv-9001-reply', conversation_id: 4102, subject: 'Re: Alpha', body: 'Done.' } },
    { id: 13, role: 'ceo', created: '2026-08-02T09:00:00Z', message_id: 803, message: { id: 803, kind: 'page-comment', ref: 'page-comment-1', conversation_id: null, subject: 'Page comment: Alpha (conversations/conv-9001)', body: '## Instruction\nMore.\n' } },
  ],
  // The archived page-born thread: its opener's store row reads archived.
  'conv-9002': [
    { id: 15, role: 'ceo', created: '2026-08-01T10:00:00Z', message_id: 805, message: { id: 805, kind: 'page-comment', ref: 'page-comment-777', conversation_id: 4103, subject: 'Conversation: Beta (conversations/conv-9002)', body: '## Instruction\nBeta.\n' } },
  ],
  // A thread whose messages carry NO conversation ids (oldest API) — the
  // archive path has nothing to PATCH and must 404 cleanly.
  'conv-9004': [
    { id: 14, role: 'ceo', created: '2026-08-01T08:00:00Z', message_id: 804, message: { id: 804, kind: 'page-comment', ref: 'page-comment-2', subject: 'Conversation: Gamma (conversations/conv-9004)', body: '## Instruction\nGamma.\n' } },
  ],
};

const ARCH_STORE = {
  // Legacy detail rows for the chip-in-the-header cases (TP-convchip-001):
  // 4001 is trigger-linked (artifact-a), 4002 is the unlinked control.
  4001: {
    conversation: ARCH_CONVERSATIONS[0],
    messages: [{ id: 21, kind: 'inbox-request', ts: '2026-08-01T08:00:00Z', date: '2026-08-01', subject: 'Email thread', body: 'Ping?' }],
  },
  4002: { conversation: ARCH_CONVERSATIONS[1], messages: [] },
  4101: { conversation: { id: 4101, title: 'Conversation: Alpha', status: 'active' }, messages: [] },
  4103: { conversation: { id: 4103, title: 'Conversation: Beta', status: 'archived' }, messages: [] },
};

/**
 * Piece-1-shaped stub. `triggerMode`: 'json' (new API) | 'reject400' |
 * 'text' (old API ignoring ?role= — text-line anchor listing back);
 * `failPatch` makes PATCH /conversation/:id 500; `failConvGet` makes
 * GET /conversation/:id 500 (the getThread status degrade).
 */
function startArchiveStub({ triggerMode = 'json', failPatch = false, failConvGet = false } = {}) {
  const seen = [];
  const patches = [];
  const server = http.createServer(async (req, res) => {
    const u = new URL(req.url, 'http://x');
    seen.push({ path: u.pathname, query: Object.fromEntries(u.searchParams), method: req.method, key: req.headers['x-api-key'] });
    const m = u.pathname.match(/^\/conversation\/(\d+)$/);
    if (m && req.method === 'PATCH') {
      res.setHeader('Content-Type', 'application/json');
      if (failPatch) { res.statusCode = 500; return res.end(JSON.stringify({ ok: false })); }
      const chunks = [];
      for await (const c of req) chunks.push(c);
      patches.push({ id: m[1], status: JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}').status });
      return res.end(JSON.stringify({ ok: true }));
    }
    if (m && req.method === 'GET') {
      res.setHeader('Content-Type', 'application/json');
      if (failConvGet) { res.statusCode = 500; return res.end(JSON.stringify({ ok: false })); }
      const t = ARCH_STORE[m[1]];
      if (!t) { res.statusCode = 404; return res.end(JSON.stringify({ ok: false, error: 'not found' })); }
      return res.end(JSON.stringify({ ok: true, ...t }));
    }
    res.setHeader('Content-Type', 'application/json');
    if (u.pathname === '/conversation') {
      const status = u.searchParams.get('status');
      const rows = ARCH_CONVERSATIONS.filter((c) => !status || c.status === status);
      return res.end(JSON.stringify({ ok: true, count: rows.length, conversations: rows }));
    }
    if (u.pathname === '/thread' && u.searchParams.get('role')) {
      if (triggerMode === 'reject400') { res.statusCode = 400; return res.end(JSON.stringify({ ok: false, error: 'invalid role' })); }
      if (triggerMode === 'text') {
        // A pre-piece-1 server ignores ?role= — and with no format=json it
        // answers the anchor listing as TEXT LINES (the real degrade shape).
        res.setHeader('Content-Type', 'text/plain');
        return res.end('conversation | conv-9001 | 3 entries | 2026-08-02 | Conversation: Alpha\n');
      }
      return res.end(JSON.stringify({ ok: true, count: ARCH_TRIGGERS.length, entries: ARCH_TRIGGERS }));
    }
    if (u.pathname === '/thread' && !u.searchParams.get('doc_ref')) {
      return res.end(JSON.stringify({ ok: true, count: ARCH_ANCHORS.length, threads: ARCH_ANCHORS }));
    }
    if (u.pathname === '/thread') {
      const entries = ARCH_THREADS[u.searchParams.get('doc_ref')] || [];
      return res.end(JSON.stringify({ ok: true, count: entries.length, entries }));
    }
    res.statusCode = 404;
    res.end(JSON.stringify({ ok: false }));
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ url: `http://127.0.0.1:${server.address().port}`, seen, patches, close: () => server.close() }));
  });
}

// @plan:hub-conversation-archive-ui-2026-08-17 @promote
test('TP-convarch-001: archiving a conv-* thread PATCHes every distinct backing conversation row, key carried', async () => {
  const stub = await startArchiveStub();
  try {
    const res = await request(appFor(stub.url)).post('/api/conversations/conv-9001/status').send({ status: 'archived' });
    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true);
    assert.deepEqual(stub.patches, [
      { id: '4101', status: 'archived' },
      { id: '4102', status: 'archived' },
    ], 'every distinct non-null conversation_id, once each — the null-message entry contributes none');
    for (const r of stub.seen) assert.equal(r.key, API_KEY, 'thread read and PATCHes all carry the key server-side');
  } finally {
    stub.close();
  }
});

// @plan:hub-conversation-archive-ui-2026-08-17 @promote
test('TP-convarch-002: a conv-* thread with no backing conversation rows → clean 404, nothing PATCHed', async () => {
  const stub = await startArchiveStub();
  try {
    const res = await request(appFor(stub.url)).post('/api/conversations/conv-9004/status').send({ status: 'archived' });
    assert.equal(res.status, 404);
    assert.match(res.body.error, /not found/i);
    assert.deepEqual(stub.patches, []);
    // Unknown thread: same clean shape.
    const unknown = await request(appFor(stub.url)).post('/api/conversations/conv-9999/status').send({ status: 'archived' });
    assert.equal(unknown.status, 404);
    assert.deepEqual(stub.patches, []);
  } finally {
    stub.close();
  }
});

// @plan:hub-conversation-archive-ui-2026-08-17 @promote
test('TP-convarch-003: the legacy numeric path is a single PATCH with no thread read', async () => {
  const stub = await startArchiveStub();
  try {
    const res = await request(appFor(stub.url)).post('/api/conversations/4001/status').send({ status: 'archived' });
    assert.equal(res.status, 200);
    assert.deepEqual(stub.patches, [{ id: '4001', status: 'archived' }]);
    assert.ok(!stub.seen.some((r) => r.path === '/thread'), 'numeric ids never read a thread');
  } finally {
    stub.close();
  }
});

// @plan:hub-conversation-archive-ui-2026-08-17 @promote
test('TP-convarch-004: conv-* archive/unarchive round-trips 200/200; a failing upstream PATCH → 502', async () => {
  const stub = await startArchiveStub();
  try {
    const app = appFor(stub.url);
    const archive = await request(app).post('/api/conversations/conv-9001/status').send({ status: 'archived' });
    const unarchive = await request(app).post('/api/conversations/conv-9001/status').send({ status: 'active' });
    assert.equal(archive.status, 200);
    assert.equal(unarchive.status, 200);
    assert.deepEqual(stub.patches.map((p) => p.status), ['archived', 'archived', 'active', 'active'], 'fully reversible — both rows both ways');
  } finally {
    stub.close();
  }
  const failing = await startArchiveStub({ failPatch: true });
  try {
    const res = await request(appFor(failing.url)).post('/api/conversations/conv-9001/status').send({ status: 'archived' });
    assert.equal(res.status, 502);
    assert.match(res.body.error, /could not be updated/i);
  } finally {
    failing.close();
  }
});

// @plan:hub-conversation-archive-ui-2026-08-17 @promote
test('TP-convarch-005: artifact linkage joins from ONE trigger call — legacy by conversation_id, page-born by ref or backing id; unlinked rows carry no field', async () => {
  const stub = await startArchiveStub();
  try {
    const res = await request(appFor(stub.url)).get('/api/plans?kind=conversation&archived=1');
    assert.equal(res.status, 200);
    const byRef = Object.fromEntries(res.body.conversations.map((c) => [c.ref, c]));
    assert.deepEqual(byRef['4001'].artifacts, [{ kind: 'plan', ref: 'artifact-a' }], 'legacy link, deduped across re-attached triggers');
    assert.deepEqual(byRef['conv-9001'].artifacts, [{ kind: 'plan', ref: 'artifact-b' }], 'page-born link by opener ref');
    assert.deepEqual(byRef['conv-9002'].artifacts, [{ kind: 'plan', ref: 'artifact-c' }], 'page-born link by backing conversation id');
    assert.ok(!('artifacts' in byRef['4002']), 'unlinked row: no field, never an empty list');
    assert.equal(stub.seen.filter((r) => r.path === '/thread' && r.query.role === 'trigger').length, 1, 'ONE reverse-lookup call for the whole index');
  } finally {
    stub.close();
  }
});

// @plan:hub-conversation-archive-ui-2026-08-17 @promote
test('TP-convarch-006: a reverse lookup the API cannot serve degrades to no badges — the listing never breaks', async () => {
  for (const triggerMode of ['reject400', 'text']) {
    const stub = await startArchiveStub({ triggerMode });
    try {
      const res = await request(appFor(stub.url)).get('/api/plans?kind=conversation');
      assert.equal(res.status, 200, `listing survives triggerMode=${triggerMode}`);
      assert.ok(res.body.conversations.length > 0);
      for (const c of res.body.conversations) assert.ok(!('artifacts' in c), 'no badges on degradation');
    } finally {
      stub.close();
    }
  }
});

// @plan:hub-conversation-archive-ui-2026-08-17 @promote
test('TP-convarch-007: page-born archive state rides the anchor conversation_status; missing fields read active', async () => {
  const stub = await startArchiveStub();
  try {
    const app = appFor(stub.url);
    const def = await request(app).get('/api/plans?kind=conversation');
    assert.ok(!def.body.conversations.some((c) => c.ref === 'conv-9002'), 'archived page-born row hidden by default');
    assert.ok(def.body.conversations.some((c) => c.ref === 'conv-9003'), 'old-API row (no status fields) lists as active');
    const all = await request(app).get('/api/plans?kind=conversation&archived=1');
    const beta = all.body.conversations.find((c) => c.ref === 'conv-9002');
    assert.equal(beta.status, 'archived', 'the toggle reveals it, marked');
    assert.equal(all.body.conversations.find((c) => c.ref === 'conv-9003').status, 'active');
  } finally {
    stub.close();
  }
});

// @plan:hub-conversation-archive-ui-2026-08-17 @promote
test('TP-convarch-008: a page-born opener\'s backing conversation row never lists as its own legacy row', async () => {
  const stub = await startArchiveStub();
  try {
    const res = await request(appFor(stub.url)).get('/api/plans?kind=conversation&archived=1');
    assert.ok(!res.body.conversations.some((c) => c.ref === '4101'), 'opener backing row deduped');
    assert.ok(res.body.conversations.some((c) => c.ref === '4001' && c.legacy === true), 'real legacy email rows unaffected');
    assert.ok(res.body.conversations.some((c) => c.ref === 'conv-9001' && c.legacy === false), 'the thread row IS the conversation');
  } finally {
    stub.close();
  }
});

// ---------------------------------------------------------------------------
// Artifact chips on the conversation DETAIL pages (central-DB test plan
// hub-conversation-detail-artifact-chips-2026-08-17): the index's trigger-join
// (TP-convarch-005) reused server-side so each detail payload carries the
// artifacts its header renders — same fixtures, same one-call reverse lookup.
// ---------------------------------------------------------------------------

// @plan:hub-conversation-detail-artifact-chips-2026-08-17 @promote
test('TP-convchip-001: the legacy detail payload carries its artifacts from the shared trigger join; unlinked → no field', async () => {
  const stub = await startArchiveStub();
  try {
    const res = await request(appFor(stub.url)).get('/api/conversations/4001');
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.artifacts, [{ kind: 'plan', ref: 'artifact-a' }], 'legacy link by conversation_id, deduped across re-attached triggers');
    const unlinked = await request(appFor(stub.url)).get('/api/conversations/4002');
    assert.equal(unlinked.status, 200);
    assert.ok(!('artifacts' in unlinked.body), 'unlinked: no field, never an empty list');
  } finally {
    stub.close();
  }
});

// @plan:hub-conversation-detail-artifact-chips-2026-08-17 @promote
test('TP-convchip-002: the conv-* thread payload carries artifacts — by opener ref and by backing conversation id', async () => {
  const stub = await startArchiveStub();
  try {
    const byRef = await request(appFor(stub.url)).get('/api/threads/conversations/conv-9001');
    assert.equal(byRef.status, 200);
    assert.deepEqual(byRef.body.thread.artifacts, [{ kind: 'plan', ref: 'artifact-b' }], 'matched on message_ref = the conv-* doc_ref');
    const byConv = await request(appFor(stub.url)).get('/api/threads/conversations/conv-9002');
    assert.deepEqual(byConv.body.thread.artifacts, [{ kind: 'plan', ref: 'artifact-c' }], 'matched on the backing conversation id');
    const none = await request(appFor(stub.url)).get('/api/threads/conversations/conv-9004');
    assert.equal(none.status, 200);
    assert.ok(!('artifacts' in none.body.thread), 'unlinked thread: no field');
  } finally {
    stub.close();
  }
});

// @plan:hub-conversation-detail-artifact-chips-2026-08-17 @promote
test('TP-convchip-003: a reverse lookup the API cannot serve leaves both detail payloads chip-less — never an error', async () => {
  for (const triggerMode of ['reject400', 'text']) {
    const stub = await startArchiveStub({ triggerMode });
    try {
      const legacy = await request(appFor(stub.url)).get('/api/conversations/4001');
      assert.equal(legacy.status, 200, `legacy detail survives triggerMode=${triggerMode}`);
      assert.ok(!('artifacts' in legacy.body), 'no chips on degradation');
      const born = await request(appFor(stub.url)).get('/api/threads/conversations/conv-9001');
      assert.equal(born.status, 200, `thread detail survives triggerMode=${triggerMode}`);
      assert.ok(!('artifacts' in born.body.thread), 'no chips on degradation');
    } finally {
      stub.close();
    }
  }
});

// @plan:hub-conversation-archive-ui-2026-08-17 @promote
test('TP-convarch-009: the conversation thread payload carries the opener\'s archive state; lookup failure reads active', async () => {
  const stub = await startArchiveStub();
  try {
    const res = await request(appFor(stub.url)).get('/api/threads/conversations/conv-9001');
    assert.equal(res.status, 200);
    assert.equal(res.body.thread.status, 'active');
    const beta = await request(appFor(stub.url)).get('/api/threads/conversations/conv-9002');
    assert.equal(beta.body.thread.status, 'archived', 'an archived opener row surfaces on the thread payload');
    const gamma = await request(appFor(stub.url)).get('/api/threads/conversations/conv-9004');
    assert.equal(gamma.body.thread.status, 'active', 'no conversation id anywhere → active, page renders');
  } finally {
    stub.close();
  }
  const failing = await startArchiveStub({ failConvGet: true });
  try {
    const res = await request(appFor(failing.url)).get('/api/threads/conversations/conv-9001');
    assert.equal(res.status, 200, 'a failed status lookup never breaks the thread page');
    assert.equal(res.body.thread.status, 'active');
  } finally {
    failing.close();
  }
});
