// Document threads W1 (ws plan get test-plan-document-threads-w1; design:
// ws plan get nexus-document-threads-design): thread_entry schema, anchor capture
// at page-comment intake, GET/POST /thread, and the untouched comment lifecycle.
// Same live-server temp-DB pattern as server.test.js.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const API_KEY = 'test-key-threads';
let proc;
let base;

const api = (p, opts = {}) =>
  fetch(base + p, { ...opts, headers: { 'X-Api-Key': API_KEY, ...(opts.headers || {}) } });
const post = (p, body) =>
  api(p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const patch = (p, body) =>
  api(p, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

/** Post one page comment shaped exactly like the ho-nexus contract (page-comments-design). */
const postComment = (ref, { pageType, slug, body = '## Instruction\nDo it.\n\n## Page context\nquoted page\n', meta } = {}) =>
  post('/message', {
    kind: 'page-comment',
    subject: `Page comment: Test (${pageType || 'x'}/${slug || 'y'})`,
    ref,
    body,
    meta: meta !== undefined ? meta : JSON.stringify({ source: 'ho-nexus', pageType, slug }),
  });

test.before(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'logapi-threads-test-'));
  proc = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: {
      ...process.env,
      LOG_DB_PATH: path.join(dir, 'logs.db'),
      LOG_API_PORT: '0',
      LOG_API_HOST: '127.0.0.1',
      LOG_API_KEY: API_KEY,
    },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  base = await new Promise((resolve, reject) => {
    let out = '';
    const timer = setTimeout(() => reject(new Error('server did not start: ' + out)), 10000);
    proc.stdout.on('data', (d) => {
      out += d;
      const m = out.match(/listening on (http:\/\/127\.0\.0\.1:\d+)/);
      if (m) { clearTimeout(timer); resolve(m[1]); }
    });
    proc.on('exit', (code) => reject(new Error('server exited early: ' + code + ' ' + out)));
  });
});

test.after(() => { if (proc) proc.kill(); });

test('TP-dthr-001: page-comment intake with plans meta creates a role-ceo entry readable with its body', async () => {
  let res = await postComment('pc-t-001', { pageType: 'plans', slug: 'my-plan' });
  assert.equal(res.status, 201);
  const stored = await res.json();
  assert.deepEqual({ doc_kind: stored.thread.doc_kind, doc_ref: stored.thread.doc_ref }, { doc_kind: 'plan', doc_ref: 'my-plan' });

  res = await api('/thread?doc_kind=plan&doc_ref=my-plan');
  assert.equal(res.status, 200);
  const t = await res.json();
  assert.equal(t.ok, true);
  assert.equal(t.count, 1);
  assert.equal(t.entries[0].role, 'ceo');
  assert.ok(t.entries[0].created);
  assert.match(t.entries[0].message.body, /## Instruction/);
  assert.equal(t.entries[0].message.ref, 'pc-t-001');
});

test('TP-dthr-002: digests pageType anchors to (digest, date-ref)', async () => {
  const res = await postComment('pc-t-002', { pageType: 'digests', slug: '2026-08-01' });
  const stored = await res.json();
  assert.equal(stored.thread.doc_kind, 'digest');
  assert.equal(stored.thread.doc_ref, '2026-08-01');
});

test('TP-dthr-003: no meta / unknown pageType stores fine (waiting), no thread entry', async () => {
  let res = await postComment('pc-t-003a', { meta: undefined });
  assert.equal(res.status, 201);
  let stored = await res.json();
  assert.equal(stored.thread, undefined);
  res = await postComment('pc-t-003b', { pageType: 'stations', slug: 'x' });
  assert.equal(res.status, 201);
  stored = await res.json();
  assert.equal(stored.thread, undefined);
  // Lifecycle untouched: both entered waiting like any comment.
  res = await api('/message?kind=page-comment&state=waiting&format=json');
  const { entries } = await res.json();
  for (const ref of ['pc-t-003a', 'pc-t-003b']) {
    assert.equal(entries.find((m) => m.ref === ref).comment_state, 'waiting', ref);
  }
});

test('TP-dthr-004: duplicate (kind, ref) re-post creates no second entry', async () => {
  const res = await postComment('pc-t-001', { pageType: 'plans', slug: 'my-plan' });
  assert.equal((await res.json()).duplicate, true);
  const t = await (await api('/thread?doc_kind=plan&doc_ref=my-plan')).json();
  assert.equal(t.entries.filter((e) => e.message.ref === 'pc-t-001').length, 1);
});

test('TP-dthr-005: POST /thread with explicit anchor; GET orders flat by created with roles', async () => {
  const reply = await (await post('/message', { kind: 'inbox-reply', subject: 'Re', ref: 'pc-t-001-reply', body: 'The answer.' })).json();
  const res = await post('/thread', { doc_kind: 'plan', doc_ref: 'my-plan', message_id: reply.id, role: 'agent' });
  assert.equal(res.status, 201);
  const posted = await res.json();
  assert.equal(posted.ok, true);
  assert.equal(posted.duplicate, false);

  const t = await (await api('/thread?doc_kind=plan&doc_ref=my-plan')).json();
  assert.equal(t.count, 2);
  assert.deepEqual(t.entries.map((e) => e.role), ['ceo', 'agent']);
  assert.ok(t.entries[0].created <= t.entries[1].created);
  assert.equal(t.entries[1].message.body, 'The answer.');
});

test('TP-dthr-006: anchor_ref resolves the comment anchor (the runner reply path)', async () => {
  assert.equal((await postComment('pc-t-006', { pageType: 'plans', slug: 'anchored-plan' })).status, 201);
  const reply = await (await post('/message', { kind: 'inbox-reply', subject: 'Re', ref: 'pc-t-006-reply', body: 'Reply body.' })).json();
  const res = await post('/thread', { anchor_ref: 'pc-t-006', message_id: reply.id, role: 'agent' });
  assert.equal(res.status, 201);
  const { entry } = await res.json();
  assert.equal(entry.doc_kind, 'plan');
  assert.equal(entry.doc_ref, 'anchored-plan');
});

test('TP-dthr-007: identical entry re-post is idempotent (200, duplicate, no new row)', async () => {
  const reply = await (await post('/message', { kind: 'inbox-reply', subject: 'Re', ref: 'pc-t-006-reply', body: 'x' })).json();
  const res = await post('/thread', { anchor_ref: 'pc-t-006', message_id: reply.id, role: 'agent' });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).duplicate, true);
  const t = await (await api('/thread?doc_kind=plan&doc_ref=anchored-plan')).json();
  assert.equal(t.count, 2); // ceo + one agent, not three
});

