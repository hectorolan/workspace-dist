// Conversation archive support for BOTH populations + the trigger reverse-lookup
// (ws plan get hub-conversation-archive-api-2026-08-17). Verifies the no-migration
// claim (a page-born conv-<epoch-ms> opener is auto-assigned a conversation row,
// so archive state rides conversation.status), the GET /thread ?role= flat-entries
// mode (one-call conversation -> generated-artifacts lookup for the hub index),
// and the anchor listing's conversation_id/conversation_status fields.
// Same live-server temp-DB pattern as threads.test.js.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const API_KEY = 'test-key-conv-archive';
let proc;
let base;

const api = (p, opts = {}) =>
  fetch(base + p, { ...opts, headers: { 'X-Api-Key': API_KEY, ...(opts.headers || {}) } });
const post = (p, body) =>
  api(p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const patch = (p, body) =>
  api(p, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

/** A page-born conversation opener, shaped exactly like hub's POST /api/conversations. */
const postOpener = (ref, firstLine = 'Talk to me about pricing.') =>
  post('/message', {
    kind: 'page-comment',
    subject: `Conversation: ${firstLine} (conversations/${ref})`,
    ref,
    body: `## Instruction\n${firstLine}\n`,
    meta: JSON.stringify({ source: 'hub', pageType: 'conversations', slug: ref }),
  });

test.before(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'logapi-convarch-test-'));
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

test('TP-convarch-001: a page-born opener is auto-assigned a conversation row (no schema change needed)', async () => {
  const res = await postOpener('conv-1755400000001');
  assert.equal(res.status, 201);
  const stored = await res.json();
  // Threaded at store time: the response names the conversation, and the anchor landed.
  assert.ok(stored.conversation && stored.conversation.id > 0, 'opener joined a conversation');
  assert.deepEqual(
    { doc_kind: stored.thread.doc_kind, doc_ref: stored.thread.doc_ref },
    { doc_kind: 'conversation', doc_ref: 'conv-1755400000001' }
  );
  // The conversation row exists and starts active.
  const conv = await (await api(`/conversation/${stored.conversation.id}`)).json();
  assert.equal(conv.ok, true);
  assert.equal(conv.conversation.status, 'active');
  // The stored message carries conversation_id (visible through the thread read).
  const t = await (await api('/thread?doc_kind=conversation&doc_ref=conv-1755400000001')).json();
  assert.equal(t.entries[0].message.conversation_id, stored.conversation.id);
});

test('TP-convarch-002: PATCH archives and un-archives the page-born conversation, never deletes', async () => {
  const t = await (await api('/thread?doc_kind=conversation&doc_ref=conv-1755400000001')).json();
  const convId = t.entries[0].message.conversation_id;
  let res = await patch(`/conversation/${convId}`, { status: 'archived' });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).conversation.status, 'archived');
  // Reversible: back to active.
  res = await patch(`/conversation/${convId}`, { status: 'active' });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).conversation.status, 'active');
  // Never deleted: still served after the round-trip.
  assert.equal((await api(`/conversation/${convId}`)).status, 200);
});

test('TP-convarch-003: GET /thread?role=trigger is the one-call reverse lookup (conversation -> artifacts)', async () => {
  // The opener's message becomes the trigger entry of a generated doc
  // (exactly what thread-attach.js posts).
  const t = await (await api('/thread?doc_kind=conversation&doc_ref=conv-1755400000001')).json();
  const opener = t.entries[0];
  const res = await post('/thread', {
    doc_kind: 'plan', doc_ref: 'generated-from-conv', message_id: opener.message_id, role: 'trigger',
  });
  assert.equal(res.status, 201);

  const lookup = await (await api('/thread?role=trigger')).json();
  assert.equal(lookup.ok, true);
  assert.ok(Array.isArray(lookup.entries));
  const hit = lookup.entries.find((e) => e.doc_ref === 'generated-from-conv');
  assert.ok(hit, 'the trigger entry is listed');
  assert.equal(hit.doc_kind, 'plan');
  assert.equal(hit.role, 'trigger');
  assert.equal(hit.message_id, opener.message_id);
  assert.equal(hit.message_ref, 'conv-1755400000001'); // page-born key
  assert.equal(hit.conversation_id, opener.message.conversation_id); // legacy key
  // ONLY trigger entries: the same thread's ceo entry is absent.
  assert.ok(lookup.entries.every((e) => e.role === 'trigger'));
});

