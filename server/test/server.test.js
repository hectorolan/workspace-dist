'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const API_KEY = 'test-key-123';
let proc;
let base;

const api = (p, opts = {}) =>
  fetch(base + p, { ...opts, headers: { 'X-Api-Key': API_KEY, ...(opts.headers || {}) } });
const form = (fields) => new URLSearchParams(fields).toString();
const post = (p, fields) =>
  api(p, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: form(fields) });
const patch = (p, fields) =>
  api(p, { method: 'PATCH', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: form(fields) });

test.before(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'logapi-server-test-'));
  proc = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: {
      ...process.env,
      LOG_DB_PATH: path.join(dir, 'logs.db'),
      LOG_API_PORT: '0', // random free port; server prints the bound one
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

test('TP-email-conversations-021: missing X-Api-Key is rejected on old and new endpoints', async () => {
  for (const p of ['/log?days=1', '/conversation']) {
    const res = await fetch(base + p);
    assert.equal(res.status, 401, p);
  }
});

test('TP-email-conversations-020: regression — /health, /log, /summary, /seen, /schema still work', async () => {
  let res = await post('/log', { area: 'test', status: 'done', message: 'regression check' });
  assert.equal(res.status, 201);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.match(body.line, /workspace \| test \| done \| regression check/);

  res = await api('/log?days=1');
  assert.match(await res.text(), /regression check/);
  res = await api('/summary?days=1');
  assert.match(await res.text(), /## workspace/);

  res = await post('/seen', { message_id: '<seen@mail>' });
  assert.equal(res.status, 201);
  res = await api('/seen');
  assert.match(await res.text(), /<seen@mail>/);

  res = await api('/schema');
  const schema = await res.text();
  assert.match(schema, /CREATE TABLE message/);
  assert.match(schema, /CREATE TABLE conversation/);

  res = await api('/health');
  assert.equal((await res.json()).ok, true);
});

test('TP-email-conversations-001/011: POST /message threads inbox-requests and dedupes with conversation id', async () => {
  let res = await post('/message', {
    kind: 'inbox-request',
    subject: 'Agent: Ship the feature',
    ref: 'srv-1',
    body: 'Please ship it.',
    meta: JSON.stringify({ 'message-id': '<srv1@mail>' }),
  });
  assert.equal(res.status, 201);
  let body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(body.conversation.created, true);
  assert.equal(body.conversation.title, 'Ship the feature');
  const convId = body.conversation.id;

  // Duplicate (kind, ref) returns the existing conversation, creates nothing.
  res = await post('/message', {
    kind: 'inbox-request',
    subject: 'Agent: Ship the feature',
    ref: 'srv-1',
    body: 'Please ship it.',
    meta: JSON.stringify({ 'message-id': '<srv1@mail>' }),
  });
  body = await res.json();
  assert.equal(body.duplicate, true);
  assert.equal(body.conversation.id, convId);
  assert.equal(body.conversation.created, false);

  // Reply joins via slug; digest stays unthreaded (TP-010).
  res = await post('/message', { kind: 'inbox-reply', subject: 'Ship the feature', ref: 'srv-1-reply', body: 'Done: shipped.' });
  body = await res.json();
  assert.equal(body.conversation.id, convId);
  res = await post('/message', { kind: 'daily-digest', subject: 'Digest', ref: 'srv-digest-1', body: 'digest body' });
  body = await res.json();
  assert.equal(body.conversation, undefined);

  // Follow-up joins via References.
  res = await post('/message', {
    kind: 'inbox-request',
    subject: 'Re: Agent Reply: Ship the feature',
    ref: 'srv-2',
    body: 'And the docs?',
    meta: JSON.stringify({ 'message-id': '<srv2@mail>', references: '<srv1@mail> <gmail-reply@mail>' }),
  });
  body = await res.json();
  assert.equal(body.conversation.id, convId);
  assert.equal(body.conversation.created, false);
});

test('TP-email-conversations-012: GET /conversation lists newest-activity-first with counts', async () => {
  await post('/message', {
    kind: 'inbox-request', subject: 'Second topic', ref: 'srv-3', body: 'Other thing.',
    meta: JSON.stringify({ 'message-id': '<srv3@mail>' }),
  });
  const res = await api('/conversation?format=json');
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(body.conversations.length, 2);
  assert.equal(body.conversations[0].title, 'Second topic'); // newest activity first
  const ship = body.conversations[1];
  assert.equal(ship.title, 'Ship the feature');
  assert.equal(ship.message_count, 3);
  assert.ok(ship.updated_at >= ship.created_at);

  const text = await (await api('/conversation')).text();
  assert.match(text, /Ship the feature/);
  assert.match(text, /3 msgs/);
});

test('TP-email-conversations-013: GET /conversation/:id returns ordered full messages; 404 unknown', async () => {
  const list = await (await api('/conversation?format=json')).json();
  const ship = list.conversations.find((c) => c.title === 'Ship the feature');
  const res = await api(`/conversation/${ship.id}`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(body.conversation.id, ship.id);
  assert.equal(body.messages.length, 3);
  assert.deepEqual(body.messages.map((m) => m.kind), ['inbox-request', 'inbox-reply', 'inbox-request']);
  assert.equal(body.messages[0].body, 'Please ship it.');

  assert.equal((await api('/conversation/999999')).status, 404);
});

test('TP-email-conversations-014: PATCH /conversation/:id sets the title (AI-title path)', async () => {
  const list = await (await api('/conversation?format=json')).json();
  const id = list.conversations[0].id;
  let res = await patch(`/conversation/${id}`, { title: 'Neat AI title' });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).conversation.title, 'Neat AI title');

  assert.equal((await patch(`/conversation/${id}`, { title: '   ' })).status, 400);
  assert.equal((await patch('/conversation/999999', { title: 'x' })).status, 404);
});

test('TP-conv-status-003: fresh conversations default to active; JSON rows and convLine expose status', async () => {
  const list = await (await api('/conversation?format=json')).json();
  for (const c of list.conversations) assert.equal(c.status, 'active');
  const text = await (await api('/conversation')).text();
  // id | date | status | n msgs | title
  assert.match(text, /^\d+ \| \d{4}-\d{2}-\d{2} \| active \| \d+ msgs \| /m);
});

test('TP-conv-status-004: PATCH accepts status; title+status together; invalid status is 400; neither is 400', async () => {
  const id = (await (await api('/conversation?format=json')).json()).conversations[0].id;

  // status alone archives (soft-delete)
  let res = await patch(`/conversation/${id}`, { status: 'archived' });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).conversation.status, 'archived');

  // title + status in one call
  res = await patch(`/conversation/${id}`, { title: 'Renamed and active', status: 'active' });
  assert.equal(res.status, 200);
  let c = (await res.json()).conversation;
  assert.equal(c.title, 'Renamed and active');
  assert.equal(c.status, 'active');

  // invalid status value is a 400 with nothing changed
  res = await patch(`/conversation/${id}`, { status: 'deleted' });
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /invalid status: deleted/);
  c = (await (await api(`/conversation/${id}`)).json()).conversation;
  assert.equal(c.status, 'active'); // unchanged

  // neither title nor status is a 400
  res = await patch(`/conversation/${id}`, {});
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /missing field: title or status/);
});

