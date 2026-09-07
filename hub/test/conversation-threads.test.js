'use strict';

// Document threads N2 suite (design: central-DB plan nexus-document-threads-design;
// test plan test-plan-document-threads-n2): thread-entry counts joined onto the
// Plans index, the Plans conversation view (document-less threads + legacy email
// conversations), the POST /api/conversations opener riding the page-comment
// intake contract, and the conversations branch of fetchPageContext resolving
// page-born threads. TP-nexus-n2-012 (index-route removal) lives in
// test/conversations.test.js next to the routes it retires. TP-nexus-n2-011
// (digest DETAIL count join) retired with the digest index page — the join moved
// to /api/digests, covered by TP-digest-index-003/-004 in test/digests.test.js.

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const request = require('supertest');
const { makeApp } = require('./helpers');
const { displayBody, titleFromSubject } = require('../src/lib/threads');

const API_KEY = 'stub-api-key';

const PLANS = [
  { slug: 'p-commented', title: 'Commented plan', status: 'active', kind: 'plan', repo: null, updated_at: '2026-08-01T10:00:00Z' },
  { slug: 'p-quiet', title: 'Quiet plan', status: 'active', kind: 'plan', repo: null, updated_at: '2026-08-01T09:00:00Z' },
];

const CONVERSATIONS = [
  { id: 2, title: 'Digest job health check', status: 'active', created_at: '2026-07-17T10:00:00Z', updated_at: '2026-07-17T12:00:00Z', message_count: 3 },
  // Archived legacy row: invisible to the default view, revealed by ?archived=1
  // (the Conversations-subtab toggle, hn-documents-subtabs-2026-08-15).
  { id: 3, title: 'Old archived talk', status: 'archived', created_at: '2026-07-10T10:00:00Z', updated_at: '2026-07-10T11:00:00Z', message_count: 2 },
];

/** W1 anchor-listing rows (GET /thread?doc_kind=&format=json → {ok, threads}). */
const ANCHORS = {
  plan: [
    { doc_kind: 'plan', doc_ref: 'p-commented', entries: 2, first: '2026-08-01T11:00:00Z', last: '2026-08-01T11:14:00Z', subject: 'Page comment: Commented plan (plans/p-commented)' },
  ],
  digest: [
    { doc_kind: 'digest', doc_ref: '2026-01-02', entries: 2, first: '2026-01-02T08:30:00Z', last: '2026-01-02T08:45:00Z', subject: 'Page comment: Digest 2026-01-02 (digests/2026-01-02)' },
  ],
  conversation: [
    { doc_kind: 'conversation', doc_ref: 'conv-1754000000000', entries: 2, first: '2026-08-01T12:00:00Z', last: '2026-08-01T12:15:00Z', subject: 'Conversation: Try the new intake (conversations/conv-1754000000000)' },
    // Digits-only ref = comments ON legacy conversation 2 — never a standalone row.
    { doc_kind: 'conversation', doc_ref: '2', entries: 1, first: '2026-08-01T13:00:00Z', last: '2026-08-01T13:00:00Z', subject: 'Page comment: Digest job health check (conversations/2)' },
    // No subject: the ref is the fallback title.
    { doc_kind: 'conversation', doc_ref: 'conv-1754000000999', entries: 1, first: '2026-08-02T09:00:00Z', last: '2026-08-02T09:00:00Z', subject: null },
  ],
};

/** Per-anchor thread entries for the page-born conversation. */
const CONV_THREAD = [
  {
    id: 1, role: 'ceo', created: '2026-08-01T12:00:00Z', message_id: 801,
    message: {
      id: 801, kind: 'page-comment', ref: 'page-comment-1754000000000',
      subject: 'Conversation: Try the new intake (conversations/conv-1754000000000)',
      meta: '{"source":"hub","pageType":"conversations","slug":"conv-1754000000000"}',
      body: '## Instruction\nTry the **new** intake, please.\n',
    },
  },
  {
    id: 2, role: 'agent', created: '2026-08-01T12:15:00Z', message_id: 802,
    message: { id: 802, kind: 'inbox-reply', ref: 'page-comment-1754000000000-reply', subject: 'Re: Try the new intake', meta: null, body: 'Tried — it *works*.' },
  },
];

/**
 * Stub log API for the N2 surface: /plan index, /conversation list, /thread
 * (anchor listing + one anchor), POST /message recorder. `failThreadList`
 * makes the anchor listing 500 (the count-join degrade paths); `failStore`
 * makes POST /message 500 (opener failure path).
 */
