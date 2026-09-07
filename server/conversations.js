// conversations.js — threading logic for the email ask/response history.
// Single source of truth shared by server.js (live threading on POST /message)
// (backfill-conversations.js, its one-time consumer, ran 2026-07-17 and was removed).
//
// Resolution order for an inbox-request:
//   1. chain — any Message-ID from the mail's In-Reply-To/References found in the
//      meta of an already-threaded message joins that conversation. Agent replies'
//      own Gmail Message-IDs are never stored, but References carries Hector's
//      original ids, so real reply chains resolve here.
//   2. subject — normalized subject (Re:/Fwd:/Agent:/Agent Reply: prefixes stripped)
//      matches a conversation active in the last SUBJECT_MATCH_WINDOW_DAYS.
//   3. create — new conversation titled with the cleaned subject (ws run-inbox may
//      upgrade the title with one haiku call via PATCH /conversation/:id).
// inbox-reply / inbox-error rows join their request's conversation via the
// `<name>` ↔ `<name>-reply` / `<name>-error` ref slug convention; an orphan
// reply falls through to the request rules above.
'use strict';

// page-comment (hub comment box → orchestrator, `ws plan get
// page-comments-design`) threads like a request: its runner-controlled subject
// "Page comment: <title> (<pageType>/<slug>)" keys the conversation, and the
// runner's inbox-reply joins by that same subject.
const THREADED_KINDS = ['inbox-request', 'inbox-reply', 'inbox-error', 'page-comment'];
const SUBJECT_MATCH_WINDOW_DAYS = 30;

// Prefixes that mail clients / the agent mailer stack onto subjects.
const PREFIX_RE = /^(?:re|fwd?|aw)\s*:\s*|^agent\s+reply(?:\s*\(failed\))?\s*:\s*|^agent\s*:\s*/i;

/** Strip reply/agent prefixes (repeatedly) and collapse whitespace; keeps case. */
function cleanSubject(subject) {
  let s = String(subject || '').replace(/\s+/g, ' ').trim();
  let prev;
  do {
    prev = s;
    s = s.replace(PREFIX_RE, '').trim();
  } while (s !== prev);
  return s;
}

/** Case-folded cleanSubject — the conversation matching key. */
function normalizeSubject(subject) {
  return cleanSubject(subject).toLowerCase();
}

/** All `<...>` Message-ID tokens in a header value string. */
function extractMessageIds(value) {
  return String(value || '').match(/<[^<>\s]+>/g) || [];
}

/** Escape SQL LIKE wildcards so Message-IDs containing % or _ can't false-match. */
function likeEscape(s) {
  return String(s).replace(/[\\%_]/g, (c) => '\\' + c);
}