test('TP-conv-status-005: GET /conversation?status= filters; omitted/all returns everything', async () => {
  const all = (await (await api('/conversation?format=json')).json()).conversations;
  const target = all[all.length - 1].id; // archive the oldest so both buckets are non-empty
  await patch(`/conversation/${target}`, { status: 'archived' });

  const active = (await (await api('/conversation?status=active&format=json')).json()).conversations;
  assert.ok(active.every((c) => c.status === 'active'));
  assert.ok(!active.some((c) => c.id === target));

  const archived = (await (await api('/conversation?status=archived&format=json')).json()).conversations;
  assert.ok(archived.length >= 1);
  assert.ok(archived.every((c) => c.status === 'archived'));
  assert.ok(archived.some((c) => c.id === target));

  // omitted and ?status=all both return the full set (backward-compatible default)
  const omitted = (await (await api('/conversation?format=json')).json()).conversations;
  const both = (await (await api('/conversation?status=all&format=json')).json()).conversations;
  assert.equal(omitted.length, all.length);
  assert.equal(both.length, all.length);

  // bad filter value is a 400
  assert.equal((await api('/conversation?status=bogus')).status, 400);
});

test('TP-runner-audit-001: GET /message?format=json exposes meta and elides bodies', async () => {
  let res = await post('/message', {
    kind: 'email-out',
    subject: 'Daily Digest - json test',
    ref: 'srv-json-1',
    body: 'digest email body',
    meta: JSON.stringify({ to: 'hector@example.com', sender: 'runner' }),
  });
  assert.equal(res.status, 201);

  res = await api('/message?kind=email-out&days=1&format=json');
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  const row = body.entries.find((m) => m.ref === 'srv-json-1');
  assert.equal(JSON.parse(row.meta).sender, 'runner');
  assert.equal(row.body, undefined);
  assert.equal(row.body_length, 'digest email body'.length);

  // Text mode is unchanged for the same rows.
  res = await api('/message?kind=email-out&days=1');
  assert.match(await res.text(), /srv-json-1/);
});