function startStubApi({ failThreadList = false, failStore = false } = {}) {
  const seen = [];
  const stored = [];
  const server = http.createServer(async (req, res) => {
    const u = new URL(req.url, 'http://x');
    seen.push({ path: u.pathname, query: Object.fromEntries(u.searchParams), method: req.method, key: req.headers['x-api-key'] });
    res.setHeader('Content-Type', 'application/json');
    if (u.pathname === '/plan') {
      return res.end(JSON.stringify({ ok: true, entries: PLANS }));
    }
    if (u.pathname === '/conversation') {
      const status = u.searchParams.get('status');
      const rows = CONVERSATIONS.filter((c) => !status || c.status === status);
      return res.end(JSON.stringify({ ok: true, count: rows.length, conversations: rows }));
    }
    if (u.pathname === '/thread' && !u.searchParams.get('doc_ref')) {
      if (failThreadList) { res.statusCode = 500; return res.end(JSON.stringify({ ok: false })); }
      const rows = ANCHORS[u.searchParams.get('doc_kind')] || [];
      return res.end(JSON.stringify({ ok: true, count: rows.length, threads: rows }));
    }
    if (u.pathname === '/thread') {
      const entries = u.searchParams.get('doc_kind') === 'conversation' && u.searchParams.get('doc_ref') === 'conv-1754000000000' ? CONV_THREAD : [];
      return res.end(JSON.stringify({ ok: true, count: entries.length, entries }));
    }
    if (u.pathname === '/message' && req.method === 'POST') {
      if (failStore) { res.statusCode = 500; return res.end(JSON.stringify({ ok: false })); }
      const chunks = [];
      for await (const c of req) chunks.push(c);
      stored.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      return res.end(JSON.stringify({ ok: true, id: 900 + stored.length }));
    }
    res.statusCode = 404;
    res.end(JSON.stringify({ ok: false }));
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ url: `http://127.0.0.1:${server.address().port}`, seen, stored, close: () => server.close() }));
  });
}

const appFor = (stubUrl, overrides = {}) =>
  makeApp({ authBypass: true, logApiUrl: stubUrl, logApiKey: API_KEY, ...overrides });

// @plan:test-plan-document-threads-n2 @promote
test('TP-nexus-n2-001: the Plans index joins thread-entry counts; zero is silent (no field)', async () => {
  const stub = await startStubApi();
  try {
    const res = await request(appFor(stub.url)).get('/api/plans');
    assert.equal(res.status, 200);
    const bySlug = Object.fromEntries(res.body.plans.map((p) => [p.slug, p]));
    assert.equal(bySlug['p-commented'].comments, 2, 'a threaded document carries its count');
    assert.ok(!('comments' in bySlug['p-quiet']), 'no thread → no field, never a "0"');
    const listing = stub.seen.find((r) => r.path === '/thread');
    assert.equal(listing.query.doc_kind, 'plan', 'counts come from the plan anchor listing');
    assert.equal(listing.key, API_KEY);
  } finally {
    stub.close();
  }
});

// @plan:test-plan-document-threads-n2 @promote
test('TP-nexus-n2-002: a failing anchor listing degrades to no counts — the index never breaks', async () => {
  const stub = await startStubApi({ failThreadList: true });
  try {
    const res = await request(appFor(stub.url)).get('/api/plans');
    assert.equal(res.status, 200, 'the count join is decoration, not content');
    assert.deepEqual(res.body.plans.map((p) => p.slug), ['p-commented', 'p-quiet']);
    for (const p of res.body.plans) assert.ok(!('comments' in p));
  } finally {
    stub.close();
  }
});

// @plan:test-plan-document-threads-n2 @promote
test('TP-nexus-n2-003: ?kind=conversation is the merged conversation view, newest activity first', async () => {
  const stub = await startStubApi();
  try {
    const res = await request(appFor(stub.url)).get('/api/plans?kind=conversation');
    assert.equal(res.status, 200);
    assert.equal(res.body.kind, 'conversation');
    assert.deepEqual(res.body.plans, [], 'no plan rows in the conversation view');
    assert.ok(res.body.kinds.includes('conversation'), 'the chip roster carries the view');
    assert.deepEqual(
      res.body.conversations.map((c) => c.ref),
      ['conv-1754000000999', 'conv-1754000000000', '2'],
      'threads + legacy conversation merged, sorted by last activity desc'
    );
    const legacy = res.body.conversations.find((c) => c.ref === '2');
    assert.equal(legacy.legacy, true);
    assert.equal(legacy.entries, 3, 'legacy rows keep their message_count');
    const born = res.body.conversations.find((c) => c.ref === 'conv-1754000000000');
    assert.equal(born.legacy, false);
    assert.equal(born.entries, 2, 'thread rows carry their entry count');
    assert.ok(stub.seen.some((r) => r.path === '/conversation' && r.query.status === 'active'), 'legacy list requests active');
  } finally {
    stub.close();
  }
});

