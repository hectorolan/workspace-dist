'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  cleanSubject,
  normalizeSubject,
  extractMessageIds,
  ensureConversationSchema,
  assignConversation,
} = require('../conversations');
const { makeDb, insertMessage } = require('./helpers');

const store = (db, fields, nowIso) => {
  const row = insertMessage(db, fields);
  return { row, conv: assignConversation(db, row, nowIso || row.ts) };
};

test('TP-email-conversations-008: subject normalization strips prefixes recursively', () => {
  assert.equal(normalizeSubject('Re: Agent Reply: Deploy status'), 'deploy status');
  assert.equal(normalizeSubject('RE: re: Fwd: FW: hello'), 'hello');
  assert.equal(normalizeSubject('Agent Reply (failed): Weekly  report '), 'weekly report');
  assert.equal(normalizeSubject('Agent: run the backlog'), 'run the backlog');
  assert.equal(cleanSubject('Re: Agent Reply: Deploy Status'), 'Deploy Status');
  assert.equal(normalizeSubject(''), '');
  assert.equal(normalizeSubject(null), '');
});

test('TP-email-conversations-008: message-id extraction', () => {
  assert.deepEqual(extractMessageIds('<a@x> <b@y>'), ['<a@x>', '<b@y>']);
  assert.deepEqual(extractMessageIds(undefined), []);
  assert.deepEqual(extractMessageIds('no ids here'), []);
});

test('TP-email-conversations-001: fresh request creates a conversation titled by subject', () => {
  const db = makeDb();
  const { row, conv } = store(db, {
    kind: 'inbox-request',
    subject: 'Agent: Deploy status',
    ref: 'r1',
    meta: { 'message-id': '<m1@mail>' },
  });
  assert.equal(conv.created, true);
  assert.equal(conv.title, 'Deploy status');
  const c = db.prepare('SELECT * FROM conversation WHERE id = ?').get(conv.id);
  assert.equal(c.title, 'Deploy status');
  assert.equal(c.subject_key, 'deploy status');
  const m = db.prepare('SELECT conversation_id FROM message WHERE id = ?').get(row.id);
  assert.equal(m.conversation_id, conv.id);
});

test('TP-email-conversations-002/003: reply and error join via the ref slug pair', () => {
  const db = makeDb();
  const { conv } = store(db, { kind: 'inbox-request', subject: 'A', ref: '20260717T1-1', meta: { 'message-id': '<m1@mail>' } });
  const reply = store(db, { kind: 'inbox-reply', subject: 'A', ref: '20260717T1-1-reply' });
  assert.equal(reply.conv.id, conv.id);
  assert.equal(reply.conv.created, false);
  const error = store(db, { kind: 'inbox-error', subject: 'A', ref: '20260717T1-1-error' });
  assert.equal(error.conv.id, conv.id);
});

test('TP-email-conversations-004: follow-up joins via References chain', () => {
  const db = makeDb();
  const { conv } = store(db, { kind: 'inbox-request', subject: 'Plan the week', ref: 'a-1', meta: { 'message-id': '<orig@mail>' } });
  // Different subject on the follow-up: only the chain can link it.
  const follow = store(db, {
    kind: 'inbox-request',
    subject: 'Totally different words',
    ref: 'b-1',
    meta: { 'message-id': '<f@mail>', 'in-reply-to': '<agent-reply@gmail>', references: '<orig@mail> <agent-reply@gmail>' },
  });
  assert.equal(follow.conv.id, conv.id);
  assert.equal(follow.conv.created, false);
});

test('TP-email-conversations-005: follow-up joins via In-Reply-To alone', () => {
  const db = makeDb();
  const { conv } = store(db, { kind: 'inbox-request', subject: 'X', ref: 'a-1', meta: { 'message-id': '<orig@mail>' } });
  const follow = store(db, {
    kind: 'inbox-request',
    subject: 'Unrelated subject',
    ref: 'b-1',
    meta: { 'message-id': '<f@mail>', 'in-reply-to': '<orig@mail>' },
  });
  assert.equal(follow.conv.id, conv.id);
});

test('TP-email-conversations-006: follow-up joins via normalized subject when no chain', () => {
  const db = makeDb();
  const { conv } = store(db, { kind: 'inbox-request', subject: 'Backlog sweep', ref: 'a-1', meta: { 'message-id': '<m1@mail>' } });
  const follow = store(db, { kind: 'inbox-request', subject: 'Re: Agent Reply: Backlog sweep', ref: 'b-1', meta: { 'message-id': '<m2@mail>' } });
  assert.equal(follow.conv.id, conv.id);
  assert.equal(follow.conv.created, false);
});

test('TP-email-conversations-007: subject match expires after the 30-day window', () => {
  const db = makeDb();
  const old = new Date(Date.now() - 40 * 86400000).toISOString();
  const first = store(db, { kind: 'inbox-request', subject: 'status', ref: 'a-1', ts: old, meta: { 'message-id': '<m1@mail>' } }, old);
  const later = store(db, { kind: 'inbox-request', subject: 'Re: status', ref: 'b-1', meta: { 'message-id': '<m2@mail>' } });
  assert.notEqual(later.conv.id, first.conv.id);
  assert.equal(later.conv.created, true);
});