test('TP-convarch-004: role-mode validation — bad role 400, role+doc_ref 400, role+doc_kind composes, limit respected', async () => {
  assert.equal((await api('/thread?role=boss')).status, 400);
  assert.equal((await api('/thread?role=trigger&doc_kind=plan&doc_ref=x')).status, 400);

  // Compose: a second trigger under doc_kind=digest, then filter each side.
  const msg = await (await post('/message', { kind: 'report', subject: 's', ref: 'convarch-004', body: 'b' })).json();
  assert.equal((await post('/thread', { doc_kind: 'digest', doc_ref: '2026-08-17', message_id: msg.id, role: 'trigger' })).status, 201);
  const digestOnly = await (await api('/thread?role=trigger&doc_kind=digest')).json();
  assert.ok(digestOnly.entries.length >= 1);
  assert.ok(digestOnly.entries.every((e) => e.doc_kind === 'digest'));
  const all = await (await api('/thread?role=trigger')).json();
  assert.ok(all.entries.length >= 2);
  // Newest first, and limit caps the page.
  const created = all.entries.map((e) => e.created);
  assert.deepEqual(created, [...created].sort().reverse());
  const limited = await (await api('/thread?role=trigger&limit=1')).json();
  assert.equal(limited.entries.length, 1);
});

test('TP-convarch-005: the anchor listing (format=json) carries the opener conversation_id + conversation_status', async () => {
  // Archive the page-born conversation so the listing has both states to show.
  const t = await (await api('/thread?doc_kind=conversation&doc_ref=conv-1755400000001')).json();
  const convId = t.entries[0].message.conversation_id;
  await patch(`/conversation/${convId}`, { status: 'archived' });

  const listing = await (await api('/thread?doc_kind=conversation&format=json')).json();
  const row = listing.threads.find((x) => x.doc_ref === 'conv-1755400000001');
  assert.ok(row, 'the page-born anchor is listed');
  assert.equal(row.conversation_id, convId);
  assert.equal(row.conversation_status, 'archived');

  // Reversal tracks: unarchive -> the listing reads active again.
  await patch(`/conversation/${convId}`, { status: 'active' });
  const again = await (await api('/thread?doc_kind=conversation&format=json')).json();
  assert.equal(again.threads.find((x) => x.doc_ref === 'conv-1755400000001').conversation_status, 'active');

  // An anchor whose opener message has no conversation reads null/null.
  const bare = await (await post('/message', { kind: 'report', subject: 'no conv', ref: 'convarch-005-bare', body: 'b' })).json();
  assert.equal((await post('/thread', { doc_kind: 'plan', doc_ref: 'convarch-005-anchor', message_id: bare.id, role: 'ceo' })).status, 201);
  const plans = await (await api('/thread?doc_kind=plan&format=json')).json();
  const bareRow = plans.threads.find((x) => x.doc_ref === 'convarch-005-anchor');
  assert.equal(bareRow.conversation_id, null);
  assert.equal(bareRow.conversation_status, null);
});

test('TP-convarch-006: regression — text listing lines and the doc_ref detail mode are unchanged', async () => {
  const text = await (await api('/thread?doc_kind=conversation')).text();
  assert.match(text, /conversation \| conv-1755400000001 \| 1 entries \| \d{4}-\d{2}-\d{2} \| Conversation: Talk to me about pricing/);
  // Detail mode: same envelope as before, entries still carry message.conversation_id.
  const t = await (await api('/thread?doc_kind=conversation&doc_ref=conv-1755400000001')).json();
  assert.equal(t.ok, true);
  assert.equal(t.doc_kind, 'conversation');
  assert.equal(t.count, 1);
  assert.ok(t.entries[0].message.conversation_id > 0);
  assert.ok('body' in t.entries[0].message);
});