// @plan:test-plan-document-threads-n2 @promote
test('TP-nexus-n2-004: digits-only thread anchors never list as standalone conversations', async () => {
  const stub = await startStubApi();
  try {
    const res = await request(appFor(stub.url)).get('/api/plans?kind=conversation');
    // Anchor doc_ref "2" (comments ON legacy conversation 2) must not appear as
    // its own thread row — only as the legacy conversation itself.
    const twos = res.body.conversations.filter((c) => c.ref === '2');
    assert.equal(twos.length, 1);
    assert.equal(twos[0].legacy, true);
  } finally {
    stub.close();
  }
});

// @plan:test-plan-document-threads-n2 @promote
test('TP-nexus-n2-005: thread-row titles unwrap the intake subject; missing subject falls back to the ref', async () => {
  const stub = await startStubApi();
  try {
    const res = await request(appFor(stub.url)).get('/api/plans?kind=conversation');
    const born = res.body.conversations.find((c) => c.ref === 'conv-1754000000000');
    assert.equal(born.title, 'Try the new intake', 'Conversation: wrapper stripped');
    const bare = res.body.conversations.find((c) => c.ref === 'conv-1754000000999');
    assert.equal(bare.title, 'conv-1754000000999', 'no subject → the ref stands');
  } finally {
    stub.close();
  }
  // Unit check on the helper itself: the Page comment wrapper unwraps too.
  assert.equal(titleFromSubject('Page comment: My plan (plans/my-plan)', 'x'), 'My plan');
  assert.equal(titleFromSubject('', 'fallback-ref'), 'fallback-ref');
});

// @plan:test-plan-document-threads-n2 @promote
test('TP-nexus-n2-006: POST /api/conversations stores the opener in the exact intake shape and returns the thread ref', async () => {
  const stub = await startStubApi();
  try {
    const res = await request(appFor(stub.url))
      .post('/api/conversations')
      .send({ instruction: 'Plan a birthday **surprise**.\nKeep it secret.' });
    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true);
    assert.match(res.body.ref, /^conv-\d+$/, 'the doc_ref convention: conv-<epoch-ms>');

    assert.equal(stub.stored.length, 1);
    const msg = stub.stored[0];
    assert.equal(msg.kind, 'page-comment', 'same intake kind as every comment');
    // Piece-1 alignment (hub-conversation-archive-ui-2026-08-17): the opener's
    // message ref IS the conv-* doc_ref — the trigger reverse lookup keys
    // page-born rows on message_ref, so the two must be the same string.
    assert.equal(msg.ref, res.body.ref, 'the opener message ref is the thread doc_ref itself');
    const meta = JSON.parse(msg.meta);
    assert.deepEqual(meta, { source: 'hub', pageType: 'conversations', slug: res.body.ref },
      'W1 maps this meta to the (conversation, conv-<ts>) anchor at intake');
    assert.equal(msg.subject, `Conversation: Plan a birthday **surprise**. (conversations/${res.body.ref})`,
      'titled from the instruction first line');
    assert.equal(msg.body, '## Instruction\nPlan a birthday **surprise**.\nKeep it secret.\n',
      'instruction only — a new conversation has NO page-context section');
    assert.ok(!msg.body.includes('## Page context'), 'nothing to quote, nothing fenced');
  } finally {
    stub.close();
  }
});

// @plan:test-plan-document-threads-n2 @promote
test('TP-nexus-n2-007: POST /api/conversations — 400 empty/oversize, 503 unconfigured, 502 upstream failure', async () => {
  const stub = await startStubApi();
  try {
    const app = appFor(stub.url);
    const empty = await request(app).post('/api/conversations').send({ instruction: '   ' });
    assert.equal(empty.status, 400);
    const huge = await request(app).post('/api/conversations').send({ instruction: 'x'.repeat(20001) });
    assert.equal(huge.status, 400);
    assert.equal(stub.stored.length, 0, 'nothing stored on validation failure');
  } finally {
    stub.close();
  }
  const unconfigured = await request(makeApp({ authBypass: true })).post('/api/conversations').send({ instruction: 'hi' });
  assert.equal(unconfigured.status, 503);

  const failing = await startStubApi({ failStore: true });
  try {
    const res = await request(appFor(failing.url)).post('/api/conversations').send({ instruction: 'hi' });
    assert.equal(res.status, 502);
    assert.match(res.body.error, /NOT started/i, 'the client keeps the typed text on this message');
  } finally {
    failing.close();
  }
});