/** Idempotent DDL for the conversation table + message.conversation_id column. */
function ensureConversationSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS conversation (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      title       TEXT NOT NULL,                 -- cleaned subject, upgraded by one AI call on creation
      subject_key TEXT,                          -- normalized subject used for follow-up matching
      status      TEXT NOT NULL DEFAULT 'active', -- active|archived (soft-delete, never hard-deleted)
      created_at  TEXT NOT NULL,                 -- ISO 8601 UTC
      updated_at  TEXT NOT NULL                  -- ISO 8601 UTC, bumped on every new message
    );
    CREATE INDEX IF NOT EXISTS idx_conversation_subject_key ON conversation(subject_key);
  `);
  const hasCol = db
    .prepare("SELECT COUNT(*) AS n FROM pragma_table_info('message') WHERE name = 'conversation_id'")
    .get().n;
  if (!hasCol) db.exec('ALTER TABLE message ADD COLUMN conversation_id INTEGER');
  db.exec('CREATE INDEX IF NOT EXISTS idx_message_conversation ON message(conversation_id)');
  // Idempotent ALTER for live DBs whose conversation table predates the status
  // column — same guarded pattern as the message.conversation_id ALTER above and
  // the plan.kind ALTER in server.js. Existing rows read back as 'active'.
  const hasStatus = db
    .prepare("SELECT COUNT(*) AS n FROM pragma_table_info('conversation') WHERE name = 'status'")
    .get().n;
  if (!hasStatus) db.exec("ALTER TABLE conversation ADD COLUMN status TEXT NOT NULL DEFAULT 'active'");
}

/**
 * Resolve the conversation for a stored message row ({kind, subject, ref, meta}).
 * Returns { id, created, title }. `nowIso` is the message's own timestamp so the
 * backfill applies the subject window historically.
 */
function resolveConversation(db, msg, nowIso) {
  const now = nowIso || new Date().toISOString();

  // Replies/errors join their request's conversation via the ref slug pair.
  if (msg.kind === 'inbox-reply' || msg.kind === 'inbox-error') {
    const base = String(msg.ref || '').replace(/-(reply|error)$/, '');
    if (base) {
      const req = db
        .prepare(
          "SELECT conversation_id FROM message WHERE kind = 'inbox-request' AND ref = ? AND conversation_id IS NOT NULL"
        )
        .get(base);
      if (req) return { id: req.conversation_id, created: false, title: null };
    }
    // Orphan reply (request missing) — fall through to the request rules.
  }

  // 1. Chain: In-Reply-To first (nearest ancestor), then References newest→oldest.
  let meta = {};
  try {
    meta = JSON.parse(msg.meta || '{}') || {};
  } catch {
    meta = {};
  }
  const own = String(meta['message-id'] || '');
  const candidates = [
    ...extractMessageIds(meta['in-reply-to']),
    ...extractMessageIds(meta['references']).reverse(),
  ].filter((id, i, a) => id !== own && a.indexOf(id) === i);
  for (const id of candidates) {
    const hit = db
      .prepare(
        "SELECT conversation_id FROM message WHERE conversation_id IS NOT NULL AND meta LIKE ? ESCAPE '\\' ORDER BY id DESC LIMIT 1"
      )
      .get('%' + likeEscape(id) + '%');
    if (hit) return { id: hit.conversation_id, created: false, title: null };
  }

  // 2. Subject match within the activity window.
  const key = normalizeSubject(msg.subject);
  if (key) {
    const cutoff = new Date(Date.parse(now) - SUBJECT_MATCH_WINDOW_DAYS * 86400000).toISOString();
    const conv = db
      .prepare('SELECT id FROM conversation WHERE subject_key = ? AND updated_at >= ? ORDER BY id DESC LIMIT 1')
      .get(key, cutoff);
    if (conv) return { id: conv.id, created: false, title: null };
  }

  // 3. New conversation.
  const title = cleanSubject(msg.subject) || '(no subject)';
  const info = db
    .prepare('INSERT INTO conversation (title, subject_key, created_at, updated_at) VALUES (?, ?, ?, ?)')
    .run(title, key || null, now, now);
  return { id: Number(info.lastInsertRowid), created: true, title };
}

/**
 * Resolve + link one message row and bump the conversation's activity timestamp.
 * Returns { id, created, title } (title only set when the conversation was created).
 */
function assignConversation(db, msgRow, nowIso) {
  const now = nowIso || new Date().toISOString();
  const conv = resolveConversation(db, msgRow, now);
  db.prepare('UPDATE message SET conversation_id = ? WHERE id = ?').run(conv.id, msgRow.id);
  db.prepare('UPDATE conversation SET updated_at = MAX(updated_at, ?) WHERE id = ?').run(now, conv.id);
  if (!conv.title) {
    const row = db.prepare('SELECT title FROM conversation WHERE id = ?').get(conv.id);
    conv.title = row ? row.title : null;
  }
  return conv;
}

module.exports = {
  THREADED_KINDS,
  SUBJECT_MATCH_WINDOW_DAYS,
  cleanSubject,
  normalizeSubject,
  extractMessageIds,
  likeEscape,
  ensureConversationSchema,
  resolveConversation,
  assignConversation,
};