test('TP-dthr-008: validation — bad role/doc_kind 400, unknown message 404, unresolvable anchor_ref 404, no anchor 400', async () => {
  const msg = await (await post('/message', { kind: 'report', subject: 's', ref: 'val-008', body: 'b' })).json();
  let res = await post('/thread', { doc_kind: 'plan', doc_ref: 'p', message_id: msg.id, role: 'boss' });
  assert.equal(res.status, 400);
  res = await post('/thread', { doc_kind: 'wiki', doc_ref: 'p', message_id: msg.id, role: 'ceo' });
  assert.equal(res.status, 400);
  res = await post('/thread', { doc_kind: 'plan', doc_ref: 'p', message_id: 999999, role: 'ceo' });
  assert.equal(res.status, 404);
  res = await post('/thread', { anchor_ref: 'never-threaded-ref', message_id: msg.id, role: 'agent' });
  assert.equal(res.status, 404);
  res = await post('/thread', { message_id: msg.id, role: 'ceo' });
  assert.equal(res.status, 400);
  // GET validation: bad doc_kind 400, doc_ref without doc_kind 400.
  assert.equal((await api('/thread?doc_kind=wiki')).status, 400);
  assert.equal((await api('/thread?doc_ref=p')).status, 400);
});

test('TP-dthr-009: listing groups anchors with entry counts; ?doc_kind filters (the N2 read)', async () => {
  // A document-less conversation thread: opening message anchored to its own ref.
  const opener = await (await post('/message', { kind: 'page-comment', subject: 'New conversation: pricing', ref: 'conv-t-009', body: 'Talk to me about pricing.' })).json();
  assert.equal((await post('/thread', { doc_kind: 'conversation', doc_ref: 'conv-t-009', message_id: opener.id, role: 'ceo' })).status, 201);

  let text = await (await api('/thread')).text();
  assert.match(text, /plan \| my-plan \| 2 entries \| \d{4}-\d{2}-\d{2} \| Page comment: Test \(plans\/my-plan\)/);
  assert.match(text, /conversation \| conv-t-009 \| 1 entries/);

  text = await (await api('/thread?doc_kind=conversation')).text();
  assert.match(text, /conv-t-009/);
  assert.doesNotMatch(text, /my-plan/);

  const json = await (await api('/thread?doc_kind=conversation&format=json')).json();
  assert.equal(json.ok, true);
  assert.equal(json.count, 1);
  assert.equal(json.threads[0].entries, 1);
  assert.equal(json.threads[0].doc_ref, 'conv-t-009');
});