test('TP-audit-w2-001 / TP-audit-w2-002 / TP-audit-w2-003: GET /message before_id pagination (WS-M3)', async () => {
  // Five rows of one kind; ids are strictly increasing in insert order.
  for (let i = 1; i <= 5; i++) {
    const res = await post('/message', { kind: 'w2-page', ref: `w2-pg-${i}`, body: `row ${i}` });
    assert.equal(res.status, 201);
  }
  const rows = async (p) => (await (await api(p)).json()).entries;
  const all = await rows('/message?kind=w2-page&limit=200&format=json');
  assert.equal(all.length, 5);
  const ids = all.map((m) => m.id); // ascending (server reverses the DESC page)

  // TP-audit-w2-001: before_id returns only rows with id < N, combined with kind + limit.
  const before = await rows(`/message?kind=w2-page&before_id=${ids[2]}&limit=200&format=json`);
  assert.deepEqual(before.map((m) => m.id), ids.slice(0, 2));
  assert.ok(before.every((m) => m.id < ids[2]));

  // TP-audit-w2-002: two-batch descending walk covers all rows exactly once — no overlap, no gap.
  const page1 = await rows('/message?kind=w2-page&limit=3&format=json');
  assert.equal(page1.length, 3);
  const page2 = await rows(`/message?kind=w2-page&limit=3&before_id=${Math.min(...page1.map((m) => m.id))}&format=json`);
  assert.equal(page2.length, 2);
  const walked = [...page2, ...page1].map((m) => m.id);
  assert.deepEqual(walked, ids);

  // TP-audit-w2-003: non-numeric before_id is ignored — identical to the unfiltered listing.
  const bogus = await rows('/message?kind=w2-page&before_id=abc&limit=200&format=json');
  assert.deepEqual(bogus.map((m) => m.id), ids);
});

test('TP-page-comments-002: POST /message threads page-comment; the runner reply joins it', async () => {
  const subject = 'Page comment: Daily Digest 2026-07-22 (digests/2026-07-22)';
  let res = await post('/message', {
    kind: 'page-comment',
    subject,
    ref: 'page-comment-1753290000000',
    body: '## Instruction\nArchive this digest.\n\n## Page context (digests/2026-07-22)\n...digest body...\n',
    meta: JSON.stringify({ source: 'ho-nexus', pageType: 'digests', slug: '2026-07-22' }),
  });
  assert.equal(res.status, 201);
  let body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(body.conversation.created, true, 'page-comment must be a threaded kind');
  assert.equal(body.conversation.title, subject);
  const convId = body.conversation.id;

  res = await post('/message', {
    kind: 'inbox-reply',
    subject,
    ref: 'page-comment-1753290000000-reply',
    body: 'Done: archived.',
  });
  body = await res.json();
  assert.equal(body.conversation.id, convId);
  assert.equal(body.conversation.created, false);
});

// ---- page-comment lifecycle (WS-M3 rework — ws plan get test-plan-comment-lifecycle) ----
// Extra servers with the threshold env seams (COMMENT_WAIT_EXPIRY_HOURS /
// COMMENT_READ_STALE_MINUTES) compress time; production never sets them.