// @plan:test-plan-document-threads-n2 @promote
test('TP-nexus-n2-008: displayBody renders instruction-only bodies bare; contract and free-form bodies unchanged', () => {
  // The opener shape (no page-context section): instruction only, no scaffolding.
  assert.equal(
    displayBody({ kind: 'page-comment', body: '## Instruction\nStart a thing.\nSecond line.\n' }),
    'Start a thing.\nSecond line.\n'
  );
  // Full contract (TP-nexus-thr-003 regression): context echo stripped.
  assert.equal(
    displayBody({ kind: 'page-comment', body: '## Instruction\nDo X.\n\n## Page context (plans/p)\nECHO\n' }),
    'Do X.'
  );
  // Non-contract bodies render in full (TP-nexus-thr-004 regression).
  assert.equal(displayBody({ kind: 'inbox-reply', body: 'Plain reply.' }), 'Plain reply.');
  assert.equal(displayBody({ kind: 'page-comment', body: 'Pre-contract comment.' }), 'Pre-contract comment.');
});

// @plan:test-plan-document-threads-n2 @promote
test('TP-nexus-n2-009: page comments on a conv-* slug use the THREAD as context; unknown refs 404', async () => {
  const stub = await startStubApi();
  try {
    const app = appFor(stub.url);
    const ok = await request(app)
      .post('/api/page-comments')
      .send({ pageType: 'conversations', slug: 'conv-1754000000000', instruction: 'Follow up on this.' });
    assert.equal(ok.status, 200);
    assert.equal(stub.stored.length, 1);
    const msg = stub.stored[0];
    assert.deepEqual(JSON.parse(msg.meta), { source: 'hub', pageType: 'conversations', slug: 'conv-1754000000000' },
      'the follow-up anchors to the SAME conversation thread');
    assert.match(msg.body, /## Page context \(conversations\/conv-1754000000000\)/, 'the thread transcript is the context');
    assert.match(msg.body, /### CEO — 2026-08-01\n\nTry the \*\*new\*\* intake, please\./, 'transcript carries the display bodies');
    assert.match(msg.body, /### Agent — 2026-08-01\n\nTried — it \*works\*\./);
    assert.match(msg.subject, /^Page comment: Try the new intake \(conversations\/conv-1754000000000\)$/,
      'titled from the thread opener — email threading groups the follow-up with it');

    const unknown = await request(app)
      .post('/api/page-comments')
      .send({ pageType: 'conversations', slug: 'conv-9999999999999', instruction: 'Into the void.' });
    assert.equal(unknown.status, 404, 'an empty conversation anchor is no page');
    assert.equal(stub.stored.length, 1, 'nothing stored for a missing page');
  } finally {
    stub.close();
  }
});

// @plan:test-plan-document-threads-n2 @promote
test('TP-nexus-n2-010: the thread API carries the derived conversation title; auth still gates it', async () => {
  const stub = await startStubApi();
  try {
    const res = await request(appFor(stub.url)).get('/api/threads/conversations/conv-1754000000000');
    assert.equal(res.status, 200);
    assert.equal(res.body.thread.title, 'Try the new intake');
    assert.equal(res.body.thread.entries.length, 2);

    // TP-nexus-thr-009 regression: still behind requireAuth.
    const unauth = await request(makeApp({ logApiUrl: stub.url, logApiKey: API_KEY }))
      .get('/api/threads/conversations/conv-1754000000000')
      .set('Accept', 'application/json');
    assert.equal(unauth.status, 401);
  } finally {
    stub.close();
  }
});


// @plan:hn-documents-subtabs-2026-08-15 @promote
test('TP-docsub-016_2: archived legacy conversations stay behind ?archived=1; default view never lists them', async () => {
  const stub = await startStubApi();
  try {
    const app = appFor(stub.url);
    // Default read: the archived legacy row is invisible.
    const def = await request(app).get('/api/plans?kind=conversation');
    assert.equal(def.status, 200);
    assert.equal(def.body.archived, false);
    assert.ok(!def.body.conversations.some((c) => c.ref === '3'), 'archived hidden by default');
    assert.ok(def.body.conversations.every((c) => c.status === 'active'), 'default rows all active');
    // The toggle: archived legacy rows appear, marked; page-born threads unaffected.
    const res = await request(app).get('/api/plans?kind=conversation&archived=1');
    assert.equal(res.status, 200);
    assert.equal(res.body.archived, true);
    const archived = res.body.conversations.find((c) => c.ref === '3');
    assert.ok(archived, 'archived legacy row listed with the toggle');
    assert.equal(archived.status, 'archived');
    assert.equal(archived.legacy, true);
    const born = res.body.conversations.find((c) => c.ref === 'conv-1754000000000');
    // Since piece 1, page-born archive state rides the anchor's
    // conversation_status — this stub's rows carry none (old API), which must
    // normalize to active (the TP-convarch-007 degradation edge).
    assert.equal(born.status, 'active', 'no conversation_status from an old API → active');
    // The toggle omits the status filter upstream (contract: omit = all).
    const listCall = stub.seen.filter((r) => r.path === '/conversation').pop();
    assert.equal(listCall.query.status, undefined, 'archived view requests all statuses');
  } finally {
    stub.close();
  }
});