test('TP-dthr-010: a document with no entries reads as an EMPTY thread, not 404', async () => {
  const res = await api('/thread?doc_kind=plan&doc_ref=never-commented');
  assert.equal(res.status, 200);
  const t = await res.json();
  assert.equal(t.ok, true);
  assert.equal(t.count, 0);
  assert.deepEqual(t.entries, []);
});

test('TP-dthr-011: /thread requires the api key like every other endpoint', async () => {
  assert.equal((await fetch(base + '/thread')).status, 401);
  const res = await fetch(base + '/thread', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ doc_kind: 'plan', doc_ref: 'x', message_id: 1, role: 'ceo' }),
  });
  assert.equal(res.status, 401);
});

test('TP-dthr-012: a trigger entry attaches one message to a second anchor (origin comment)', async () => {
  // pc-t-006 already anchors (plan, anchored-plan) as ceo; attach it as the
  // trigger of a newly generated doc.
  const comment = await (await api('/thread?doc_kind=plan&doc_ref=anchored-plan')).json();
  const originId = comment.entries.find((e) => e.role === 'ceo').message_id;
  const res = await post('/thread', { doc_kind: 'plan', doc_ref: 'generated-doc', message_id: originId, role: 'trigger' });
  assert.equal(res.status, 201);
  const t = await (await api('/thread?doc_kind=plan&doc_ref=generated-doc')).json();
  assert.equal(t.entries[0].role, 'trigger');
  assert.equal(t.entries[0].message_id, originId);
  // ...and the original thread still holds the same message as ceo.
  const orig = await (await api('/thread?doc_kind=plan&doc_ref=anchored-plan')).json();
  assert.ok(orig.entries.some((e) => e.role === 'ceo' && e.message_id === originId));
});

test('TP-dthr-013: lifecycle regression — an anchored comment still walks waiting -> read -> answered', async () => {
  assert.equal((await postComment('pc-t-013', { pageType: 'plans', slug: 'lc-plan' })).status, 201);
  let { entries } = await (await api('/message?kind=page-comment&state=waiting&format=json')).json();
  assert.ok(entries.some((m) => m.ref === 'pc-t-013'));

  assert.equal((await post('/claim', { key: 'pc-t-013' })).status, 201);
  ({ entries } = await (await api('/message?kind=page-comment&state=read&format=json')).json());
  assert.ok(entries.some((m) => m.ref === 'pc-t-013'));

  const reply = await (await post('/message', { kind: 'inbox-reply', subject: 'Re', ref: 'pc-t-013-reply', body: 'r' })).json();
  assert.equal((await post('/seen', { message_id: 'pc-t-013', answer_id: reply.id })).status, 201);
  ({ entries } = await (await api('/message?kind=page-comment&state=answered&format=json')).json());
  const row = entries.find((m) => m.ref === 'pc-t-013');
  assert.equal(row.answer_id, reply.id);

  // The thread saw none of that — still exactly the one ceo entry from intake.
  const t = await (await api('/thread?doc_kind=plan&doc_ref=lc-plan')).json();
  assert.equal(t.count, 1);
  assert.equal(t.entries[0].role, 'ceo');
});

// PATCH /thread/:id — the re-anchor operation (the CEO's backlog-month rule,
// 2026-08-02: a comment belongs to the month it was made in, so the monthly
// backlog prune moves prior-month backlog entries into that month's history
// plan). Test plan: ws plan get test-plan-backlog-thread-carry.

test('TP-btc-001: PATCH /thread/:id re-anchors an entry — gone from the old thread, intact on the new', async () => {
  assert.equal((await postComment('pc-btc-001', { pageType: 'plans', slug: 'btc-backlog' })).status, 201);
  const before = await (await api('/thread?doc_kind=plan&doc_ref=btc-backlog')).json();
  const entry = before.entries.find((e) => e.message.ref === 'pc-btc-001');
  const res = await patch(`/thread/${entry.id}`, { doc_kind: 'plan', doc_ref: 'btc-history-2026-07' });
  assert.equal(res.status, 200);
  const moved = await res.json();
  assert.equal(moved.ok, true);
  assert.equal(moved.moved, true);
  assert.equal(moved.entry.id, entry.id);
  assert.equal(moved.entry.doc_ref, 'btc-history-2026-07');

  const old = await (await api('/thread?doc_kind=plan&doc_ref=btc-backlog')).json();
  assert.ok(!old.entries.some((e) => e.id === entry.id), 'entry left the old thread');
  const dest = await (await api('/thread?doc_kind=plan&doc_ref=btc-history-2026-07')).json();
  const at = dest.entries.find((e) => e.id === entry.id);
  assert.ok(at, 'entry arrived on the new anchor');
  assert.equal(at.role, 'ceo');
  assert.equal(at.created, entry.created);
  assert.equal(at.message_id, entry.message_id);
});