function spawnServer(extraEnv, dbPath) {
  const dir = dbPath ? path.dirname(dbPath) : fs.mkdtempSync(path.join(os.tmpdir(), 'logapi-clc-test-'));
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: {
      ...process.env,
      LOG_DB_PATH: dbPath || path.join(dir, 'logs.db'),
      LOG_API_PORT: '0',
      LOG_API_HOST: '127.0.0.1',
      LOG_API_KEY: API_KEY,
      ...extraEnv,
    },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  return new Promise((resolve, reject) => {
    let out = '';
    const timer = setTimeout(() => reject(new Error('lifecycle server did not start: ' + out)), 10000);
    child.stdout.on('data', (d) => {
      out += d;
      const m = out.match(/listening on (http:\/\/127\.0\.0\.1:\d+)/);
      if (m) { clearTimeout(timer); resolve({ proc: child, base: m[1] }); }
    });
    child.on('exit', (code) => reject(new Error('lifecycle server exited early: ' + code + ' ' + out)));
  });
}

const on = (srvBase) => ({
  api: (p, opts = {}) => fetch(srvBase + p, { ...opts, headers: { 'X-Api-Key': API_KEY, ...(opts.headers || {}) } }),
  post: (p, fields) =>
    fetch(srvBase + p, {
      method: 'POST',
      headers: { 'X-Api-Key': API_KEY, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form(fields),
    }),
});
const rowByRef = (entries, ref) => entries.find((m) => m.ref === ref);

test('TP-clc-001: a fresh page comment is waiting; other kinds carry no state; POST returns the id', async () => {
  let res = await post('/message', { kind: 'page-comment', subject: 'Page comment: clc 1', ref: 'page-comment-clc-001', body: 'b1' });
  assert.equal(res.status, 201);
  let body = await res.json();
  assert.equal(typeof body.id, 'number');
  // Duplicate path returns the same id.
  res = await post('/message', { kind: 'page-comment', subject: 'Page comment: clc 1', ref: 'page-comment-clc-001', body: 'b1' });
  const dup = await res.json();
  assert.equal(dup.duplicate, true);
  assert.equal(dup.id, body.id);

  res = await post('/message', { kind: 'report', subject: 'not a comment', ref: 'clc-report-1', body: 'r' });
  assert.equal(res.status, 201);

  const { entries } = await (await api('/message?kind=page-comment&format=json&limit=200')).json();
  const row = rowByRef(entries, 'page-comment-clc-001');
  assert.equal(row.comment_state, 'waiting');
  assert.ok(row.comment_state_ts);
  const reports = (await (await api('/message?kind=report&format=json&limit=200')).json()).entries;
  assert.equal(rowByRef(reports, 'clc-report-1').comment_state, null);
});

test('TP-clc-003: a granted claim advances the comment to read; non-comment claims unchanged (WS-M2 alignment)', async () => {
  let res = await post('/message', { kind: 'page-comment', subject: 'Page comment: clc 3', ref: 'page-comment-clc-003', body: 'b3' });
  assert.equal(res.status, 201);
  res = await post('/claim', { key: 'page-comment-clc-003' });
  assert.equal(res.status, 201);
  assert.equal((await res.json()).granted, true);
  const { entries } = await (await api('/message?kind=page-comment&format=json&limit=200')).json();
  assert.equal(rowByRef(entries, 'page-comment-clc-003').comment_state, 'read');
  // A second fresh claim is denied — the one claim mechanism, mirrored not duplicated.
  res = await post('/claim', { key: 'page-comment-clc-003' });
  assert.equal((await res.json()).granted, false);
  // Regression: mail Message-ID claims (no comment row) behave exactly as before.
  res = await post('/claim', { key: '<clc-mail@test>' });
  assert.equal(res.status, 201);
  assert.equal((await res.json()).granted, true);
});

test('TP-clc-002: state=waiting returns only waiting; composes with before_id; invalid state is 400', async () => {
  const { entries } = await (await api('/message?kind=page-comment&state=waiting&format=json&limit=200')).json();
  assert.ok(rowByRef(entries, 'page-comment-clc-001')); // still waiting
  assert.equal(rowByRef(entries, 'page-comment-clc-003'), undefined); // read — excluded
  assert.ok(entries.every((m) => m.comment_state === 'waiting'));
  // Paging composes: before_id below the waiting row's id excludes it.
  const id = rowByRef(entries, 'page-comment-clc-001').id;
  const paged = (await (await api(`/message?kind=page-comment&state=waiting&before_id=${id}&format=json&limit=200`)).json()).entries;
  assert.equal(rowByRef(paged, 'page-comment-clc-001'), undefined);
  const res = await api('/message?state=nonsense');
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /invalid state/);
});