test('TP-email-conversations-009: LIKE wildcards in candidate ids cannot false-match', () => {
  const db = makeDb();
  const { conv } = store(db, { kind: 'inbox-request', subject: 'A', ref: 'a-1', meta: { 'message-id': '<abcdef@mail>' } });
  // <ab_def@mail> would LIKE-match <abcdef@mail> without escaping.
  const follow = store(db, {
    kind: 'inbox-request',
    subject: 'B',
    ref: 'b-1',
    meta: { 'message-id': '<x@mail>', 'in-reply-to': '<ab_def@mail>' },
  });
  assert.notEqual(follow.conv.id, conv.id);
});

// TP-email-conversations-016 (backfill grouping) retired 2026-07-19 with
// backfill-conversations.js — the one-time migration ran 2026-07-17 in production;
// git history keeps both the script and its test.

test('TP-page-comments-001: page comment threads; runner reply and same-page follow-up join it', () => {
  const db = makeDb();
  const subject = 'Page comment: Income pipeline (plans/income-pipeline)';
  const { conv } = store(db, {
    kind: 'page-comment',
    subject,
    ref: 'page-comment-1753280000000',
    meta: { source: 'ho-nexus', pageType: 'plans', slug: 'income-pipeline' },
  });
  assert.equal(conv.created, true);
  assert.equal(conv.title, subject);
  // The runner's reply carries the same subject; the <ref>-reply slug has no
  // inbox-request base, so the normalized-subject rule links it.
  const reply = store(db, { kind: 'inbox-reply', subject, ref: 'page-comment-1753280000000-reply' });
  assert.equal(reply.conv.id, conv.id);
  assert.equal(reply.conv.created, false);
  // A later comment on the same page continues the same conversation.
  const followUp = store(db, {
    kind: 'page-comment',
    subject,
    ref: 'page-comment-1753280000999',
    meta: { source: 'ho-nexus', pageType: 'plans', slug: 'income-pipeline' },
  });
  assert.equal(followUp.conv.id, conv.id);
  assert.equal(followUp.conv.created, false);
});

test('TP-email-conversations-015: ensureConversationSchema is idempotent', () => {
  const db = makeDb({ migrate: false });
  ensureConversationSchema(db);
  ensureConversationSchema(db); // second run must not throw (ALTER guarded)
  const cols = db.prepare("SELECT name FROM pragma_table_info('message')").all().map((c) => c.name);
  assert.ok(cols.includes('conversation_id'));
});

test('TP-conv-status-001: fresh schema has the status column defaulting to active', () => {
  const db = makeDb({ migrate: false });
  ensureConversationSchema(db);
  const cols = db.prepare("SELECT name FROM pragma_table_info('conversation')").all().map((c) => c.name);
  assert.ok(cols.includes('status'));
  const { row } = store(db, {
    kind: 'inbox-request', subject: 'Status default check', ref: 's1',
    meta: { 'message-id': '<sd1@mail>' },
  });
  const c = db.prepare('SELECT status FROM message m JOIN conversation cv ON cv.id = m.conversation_id WHERE m.id = ?').get(row.id);
  assert.equal(c.status, 'active');
});

test('TP-conv-status-002: migration adds status to a pre-status conversation table; existing rows read active; idempotent', () => {
  const db = makeDb({ migrate: false });
  // Live DB shape BEFORE the status column existed: conversation table without status.
  db.exec(`
    CREATE TABLE conversation (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      subject_key TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
  const now = new Date().toISOString();
  db.prepare('INSERT INTO conversation (title, subject_key, created_at, updated_at) VALUES (?, ?, ?, ?)')
    .run('Legacy conversation', 'legacy', now, now);
  ensureConversationSchema(db); // migrate
  ensureConversationSchema(db); // idempotent second run (guarded ALTER must not throw)
  const cols = db.prepare("SELECT name FROM pragma_table_info('conversation')").all().map((c) => c.name);
  assert.ok(cols.includes('status'));
  const legacy = db.prepare('SELECT status FROM conversation WHERE subject_key = ?').get('legacy');
  assert.equal(legacy.status, 'active');
});

test('TP-email-conversations-017: unparsable meta still resolves (falls back to subject/create)', () => {
  const db = makeDb();
  const info = db
    .prepare("INSERT INTO message (ts, date, kind, subject, ref, body, meta) VALUES (?, ?, 'inbox-request', 'S', 'r1', 'b', 'not-json')")
    .run(new Date().toISOString(), new Date().toISOString().slice(0, 10));
  const row = db.prepare('SELECT * FROM message WHERE id = ?').get(info.lastInsertRowid);
  const conv = assignConversation(db, row, row.ts);
  assert.equal(conv.created, true);
  assert.equal(db.prepare('SELECT conversation_id FROM message WHERE id = ?').get(row.id).conversation_id, conv.id);
});