test('TP-btc-002: re-anchoring to the current anchor is an idempotent 200 no-op', async () => {
  const dest = await (await api('/thread?doc_kind=plan&doc_ref=btc-history-2026-07')).json();
  const entry = dest.entries[0];
  const res = await patch(`/thread/${entry.id}`, { doc_kind: 'plan', doc_ref: 'btc-history-2026-07' });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(body.moved, false);
  assert.equal(body.entry.id, entry.id);
  assert.equal(body.entry.doc_ref, 'btc-history-2026-07');
  const after = await (await api('/thread?doc_kind=plan&doc_ref=btc-history-2026-07')).json();
  assert.equal(after.count, dest.count, 'no row created or lost');
});

test('TP-btc-003: validation — bad id 400, unknown id 404, missing anchor 400, invalid doc_kind 400', async () => {
  assert.equal((await patch('/thread/abc', { doc_kind: 'plan', doc_ref: 'x' })).status, 400);
  assert.equal((await patch('/thread/999999', { doc_kind: 'plan', doc_ref: 'x' })).status, 404);
  assert.equal((await patch('/thread/1', { doc_kind: 'plan' })).status, 400);
  assert.equal((await patch('/thread/1', { doc_ref: 'x' })).status, 400);
  assert.equal((await patch('/thread/1', { doc_kind: 'wiki', doc_ref: 'x' })).status, 400);
});

test('TP-btc-004: PATCH /thread/:id requires the api key', async () => {
  const res = await fetch(base + '/thread/1', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ doc_kind: 'plan', doc_ref: 'x' }),
  });
  assert.equal(res.status, 401);
});

test('TP-btc-005: an identical entry already at the target → 409, source unchanged', async () => {
  assert.equal((await postComment('pc-btc-005', { pageType: 'plans', slug: 'btc-src' })).status, 201);
  const src = await (await api('/thread?doc_kind=plan&doc_ref=btc-src')).json();
  const entry = src.entries[0];
  // The same message already anchors the destination with the same role.
  assert.equal((await post('/thread', { doc_kind: 'plan', doc_ref: 'btc-dst', message_id: entry.message_id, role: entry.role })).status, 201);
  const res = await patch(`/thread/${entry.id}`, { doc_kind: 'plan', doc_ref: 'btc-dst' });
  assert.equal(res.status, 409);
  assert.match((await res.json()).error, /identical entry/);
  const after = await (await api('/thread?doc_kind=plan&doc_ref=btc-src')).json();
  assert.ok(after.entries.some((e) => e.id === entry.id), 'source row untouched');
});

test('TP-btc-006: after a move, dedupe and the anchor listing judge the NEW anchor', async () => {
  const dest = await (await api('/thread?doc_kind=plan&doc_ref=btc-history-2026-07')).json();
  const e = dest.entries[0];
  const res = await post('/thread', { doc_kind: 'plan', doc_ref: 'btc-history-2026-07', message_id: e.message_id, role: e.role });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).duplicate, true, 'idempotent insert sees the moved row');
  const text = await (await api('/thread')).text();
  assert.match(text, /plan \| btc-history-2026-07 \| 1 entries/);
});

test('TP-dthr-014: knowledge pageType anchors to (knowledge, slug) at intake; knowledge is a valid doc_kind end to end', async () => {
  // Intake: the N3 ho-nexus knowledge pages post meta pageType "knowledge".
  let res = await postComment('pc-t-014', { pageType: 'knowledge', slug: 'claude-md' });
  assert.equal(res.status, 201);
  const stored = await res.json();
  assert.deepEqual(
    { doc_kind: stored.thread.doc_kind, doc_ref: stored.thread.doc_ref },
    { doc_kind: 'knowledge', doc_ref: 'claude-md' }
  );
  // Read: the anchor serves and lists under ?doc_kind=knowledge (no 400 —
  // knowledge is in THREAD_DOC_KINDS).
  const t = await (await api('/thread?doc_kind=knowledge&doc_ref=claude-md')).json();
  assert.equal(t.count, 1);
  assert.equal(t.entries[0].role, 'ceo');
  const listing = await (await api('/thread?doc_kind=knowledge&format=json')).json();
  assert.ok(listing.threads.some((x) => x.doc_ref === 'claude-md'));
  // Append: POST /thread accepts the doc_kind for the runner's reply path.
  const reply = await (await post('/message', { kind: 'inbox-reply', subject: 'Re', ref: 'pc-t-014-reply', body: 'Done.' })).json();
  res = await post('/thread', { doc_kind: 'knowledge', doc_ref: 'claude-md', message_id: reply.id, role: 'agent' });
  assert.equal(res.status, 201);
});