test('TP-clc-004: /seen with answer_id -> answered; the reply is retrievable; duplicate seen keeps the id', async () => {
  let res = await post('/message', { kind: 'page-comment', subject: 'Page comment: clc 4', ref: 'page-comment-clc-004', body: 'b4' });
  assert.equal(res.status, 201);
  res = await post('/message', { kind: 'inbox-reply', subject: 'Page comment: clc 4', ref: 'page-comment-clc-004-reply', body: 'The answer.' });
  const replyId = (await res.json()).id;
  assert.equal(typeof replyId, 'number');

  res = await post('/seen', { message_id: 'page-comment-clc-004', file: 'x.md', answer_id: String(replyId) });
  assert.equal(res.status, 201);
  const { entries } = await (await api('/message?kind=page-comment&state=answered&format=json&limit=200')).json();
  const row = rowByRef(entries, 'page-comment-clc-004');
  assert.equal(row.comment_state, 'answered');
  assert.equal(row.answer_id, replyId);
  // The documented retrieval: GET /message/:answer_id is the reply body.
  assert.match(await (await api(`/message/${replyId}`)).text(), /The answer\./);
  // A duplicate /seen without answer_id must not erase the pointer.
  res = await post('/seen', { message_id: 'page-comment-clc-004' });
  assert.equal(res.status, 200);
  const again = (await (await api('/message?kind=page-comment&state=answered&format=json&limit=200')).json()).entries;
  assert.equal(rowByRef(again, 'page-comment-clc-004').answer_id, replyId);
});

test('TP-clc-005: comment index lines append the state (and reply pointer); other kinds unchanged', async () => {
  const text = await (await api('/message?kind=page-comment&limit=200')).text();
  assert.match(text, /page-comment-clc-001 \| \d+ chars \| waiting$/m);
  assert.match(text, new RegExp('page-comment-clc-004 \\| \\d+ chars \\| answered -> reply \\d+$', 'm'));
  const other = await (await api('/message?kind=report&limit=200')).text();
  assert.match(other, /clc-report-1 \| \d+ chars$/m); // byte-identical shape, no state suffix
});

test('TP-clc-006/007/008: 24h expiry hits ONLY waiting; never_processed is terminal (claim denied, seen never resurrects)', async () => {
  const { proc: p2, base: b2 } = await spawnServer({ COMMENT_WAIT_EXPIRY_HOURS: '0' });
  try {
    const s = on(b2);
    for (const ref of ['pc-exp-1', 'pc-read-1', 'pc-ans-1']) {
      assert.equal((await s.post('/message', { kind: 'page-comment', subject: `Page comment: ${ref}`, ref, body: 'b' })).status, 201);
    }
    assert.equal((await s.post('/claim', { key: 'pc-read-1' })).status, 201); // -> read (stale threshold default 60 min)
    assert.equal((await s.post('/seen', { message_id: 'pc-ans-1' })).status, 201); // -> answered (no reply stored)

    // The poll triggers the sweep: the waiting row expires, read/answered are IMMUNE.
    const waiting = (await (await s.api('/message?kind=page-comment&state=waiting&format=json&limit=200')).json()).entries;
    assert.equal(waiting.length, 0);
    const all = (await (await s.api('/message?kind=page-comment&format=json&limit=200')).json()).entries;
    assert.equal(rowByRef(all, 'pc-exp-1').comment_state, 'never_processed'); // TP-clc-006
    assert.equal(rowByRef(all, 'pc-read-1').comment_state, 'read'); // TP-clc-007
    assert.equal(rowByRef(all, 'pc-ans-1').comment_state, 'answered'); // TP-clc-007

    // Never-hide: exactly ONE compliance line per drop, agent comment-lifecycle — and
    // sweeping again (the GETs above already re-swept) must not repeat it.
    const failed = await (await s.api('/log?area=inbox&status=failed&format=json&limit=500')).json();
    const drops = failed.entries.filter((l) => l.message.includes('pc-exp-1') && l.agent === 'comment-lifecycle');
    assert.equal(drops.length, 1);
    assert.match(drops[0].message, /never_processed/);
    assert.match(drops[0].message, /WS-M3/);

    // TP-clc-008: terminal — no claim (no dispatch), and /seen records but never revives.
    const denied = await (await s.post('/claim', { key: 'pc-exp-1' })).json();
    assert.equal(denied.granted, false);
    assert.equal((await s.post('/seen', { message_id: 'pc-exp-1' })).status, 201);
    const after = (await (await s.api('/message?kind=page-comment&format=json&limit=200')).json()).entries;
    assert.equal(rowByRef(after, 'pc-exp-1').comment_state, 'never_processed');
    assert.match(await (await s.api('/seen')).text(), /pc-exp-1/);
  } finally {
    p2.kill();
  }
});

