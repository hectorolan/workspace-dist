// threads.js — the document-thread model (design: ws plan get nexus-document-threads-design, W1).
// A thread is an anchor (doc_kind, doc_ref) plus ordered entries; entry BODIES stay
// message rows — thread_entry maps relationships only (the CEO's call, 2026-08-01:
// a table, not JSON riding message meta), so "the thread for plan X" is one indexed
// query and the existing message machinery (dedupe, lifecycle, backup) is untouched.
// Shared by server.js the same way conversations.js is; unit-tested via the server suite.
'use strict';

// Flat threads: one CEO, alternating turns — no parent pointer by design.
const THREAD_ROLES = ['ceo', 'agent', 'trigger'];

// Anchor kinds: a plan slug, a digest date-ref, an agent/skill/knowledge name, or
// `conversation` + its own ref for document-less threads (N2).
const THREAD_DOC_KINDS = ['plan', 'digest', 'agent', 'skill', 'knowledge', 'conversation'];

// The hub page-comment meta contract (ws plan get page-comments-design) carries
// {"source":"hub" (older rows: "ho-nexus"),"pageType":"<plans|digests|agents|skills|knowledge|conversations>","slug":...}
// — mapped here into a thread anchor at intake. Unknown pageType → no anchor (the
// comment still stores and flows through the lifecycle exactly as before).
// `knowledge` (the hub governing-doc pages) joined with document-threads N3:
// no prior knowledge comment exists (those pages had no box), so the addition is
// purely forward-looking.
const PAGE_TYPE_TO_DOC_KIND = {
  plans: 'plan',
  digests: 'digest',
  agents: 'agent',
  skills: 'skill',
  knowledge: 'knowledge',
  conversations: 'conversation',
};

/** Boot migration — same live-DB-safe pattern as every other table server.js owns. */
function ensureThreadSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS thread_entry (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      doc_kind   TEXT NOT NULL,                 -- plan|digest|agent|skill|knowledge|conversation
      doc_ref    TEXT NOT NULL,                 -- plan slug, digest date-ref, conversation ref
      message_id INTEGER NOT NULL,              -- entry body = this message row (never duplicated)
      role       TEXT NOT NULL,                 -- ceo|agent|trigger
      created    TEXT NOT NULL                  -- ISO 8601 UTC, set by the server; flat ordering key
    );
    CREATE INDEX IF NOT EXISTS idx_thread_entry_anchor ON thread_entry(doc_kind, doc_ref);
    CREATE INDEX IF NOT EXISTS idx_thread_entry_message ON thread_entry(message_id);
  `);
}

/**
 * Map a page-comment's meta JSON into a thread anchor, or null when the meta is
 * absent/unparseable/unmappable — callers treat null as "no thread", never an error.
 * @param {string|null|undefined} metaJson
 * @returns {{docKind: string, docRef: string} | null}
 */
function anchorFromMeta(metaJson) {
  if (!metaJson) return null;
  let meta;
  try { meta = JSON.parse(metaJson); } catch { return null; }
  if (!meta || typeof meta !== 'object') return null;
  const docKind = PAGE_TYPE_TO_DOC_KIND[meta.pageType];
  const docRef = typeof meta.slug === 'string' ? meta.slug.trim() : '';
  if (!docKind || !docRef) return null;
  return { docKind, docRef };
}

/**
 * Insert one thread entry, idempotently: an identical (doc_kind, doc_ref,
 * message_id, role) row is returned as-is (duplicate: true) so runner retries
 * can never double-post. No unique constraint on message_id alone — a `trigger`
 * entry deliberately attaches one message to a second anchor.
 */
function insertThreadEntry(db, { docKind, docRef, messageId, role }) {
  const existing = db.prepare(
    'SELECT * FROM thread_entry WHERE doc_kind = ? AND doc_ref = ? AND message_id = ? AND role = ?'
  ).get(docKind, docRef, messageId, role);
  if (existing) return { entry: existing, duplicate: true };
  const info = db.prepare(
    'INSERT INTO thread_entry (doc_kind, doc_ref, message_id, role, created) VALUES (?, ?, ?, ?, ?)'
  ).run(docKind, docRef, messageId, role, new Date().toISOString());
  const entry = db.prepare('SELECT * FROM thread_entry WHERE id = ?').get(info.lastInsertRowid);
  return { entry, duplicate: false };
}

/**
 * Re-anchor one existing entry to a new (doc_kind, doc_ref) — moving is the ONLY
 * mutation on a thread entry (no delete: an entry that can vanish is a worse
 * primitive than one that can only be re-homed — the CEO's backlog-month rule,
 * 2026-08-02). Idempotent: the current anchor is a no-op (`moved: false`). An
 * identical (anchor, message_id, role) row already at the target under another
 * id is a `conflict` — the caller refuses rather than creating a duplicate pair.
 */
function reanchorThreadEntry(db, { id, docKind, docRef }) {
  const row = db.prepare('SELECT * FROM thread_entry WHERE id = ?').get(id);
  if (!row) return { error: 'not-found' };
  if (row.doc_kind === docKind && row.doc_ref === docRef) return { entry: row, moved: false };
  const clash = db.prepare(
    'SELECT id FROM thread_entry WHERE doc_kind = ? AND doc_ref = ? AND message_id = ? AND role = ? AND id <> ?'
  ).get(docKind, docRef, row.message_id, row.role, id);
  if (clash) return { error: 'conflict', clashId: clash.id };
  db.prepare('UPDATE thread_entry SET doc_kind = ?, doc_ref = ? WHERE id = ?').run(docKind, docRef, id);
  const entry = db.prepare('SELECT * FROM thread_entry WHERE id = ?').get(id);
  return { entry, moved: true };
}

module.exports = { THREAD_ROLES, THREAD_DOC_KINDS, PAGE_TYPE_TO_DOC_KIND, ensureThreadSchema, anchorFromMeta, insertThreadEntry, reanchorThreadEntry };