test('TP-clc-009: a stale read claim reverts to waiting with its own compliance line; no premature expiry', async () => {
  const { proc: p3, base: b3 } = await spawnServer({ COMMENT_READ_STALE_MINUTES: '0' });
  try {
    const s = on(b3);
    assert.equal((await s.post('/message', { kind: 'page-comment', subject: 'Page comment: stale', ref: 'pc-stale-1', body: 'b' })).status, 201);
    assert.equal((await s.post('/claim', { key: 'pc-stale-1' })).status, 201); // -> read
    const waiting = (await (await s.api('/message?kind=page-comment&state=waiting&format=json&limit=200')).json()).entries;
    // Sweep reverted the crashed claim to waiting; being <24h old it did NOT expire.
    assert.equal(rowByRef(waiting, 'pc-stale-1').comment_state, 'waiting');
    const failed = await (await s.api('/log?area=inbox&status=failed&format=json&limit=500')).json();
    const reverts = failed.entries.filter((l) => l.message.includes('pc-stale-1') && l.agent === 'comment-lifecycle');
    assert.equal(reverts.length, 1);
    assert.match(reverts[0].message, /reverted to waiting/);
  } finally {
    p3.kill();
  }
});

test('TP-clc-010: pre-lifecycle DB migrates on start — seen refs backfill answered, the rest waiting; restart idempotent', async () => {
  const { DatabaseSync } = require('node:sqlite');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'logapi-clc-mig-'));
  const dbPath = path.join(dir, 'logs.db');
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE message (
      id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT NOT NULL, date TEXT NOT NULL,
      kind TEXT NOT NULL, subject TEXT, ref TEXT, body TEXT NOT NULL, meta TEXT
    );
    CREATE TABLE inbox_seen (message_id TEXT PRIMARY KEY, ts TEXT NOT NULL, file TEXT);
  `);
  const now = new Date().toISOString();
  const ins = db.prepare('INSERT INTO message (ts, date, kind, subject, ref, body) VALUES (?, ?, ?, ?, ?, ?)');
  ins.run(now, '2026-07-20', 'page-comment', 'old seen', 'pc-old-seen', 'b');
  ins.run(now, '2026-07-20', 'page-comment', 'old unseen', 'pc-old-unseen', 'b');
  db.prepare('INSERT INTO inbox_seen (message_id, ts) VALUES (?, ?)').run('pc-old-seen', now);
  db.close();

  let { proc: p4, base: b4 } = await spawnServer({}, dbPath);
  try {
    const states = async (base_) => {
      const { entries } = await (await on(base_).api('/message?kind=page-comment&format=json&limit=200')).json();
      return Object.fromEntries(entries.map((m) => [m.ref, m.comment_state]));
    };
    assert.deepEqual(await states(b4), { 'pc-old-seen': 'answered', 'pc-old-unseen': 'waiting' });
    p4.kill();
    await new Promise((r) => p4.once('exit', r));
    ({ proc: p4, base: b4 } = await spawnServer({}, dbPath)); // idempotent restart
    assert.deepEqual(await states(b4), { 'pc-old-seen': 'answered', 'pc-old-unseen': 'waiting' });
  } finally {
    p4.kill();
  }
});

test('TP-summary-attention-001: a later line in the same area resolves an attention item', async () => {
  await post('/log', { repo: 'attn-repo', area: 'feat/x', status: 'PR-open', message: 'PR #9 opened' });
  await post('/log', { repo: 'attn-repo', area: 'feat/y', status: 'blocked', message: 'waiting on decision' });
  await post('/log', { repo: 'attn-repo', area: 'feat/x', status: 'done', message: 'PR #9 merged' });

  const text = await (await api('/summary?days=1')).text();
  const section = text.split('## ').find((s) => s.startsWith('attn-repo'));
  assert.ok(section, 'attn-repo section present');
  assert.doesNotMatch(section, /PR #9 opened/);
  assert.match(section, /waiting on decision/);
});
