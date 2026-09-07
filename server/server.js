// server.js — central logging API (Express + built-in node:sqlite).
// One table replaces every ops/log.md append: agents make ONE HTTP call instead of
// read-file + edit + git add/commit/push. POST re-reads the inserted row before
// returning it, so a 201 response is proof the write landed.
//
// Runs inside the agent container (started by server/start.sh from entrypoint.sh).
// Env: LOG_DB_PATH (default ~/sources/data/logs.db), LOG_API_PORT (8790),
//      LOG_API_HOST (127.0.0.1), LOG_API_KEY (when set, X-Api-Key required;
//      REQUIRED whenever LOG_API_HOST is not loopback — startup refuses otherwise).
'use strict';

const express = require('express');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { DatabaseSync } = require('node:sqlite');
const { THREADED_KINDS, ensureConversationSchema, assignConversation } = require('./conversations');
const { THREAD_ROLES, THREAD_DOC_KINDS, ensureThreadSchema, anchorFromMeta, insertThreadEntry, reanchorThreadEntry } = require('./threads');

const DB_PATH = process.env.LOG_DB_PATH || path.join(os.homedir(), 'sources', 'data', 'logs.db');
const PORT = Number(process.env.LOG_API_PORT || 8790);
const HOST = process.env.LOG_API_HOST || '127.0.0.1';
const API_KEY = process.env.LOG_API_KEY || '';

// Fail fast: an empty LOG_API_KEY on a non-loopback bind would publish an
// UNAUTHENTICATED API to the network — and POST /message (kind page-comment)
// feeds agent sessions with Bash, so that is a remote-code-execution surface,
// not just a data leak. Loopback binds (the container-internal default and the
// test servers) stay keyless-capable.
const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', 'localhost']);
if (!API_KEY && !LOOPBACK_HOSTS.has(HOST)) {
  console.error(
    `[log-api] refusing to start: LOG_API_KEY is empty while LOG_API_HOST=${HOST} is not loopback. ` +
    'Set LOG_API_KEY in .env (see .env.example) or bind 127.0.0.1.'
  );
  process.exit(1);
}

fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
const db = new DatabaseSync(DB_PATH);
db.exec(`
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS log (
    id      INTEGER PRIMARY KEY AUTOINCREMENT,
    ts      TEXT NOT NULL,                      -- ISO 8601 UTC, set by the server
    date    TEXT NOT NULL,                      -- YYYY-MM-DD (schedule-timezone date, see localDate)
    repo    TEXT NOT NULL DEFAULT 'workspace',
    area    TEXT NOT NULL,                      -- branch or activity area
    status  TEXT NOT NULL,                      -- done|blocked|failed|PR-open|sent|...
    message TEXT NOT NULL,
    agent   TEXT,                               -- orchestrator|newsroom|devops|implementer|runner|main
    source  TEXT NOT NULL DEFAULT 'api'         -- api|import|fallback-replay
  );
  CREATE INDEX IF NOT EXISTS idx_log_repo_date ON log(repo, date);
  CREATE INDEX IF NOT EXISTS idx_log_status ON log(status);
  CREATE TABLE IF NOT EXISTS message (
    id      INTEGER PRIMARY KEY AUTOINCREMENT,
    ts      TEXT NOT NULL,                      -- ISO 8601 UTC, set by the server
    date    TEXT NOT NULL,                      -- YYYY-MM-DD
    kind    TEXT NOT NULL,                      -- inbox-request|inbox-reply|daily-digest|weekly-portfolio|report|...
    subject TEXT,
    ref     TEXT,                               -- stable id: request name, file basename — dedupe key with kind
    body    TEXT NOT NULL,                      -- full markdown/text content
    meta    TEXT                                -- optional JSON string (message-id, from/to, path)
  );
  CREATE INDEX IF NOT EXISTS idx_message_kind_date ON message(kind, date);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_message_kind_ref ON message(kind, ref) WHERE ref IS NOT NULL;
  CREATE TABLE IF NOT EXISTS inbox_seen (
    message_id TEXT PRIMARY KEY,               -- email Message-ID already handled
    ts         TEXT NOT NULL,                  -- ISO 8601 UTC, set by the server
    file       TEXT                            -- inbox/<name>.md it was captured to
  );
  CREATE TABLE IF NOT EXISTS plan (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    slug       TEXT NOT NULL UNIQUE,           -- stable key: 'income-pipeline', 'mobile-nexus'
    title      TEXT NOT NULL,
    kind       TEXT NOT NULL DEFAULT 'plan',   -- plan|audit|design|test-plan|doc|baseline
    status     TEXT NOT NULL DEFAULT 'active', -- active|draft|done|archived
    repo       TEXT,                           -- optional related repo
    body       TEXT NOT NULL,                  -- full markdown
    created_at TEXT NOT NULL,                  -- ISO 8601 UTC, set by the server
    updated_at TEXT NOT NULL,                  -- ISO 8601 UTC, bumped on every update
    updated_by TEXT                            -- agent name
  );
  CREATE TABLE IF NOT EXISTS plan_revision (   -- replaces the git history the md files had
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    plan_id    INTEGER NOT NULL,
    ts         TEXT NOT NULL,
    body       TEXT NOT NULL,                  -- body as it was BEFORE the update
    updated_by TEXT
  );
  CREATE TABLE IF NOT EXISTS station (         -- W3/D1b: OBSERVED station state only
    env        TEXT PRIMARY KEY,               -- WS_ENV (definition stays in configs/environments.json)
    ts         TEXT NOT NULL,                  -- ISO 8601 UTC of the last report, set by the server
    date       TEXT NOT NULL,                  -- YYYY-MM-DD (schedule-timezone date)
    platform   TEXT,                           -- process.platform as reported
    ok         INTEGER,                        -- 1 = env-doctor found no FAIL, 0 = failing
    public_ip  TEXT,
    report     TEXT NOT NULL                   -- full JSON payload (env-doctor results + publicIp)
  );
`);
// conversation table + idempotent ALTER adding message.conversation_id (live-DB safe).
ensureConversationSchema(db);
// thread_entry table (document threads, W1 — server/threads.js): anchor + role +
// message linkage, entry bodies stay message rows. CREATE IF NOT EXISTS, live-DB safe.
ensureThreadSchema(db);
// Page-comment lifecycle columns (WS-M3 rework, 2026-07-25) — idempotent ALTERs, same
// live-DB-safe pattern as conversation_id. Only kind='page-comment' rows carry a state:
// waiting (stored, not picked up) -> read (claimed by the inbox runner, mirrors the
// WS-M2 /claim) -> answered (handling concluded; answer_id = the stored inbox-reply
// message id when a reply was produced). waiting >24h -> never_processed (TERMINAL).
// State machine + query examples documented in server/README.md (the one home).
{
  const cols = new Set(db.prepare("SELECT name FROM pragma_table_info('message')").all().map((c) => c.name));
  if (!cols.has('comment_state')) db.exec('ALTER TABLE message ADD COLUMN comment_state TEXT');
  if (!cols.has('comment_state_ts')) db.exec('ALTER TABLE message ADD COLUMN comment_state_ts TEXT');
  if (!cols.has('answer_id')) db.exec('ALTER TABLE message ADD COLUMN answer_id INTEGER');
  // Backfill pre-lifecycle rows exactly once (state NULL): a ref already in the seen
  // ledger was handled -> answered (answer_id unknown, stays NULL); anything else is
  // still waiting — the first sweep expires >24h leftovers loudly (never-hide).
  db.prepare(
    `UPDATE message SET
       comment_state = CASE WHEN ref IN (SELECT message_id FROM inbox_seen) THEN 'answered' ELSE 'waiting' END,
       comment_state_ts = ?
     WHERE kind = 'page-comment' AND comment_state IS NULL`
  ).run(new Date().toISOString());
}
// Idempotent ALTER for live DBs whose plan table predates the kind column —
// same pattern as ensureConversationSchema. Existing rows read back as 'plan';
// the orchestrator reclassifies them explicitly (never rewritten here).
if (!db.prepare("SELECT COUNT(*) AS n FROM pragma_table_info('plan') WHERE name = 'kind'").get().n) {
  db.exec("ALTER TABLE plan ADD COLUMN kind TEXT NOT NULL DEFAULT 'plan'");
}

const app = express();
app.use(express.json({ limit: '256kb' }));
// urlencoded lets shell clients post with curl --data-urlencode (no JSON escaping in bash)
app.use(express.urlencoded({ extended: false, limit: '256kb' }));

app.use((req, res, next) => {
  if (API_KEY && req.get('X-Api-Key') !== API_KEY) return res.status(401).json({ ok: false, error: 'bad api key' });
  next();
});

const line = (r) => `${r.date} | ${r.repo} | ${r.area} | ${r.status} | ${r.message}`;

// Calendar dates come from the SCHEDULE timezone (configs/jobs/jobs.json — the same
// source cli/util/clock.js reads; ported here because this file is CommonJS and
// clock.js is ESM). WS_JOBS_CONFIG overrides the config path (the same seam the
// scheduler honors; tests use it); an unreadable config falls back to the host TZ.
// Row `date` stamps AND every `?days=` cutoff use this one function, so day-window
// filters can never skew against the stored dates (audit 2026-07-26 M9 — the old
// UTC cutoffs drifted a day against locally-stamped rows around midnight UTC).
const JOBS_CONFIG = process.env.WS_JOBS_CONFIG || path.join(__dirname, '..', 'configs', 'jobs', 'jobs.json');
const scheduleTimezone = () => {
  try { return JSON.parse(fs.readFileSync(JOBS_CONFIG, 'utf8')).timezone || undefined; }
  catch { return undefined; }
};
const localDate = (d = new Date()) => new Intl.DateTimeFormat('en-CA', {
  timeZone: scheduleTimezone(), year: 'numeric', month: '2-digit', day: '2-digit',
}).format(d);
const daysCutoff = (days) => localDate(new Date(Date.now() - days * 86400000));

// ---- page-comment lifecycle (WS-M3 rework) ----------------------------------------
// Exact state names: waiting | read | answered | never_processed (terminal).
// Thresholds: 24h exact from creation ts (waiting -> never_processed, CEO decision
// 2026-07-25); 60 min read-stale — THE SAME number as /claim's ttl_minutes default,
// so the state column mirrors the one WS-M2 claim mechanism instead of adding a
// second one. The env overrides exist ONLY as test seams (compress time in the
// suite); production never sets them. Durations compare raw instants — fine per the
// clock.js rule (calendar dates come from the schedule timezone via localDate above).
const COMMENT_STATES = ['waiting', 'read', 'answered', 'never_processed'];
const WAIT_EXPIRY_HOURS = Number(process.env.COMMENT_WAIT_EXPIRY_HOURS ?? 24);
const READ_STALE_MINUTES = Number(process.env.COMMENT_READ_STALE_MINUTES ?? 60);

// Never-hide: every lifecycle drop/revert is a loud failed compliance line in the
// central log, written directly (same DB) under agent 'comment-lifecycle'.
const complianceLog = (message) => {
  db.prepare(
    'INSERT INTO log (ts, date, repo, area, status, message, agent, source) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
  ).run(new Date().toISOString(), localDate(), 'workspace', 'inbox', 'failed', message, 'comment-lifecycle', 'api');
};

// Lazy sweep, run whenever the poll (or any state-filtered read) hits GET /message:
// 1) a stale read claim (runner crashed after claiming) reverts to waiting — expiry
//    NEVER runs from read/answered, only this revert does; 2) waiting rows older than
// 24h (creation ts) become never_processed, TERMINAL: excluded from the poll, no
// dispatch, no reply ever. Each transition logs its own compliance line.
const sweepCommentLifecycle = () => {
  const now = new Date().toISOString();
  const staleCutoff = new Date(Date.now() - READ_STALE_MINUTES * 60000).toISOString();
  for (const r of db.prepare(
    "SELECT id, ref FROM message WHERE kind = 'page-comment' AND comment_state = 'read' AND comment_state_ts <= ?"
  ).all(staleCutoff)) {
    db.prepare("UPDATE message SET comment_state = 'waiting', comment_state_ts = ? WHERE id = ?").run(now, r.id);
    complianceLog(
      `compliance: page-comment ${r.ref || r.id} claim went stale (read > ${READ_STALE_MINUTES} min — runner likely crashed) — reverted to waiting (WS-M3)`
    );
  }
  const expiryCutoff = new Date(Date.now() - WAIT_EXPIRY_HOURS * 3600000).toISOString();
  for (const r of db.prepare(
    "SELECT id, ref, subject FROM message WHERE kind = 'page-comment' AND comment_state = 'waiting' AND ts <= ?"
  ).all(expiryCutoff)) {
    db.prepare("UPDATE message SET comment_state = 'never_processed', comment_state_ts = ? WHERE id = ?").run(now, r.id);
    complianceLog(
      `compliance: page-comment ${r.ref || r.id} ('${r.subject || ''}') waited > ${WAIT_EXPIRY_HOURS}h unprocessed — dropped as never_processed (terminal, no reply will be sent; re-ask if still relevant) (WS-M3)`
    );
  }
};

app.get('/health', (req, res) => {
  const { n } = db.prepare('SELECT COUNT(*) AS n FROM log').get();
  res.json({ ok: true, db: DB_PATH, entries: n });
});

// GET /identity — who this instance works for and what they named their hub.
// cli/util/ceo.js is the ONE read path for identity (CLAUDE.md "CEO is config");
// this endpoint serves it to the hub web app so the operator's name and hubTitle
// live in configs/environments.json exactly once and render wherever needed
// (the CEO's naming-is-config ruling, 2026-08-15). ceo.js is ESM and this server
// is CJS, so it loads via one lazy dynamic import, cached for the process.
let ceoIdentity = null;
app.get('/identity', async (req, res) => {
  try {
    if (!ceoIdentity) {
      const url = require('node:url').pathToFileURL(path.join(__dirname, '..', 'cli', 'util', 'ceo.js')).href;
      ceoIdentity = (await import(url)).ceo;
    }
    res.json({ ok: true, identity: ceoIdentity() });
  } catch {
    // Fail-soft like the module itself: an unreadable config must never 500 the
    // hub's page render — serve the generic labels instead.
    res.json({ ok: true, identity: { name: 'the CEO', pronouns: 'they/them', hubTitle: 'Hub' } });
  }
});

// Insert one entry, then re-read it from the table — the returned row is the proof of save.
app.post('/log', (req, res) => {
  const b = req.body || {};
  for (const f of ['area', 'status', 'message']) {
    if (typeof b[f] !== 'string' || !b[f].trim()) return res.status(400).json({ ok: false, error: `missing field: ${f}` });
  }
  const info = db.prepare(
    'INSERT INTO log (ts, date, repo, area, status, message, agent, source) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
  ).run(
    new Date().toISOString(),
    (b.date || localDate()).trim(),
    (b.repo || 'workspace').trim(),
    b.area.trim(),
    b.status.trim(),
    b.message.trim(),
    b.agent ? String(b.agent).trim() : null,
    (b.source || 'api').trim()
  );
  const entry = db.prepare('SELECT * FROM log WHERE id = ?').get(info.lastInsertRowid);
  if (!entry) return res.status(500).json({ ok: false, error: 'insert verification failed: row not found after write' });
  res.status(201).json({ ok: true, entry, line: line(entry) });
});

// Query entries. Default output is compact pipe-lines (cheapest for agent context);
// ?format=json for structured output.
app.get('/log', (req, res) => {
  const q = req.query;
  const where = [];
  const args = [];
  if (q.repo) { where.push('repo = ?'); args.push(q.repo); }
  if (q.area) { where.push('area = ?'); args.push(q.area); }
  if (q.status) { where.push('status = ?'); args.push(q.status); }
  if (q.since) { where.push('date >= ?'); args.push(q.since); }
  const days = Number(q.days || 0);
  if (days > 0) {
    where.push('date >= ?');
    args.push(daysCutoff(days));
  }
  const limit = Math.min(Number(q.limit || 50), 500);
  const rows = db.prepare(
    `SELECT * FROM log ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY id DESC LIMIT ?`
  ).all(...args, limit).reverse();
  if (q.format === 'json') return res.json({ ok: true, count: rows.length, entries: rows });
  res.type('text/plain').send(rows.map(line).join('\n') + (rows.length ? '\n' : ''));
});

// Per-repo digest for the orchestrator's status sweep: last activity, status counts,
// and open blocked/failed/PR-open items. One call replaces reading N md files.
// An item counts as open only while it is the LATEST line for its (repo, area) —
// a later line in the same area resolves it (2026-07-20: stale PR-open lines from
// unlogged merges surfaced as phantom open PRs in the digest).
app.get('/summary', (req, res) => {
  const days = Math.max(1, Number(req.query.days || 14));
  const cutoff = daysCutoff(days);
  const repos = db.prepare(
    'SELECT DISTINCT repo FROM log WHERE date >= ? ORDER BY repo'
  ).all(cutoff);
  const out = [];
  for (const { repo } of repos) {
    const last = db.prepare('SELECT * FROM log WHERE repo = ? ORDER BY id DESC LIMIT 1').get(repo);
    const counts = db.prepare(
      'SELECT status, COUNT(*) AS n FROM log WHERE repo = ? AND date >= ? GROUP BY status ORDER BY n DESC'
    ).all(repo, cutoff);
    const attention = db.prepare(
      `SELECT * FROM log l
       WHERE l.repo = ? AND l.date >= ? AND l.status IN ('blocked', 'failed', 'PR-open')
         AND l.id = (SELECT MAX(id) FROM log WHERE repo = l.repo AND area = l.area)
       ORDER BY l.id`
    ).all(repo, cutoff);
    out.push(`## ${repo}`);
    out.push(`last: ${line(last)}`);
    out.push(`counts (${days}d): ` + counts.map((c) => `${c.status}=${c.n}`).join(', '));
    if (attention.length) {
      out.push('attention:');
      for (const r of attention) out.push('  ' + line(r));
    }
    out.push('');
  }
  res.type('text/plain').send(out.length ? out.join('\n') : `no entries in the last ${days} days\n`);
});

// ---- messages: full conversations & reports (email requests/replies, digests) ----
// Runners store these automatically after each job — searchable history for follow-ups.

// Comment rows append their lifecycle state (and the reply pointer once answered) so
// `ws query --messages --kind page-comment --state <s>` reads at a glance; every other
// kind's line is byte-identical to before.
const msgLine = (m) =>
  `${m.id} | ${m.date} | ${m.kind} | ${m.subject || '-'} | ${m.ref || '-'} | ${m.body.length} chars` +
  (m.comment_state ? ` | ${m.comment_state}${m.answer_id ? ` -> reply ${m.answer_id}` : ''}` : '');

// Store one message. Dedupe on (kind, ref): re-posting the same document is a no-op
// that returns the existing row, so runner retries and backfills are idempotent.
app.post('/message', (req, res) => {
  const b = req.body || {};
  for (const f of ['kind', 'body']) {
    if (typeof b[f] !== 'string' || !b[f].trim()) return res.status(400).json({ ok: false, error: `missing field: ${f}` });
  }
  const ref = b.ref ? String(b.ref).trim() : null;
  if (ref) {
    const dup = db.prepare('SELECT * FROM message WHERE kind = ? AND ref = ?').get(b.kind.trim(), ref);
    if (dup) {
      const out = { ok: true, duplicate: true, id: dup.id, line: msgLine(dup) };
      // Retries still learn their conversation (ws run-inbox parses this).
      if (dup.conversation_id) out.conversation = { id: dup.conversation_id, created: false };
      return res.json(out);
    }
  }
  const now = new Date().toISOString();
  // A fresh page comment enters the lifecycle as 'waiting' (stored, not picked up).
  const isComment = b.kind.trim() === 'page-comment';
  const info = db.prepare(
    'INSERT INTO message (ts, date, kind, subject, ref, body, meta, comment_state, comment_state_ts) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
  ).run(
    now,
    (b.date || localDate()).trim(),
    b.kind.trim(),
    b.subject ? String(b.subject).trim() : null,
    ref,
    b.body,
    b.meta ? String(b.meta) : null,
    isComment ? 'waiting' : null,
    isComment ? now : null
  );
  const entry = db.prepare('SELECT * FROM message WHERE id = ?').get(info.lastInsertRowid);
  if (!entry) return res.status(500).json({ ok: false, error: 'insert verification failed: row not found after write' });
  const out = { ok: true, id: entry.id, line: msgLine(entry) };
  // Inbox kinds get threaded into a conversation (see conversations.js for the rules).
  // Threading must never fail the store — on error the row simply stays unthreaded
  // (the backfill script can pick it up later).
  if (THREADED_KINDS.includes(entry.kind)) {
    try {
      const conv = assignConversation(db, entry, entry.ts);
      out.conversation = { id: conv.id, created: conv.created, title: conv.title };
    } catch (e) {
      console.error(`[log-api] threading failed for message ${entry.id}: ${e.message}`);
    }
  }
  // Document-thread anchor capture at intake (W1): a page comment already knows the
  // page it was left on (meta pageType/slug) — map it to (doc_kind, doc_ref) and
  // record the comment as a role-`ceo` thread entry under that document. ADDITIONAL
  // relationship only: the lifecycle above is untouched, and a failure (or an
  // unmappable meta) never fails the store — the comment simply has no thread.
  if (isComment) {
    try {
      const anchor = anchorFromMeta(entry.meta);
      if (anchor) {
        const t = insertThreadEntry(db, { docKind: anchor.docKind, docRef: anchor.docRef, messageId: entry.id, role: 'ceo' });
        out.thread = { doc_kind: anchor.docKind, doc_ref: anchor.docRef, entry_id: t.entry.id };
      }
    } catch (e) {
      console.error(`[log-api] thread anchor capture failed for message ${entry.id}: ${e.message}`);
    }
  }
  res.status(201).json(out);
});

// ---- document threads (W1, design: ws plan get nexus-document-threads-design) -----
// A thread is (doc_kind, doc_ref) + flat entries ordered by created; entry bodies
// stay message rows (thread_entry maps relationships only — see server/threads.js
// and the "Document threads" section of server/README.md). Trust boundary: entry
// bodies ARE captured page-comment content — untrusted quoted data (WS-H2) to any
// consumer that renders it or feeds it to an agent, exactly like GET /message.

// One thread (doc_kind + doc_ref given): entries joined with their message bodies,
// role + created carried — what N1 renders below a document. JSON like
// GET /conversation/:id (bodies don't fit lines); an anchor with no entries is an
// EMPTY thread (ok, entries: []), not a 404 — most documents have no thread yet.
// Without doc_ref: the anchor listing with entry counts + last activity —
// ?doc_kind=conversation is the N2 Plans-page view of document-less threads.
app.get('/thread', (req, res) => {
  const { doc_kind: docKind, doc_ref: docRef } = req.query;
  if (docKind && !THREAD_DOC_KINDS.includes(docKind)) {
    return res.status(400).json({ ok: false, error: `invalid doc_kind: ${docKind} (expected ${THREAD_DOC_KINDS.join('|')})` });
  }
  // ?role= — flat-entries mode (hub-conversation-archive-api-2026-08-17): every
  // entry of one role joined with its message's ref + conversation_id, newest
  // first. `role=trigger` is the ONE-call reverse lookup (conversation ->
  // generated artifacts) the hub Conversations index renders badges from:
  // group by conversation_id (legacy rows) or message_ref (a page-born opener's
  // ref IS its conv-<epoch-ms> doc_ref). Composes with ?doc_kind; doc_ref has
  // its own mode below, so combining them is a 400, not a guess. JSON always.
  const role = typeof req.query.role === 'string' ? req.query.role.trim() : '';
  if (role) {
    if (!THREAD_ROLES.includes(role)) {
      return res.status(400).json({ ok: false, error: `invalid role: ${role} (expected ${THREAD_ROLES.join('|')})` });
    }
    if (docRef) return res.status(400).json({ ok: false, error: 'role cannot combine with doc_ref (one thread already carries roles per entry)' });
    const limit = Math.min(Number(req.query.limit || 500), 1000);
    const entries = db.prepare(
      `SELECT t.id, t.doc_kind, t.doc_ref, t.role, t.created, t.message_id,
              m.ref AS message_ref, m.conversation_id, m.subject
       FROM thread_entry t JOIN message m ON m.id = t.message_id
       WHERE t.role = ?${docKind ? ' AND t.doc_kind = ?' : ''}
       ORDER BY t.created DESC, t.id DESC LIMIT ?`
    ).all(...(docKind ? [role, docKind] : [role]), limit)
      .map((r) => ({ ...r, conversation_id: r.conversation_id ?? null }));
    return res.json({ ok: true, count: entries.length, entries });
  }
  if (docRef) {
    if (!docKind) return res.status(400).json({ ok: false, error: 'doc_ref requires doc_kind' });
    const entries = db.prepare(
      `SELECT t.id, t.doc_kind, t.doc_ref, t.role, t.created, t.message_id,
              m.ts, m.date, m.kind, m.subject, m.ref, m.meta, m.body,
              m.conversation_id
       FROM thread_entry t JOIN message m ON m.id = t.message_id
       WHERE t.doc_kind = ? AND t.doc_ref = ?
       ORDER BY t.created, t.id`
    ).all(docKind, docRef).map((r) => ({
      id: r.id,
      role: r.role,
      created: r.created,
      message_id: r.message_id,
      // conversation_id: the message's source conversation, so the UI can render a
      // traceable `conversations/<id>` key per entry (the CEO, 2026-08-02 — "anything
      // that helps me trace back how it is saved"). Null for messages born outside a
      // conversation (e.g. digest bodies).
      message: { id: r.message_id, ts: r.ts, date: r.date, kind: r.kind, subject: r.subject, ref: r.ref, meta: r.meta, body: r.body, conversation_id: r.conversation_id ?? null },
    }));
    return res.json({ ok: true, doc_kind: docKind, doc_ref: docRef, count: entries.length, entries });
  }
  const where = docKind ? 'WHERE t.doc_kind = ?' : '';
  const args = docKind ? [docKind] : [];
  const limit = Math.min(Number(req.query.limit || 100), 500);
  const rows = db.prepare(
    `SELECT t.doc_kind, t.doc_ref, COUNT(*) AS entries,
            MIN(t.created) AS first, MAX(t.created) AS last,
            (SELECT m.subject FROM thread_entry t2 JOIN message m ON m.id = t2.message_id
             WHERE t2.doc_kind = t.doc_kind AND t2.doc_ref = t.doc_ref
             ORDER BY t2.created, t2.id LIMIT 1) AS subject,
            (SELECT m.conversation_id FROM thread_entry t2 JOIN message m ON m.id = t2.message_id
             WHERE t2.doc_kind = t.doc_kind AND t2.doc_ref = t.doc_ref
             ORDER BY t2.created, t2.id LIMIT 1) AS conversation_id
     FROM thread_entry t ${where}
     GROUP BY t.doc_kind, t.doc_ref
     ORDER BY last DESC LIMIT ?`
  ).all(...args, limit);
  if (req.query.format === 'json') {
    // conversation_id/conversation_status: the OPENER entry's conversation and
    // its archive state (hub-conversation-archive-api-2026-08-17) — a page-born
    // (conversation, conv-<epoch-ms>) anchor always has one because page-comment
    // is a THREADED_KIND, so archive state rides conversation.status with no
    // schema change; null/null when the opener message was never threaded.
    // Text lines are untouched (agent-cheap surface, no new columns).
    const convStatus = db.prepare('SELECT status FROM conversation WHERE id = ?');
    const threads = rows.map((r) => ({
      ...r,
      conversation_id: r.conversation_id ?? null,
      conversation_status: r.conversation_id ? (convStatus.get(r.conversation_id)?.status ?? null) : null,
    }));
    return res.json({ ok: true, count: threads.length, threads });
  }
  const threadLine = (t) => `${t.doc_kind} | ${t.doc_ref} | ${t.entries} entries | ${String(t.last).slice(0, 10)} | ${t.subject || '-'}`;
  res.type('text/plain').send(rows.map(threadLine).join('\n') + (rows.length ? '\n' : ''));
});

// Append one thread entry. The body is a message row that must already exist
// (POST /message first — never duplicated here). Anchor is either explicit
// (doc_kind + doc_ref) or `anchor_ref` = a page-comment ref whose existing entry
// supplies the anchor — the inbox runner's reply path, which then needs no
// pageType mapping client-side. Idempotent on the exact entry (runner retries);
// re-reads the row before returning, 201 (created) / 200 (duplicate) = proof of save.
app.post('/thread', (req, res) => {
  const b = req.body || {};
  const role = typeof b.role === 'string' ? b.role.trim() : '';
  if (!THREAD_ROLES.includes(role)) {
    return res.status(400).json({ ok: false, error: `invalid role: ${role} (expected ${THREAD_ROLES.join('|')})` });
  }
  const messageId = Number(b.message_id || 0);
  if (!Number.isInteger(messageId) || messageId <= 0) {
    return res.status(400).json({ ok: false, error: 'missing field: message_id' });
  }
  if (!db.prepare('SELECT id FROM message WHERE id = ?').get(messageId)) {
    return res.status(404).json({ ok: false, error: `message not found: ${messageId}` });
  }
  let docKind = typeof b.doc_kind === 'string' ? b.doc_kind.trim() : '';
  let docRef = typeof b.doc_ref === 'string' ? b.doc_ref.trim() : '';
  const anchorRef = typeof b.anchor_ref === 'string' ? b.anchor_ref.trim() : '';
  if (!docKind && !docRef && anchorRef) {
    const src = db.prepare(
      `SELECT t.doc_kind, t.doc_ref FROM thread_entry t JOIN message m ON m.id = t.message_id
       WHERE m.ref = ? ORDER BY t.id LIMIT 1`
    ).get(anchorRef);
    if (!src) return res.status(404).json({ ok: false, error: `no thread entry found for anchor_ref: ${anchorRef}` });
    docKind = src.doc_kind;
    docRef = src.doc_ref;
  }
  if (!docKind || !docRef) {
    return res.status(400).json({ ok: false, error: 'missing anchor: doc_kind + doc_ref (or anchor_ref)' });
  }
  if (!THREAD_DOC_KINDS.includes(docKind)) {
    return res.status(400).json({ ok: false, error: `invalid doc_kind: ${docKind} (expected ${THREAD_DOC_KINDS.join('|')})` });
  }
  const { entry, duplicate } = insertThreadEntry(db, { docKind, docRef, messageId, role });
  if (!entry) return res.status(500).json({ ok: false, error: 'insert verification failed: row not found after write' });
  res.status(duplicate ? 200 : 201).json({ ok: true, duplicate, entry });
});

// Re-anchor one existing entry to a new (doc_kind, doc_ref) — the CEO's
// backlog-month rule (2026-08-02): a comment belongs to the month it was made
// in, so the monthly backlog prune moves prior-month `plan/backlog` entries to
// that month's `backlog-history-YYYY-MM`. Moving is the ONLY mutation (no
// delete endpoint — an entry that can vanish entirely is a worse primitive
// than one that can only be re-homed). Idempotent: the current anchor is a
// 200 no-op (`moved: false`); an identical row already at the target is a 409
// (see threads.js reanchorThreadEntry). Re-reads the row before returning.
app.patch('/thread/:id', (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    return res.status(400).json({ ok: false, error: `invalid thread entry id: ${req.params.id}` });
  }
  const b = req.body || {};
  const docKind = typeof b.doc_kind === 'string' ? b.doc_kind.trim() : '';
  const docRef = typeof b.doc_ref === 'string' ? b.doc_ref.trim() : '';
  if (!docKind || !docRef) {
    return res.status(400).json({ ok: false, error: 'missing anchor: doc_kind + doc_ref' });
  }
  if (!THREAD_DOC_KINDS.includes(docKind)) {
    return res.status(400).json({ ok: false, error: `invalid doc_kind: ${docKind} (expected ${THREAD_DOC_KINDS.join('|')})` });
  }
  const r = reanchorThreadEntry(db, { id, docKind, docRef });
  if (r.error === 'not-found') return res.status(404).json({ ok: false, error: `thread entry not found: ${id}` });
  if (r.error === 'conflict') {
    return res.status(409).json({ ok: false, error: `an identical entry (id ${r.clashId}) already anchors (${docKind}, ${docRef}) — refusing to create a duplicate pair` });
  }
  res.json({ ok: true, moved: r.moved, entry: r.entry });
});

// ---- conversations: the email ask/response history grouped into threads ----------
// List + detail power the hub "Conversations" page; PATCH lets ws run-inbox set
// the one-time AI title on newly created conversations.

const convLine = (c) => `${c.id} | ${String(c.updated_at).slice(0, 10)} | ${c.status} | ${c.message_count} msgs | ${c.title}`;
const CONVERSATION_STATUSES = ['active', 'archived'];

// List conversations, newest activity first. Text lines by default (agent-cheap);
// ?format=json for the web app. ?status=active|archived filters by status;
// omitted or ?status=all returns ALL (backward-compatible default) — hub's
// default view requests ?status=active explicitly to hide the archive.
app.get('/conversation', (req, res) => {
  const q = req.query;
  const where = [];
  const args = [];
  const days = Number(q.days || 0);
  if (days > 0) {
    where.push('c.updated_at >= ?');
    args.push(new Date(Date.now() - days * 86400000).toISOString());
  }
  if (q.status && q.status !== 'all') {
    if (!CONVERSATION_STATUSES.includes(q.status)) {
      return res.status(400).json({ ok: false, error: `invalid status: ${q.status} (expected ${CONVERSATION_STATUSES.join('|')}|all)` });
    }
    where.push('c.status = ?');
    args.push(q.status);
  }
  const limit = Math.min(Number(q.limit || 100), 500);
  const rows = db.prepare(
    `SELECT c.id, c.title, c.status, c.created_at, c.updated_at,
            (SELECT COUNT(*) FROM message m WHERE m.conversation_id = c.id) AS message_count
     FROM conversation c ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
     ORDER BY c.updated_at DESC, c.id DESC LIMIT ?`
  ).all(...args, limit);
  if (q.format === 'json') return res.json({ ok: true, count: rows.length, conversations: rows });
  res.type('text/plain').send(rows.map(convLine).join('\n') + (rows.length ? '\n' : ''));
});

// One conversation with its messages in order, full bodies (JSON — bodies don't fit lines).
app.get('/conversation/:id', (req, res) => {
  const c = db.prepare('SELECT * FROM conversation WHERE id = ?').get(Number(req.params.id));
  if (!c) return res.status(404).json({ ok: false, error: 'not found' });
  const messages = db.prepare('SELECT * FROM message WHERE conversation_id = ? ORDER BY id').all(c.id);
  res.json({ ok: true, conversation: c, messages });
});

// Update a conversation's title and/or status. `title` is the once-per-conversation
// AI-title call (ws run-inbox); `status` (active|archived) is the soft-delete/archive
// toggle (ws conv-status, hub archive control). Both optional but at least one
// required; a title-only call is byte-identical to the pre-status behaviour.
const CONVERSATION_STATUSES_PATCH = ['active', 'archived'];
app.patch('/conversation/:id', (req, res) => {
  const b = req.body || {};
  const hasTitle = typeof b.title === 'string';
  const hasStatus = typeof b.status === 'string';
  if (!hasTitle && !hasStatus) return res.status(400).json({ ok: false, error: 'missing field: title or status' });
  const sets = [];
  const args = [];
  if (hasTitle) {
    const title = b.title.trim();
    if (!title) return res.status(400).json({ ok: false, error: 'missing field: title' });
    sets.push('title = ?');
    args.push(title.slice(0, 200));
  }
  if (hasStatus) {
    const status = b.status.trim();
    if (!CONVERSATION_STATUSES_PATCH.includes(status)) {
      return res.status(400).json({ ok: false, error: `invalid status: ${status} (expected ${CONVERSATION_STATUSES_PATCH.join('|')})` });
    }
    sets.push('status = ?');
    args.push(status);
  }
  const info = db.prepare(`UPDATE conversation SET ${sets.join(', ')} WHERE id = ?`).run(...args, Number(req.params.id));
  if (!info.changes) return res.status(404).json({ ok: false, error: 'not found' });
  const c = db.prepare('SELECT * FROM conversation WHERE id = ?').get(Number(req.params.id));
  res.json({ ok: true, conversation: c });
});

// List messages (compact index lines; bodies via /message/:id). ?q= searches
// subject+body; ?format=json returns structured rows with meta, bodies elided.
// ?before_id= returns only rows with id < N — descending pagination for pollers
// that must see EVERY row, however old (WS-M3: the page-comment poll). Non-numeric
// or absent values are ignored, so existing callers behave exactly as before.
app.get('/message', (req, res) => {
  const q = req.query;
  const where = [];
  const args = [];
  // ?state= filters by lifecycle state (page-comment rows). The sweep runs first on
  // every comment/state read, so the poll's `state=waiting` answer is already past
  // stale-read reverts and 24h expiry — nothing waiting is ever skipped, nothing
  // expired is ever returned. An unknown state is a 400 (typo, not an empty list).
  if (q.state) {
    if (!COMMENT_STATES.includes(q.state)) {
      return res.status(400).json({ ok: false, error: `invalid state: ${q.state} (expected ${COMMENT_STATES.join('|')})` });
    }
    where.push('comment_state = ?');
    args.push(q.state);
  }
  if (q.state || q.kind === 'page-comment') sweepCommentLifecycle();
  if (q.kind) { where.push('kind = ?'); args.push(q.kind); }
  if (q.q) { where.push('(subject LIKE ? OR body LIKE ?)'); args.push(`%${q.q}%`, `%${q.q}%`); }
  const days = Number(q.days || 0);
  if (days > 0) { where.push('date >= ?'); args.push(daysCutoff(days)); }
  const beforeId = Number(q.before_id || 0);
  if (beforeId > 0) { where.push('id < ?'); args.push(beforeId); }
  const limit = Math.min(Number(q.limit || 20), 200);
  const rows = db.prepare(
    `SELECT * FROM message ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY id DESC LIMIT ?`
  ).all(...args, limit).reverse();
  if (q.format === 'json') {
    return res.json({ ok: true, count: rows.length, entries: rows.map(({ body, ...m }) => ({ ...m, body_length: body.length })) });
  }
  res.type('text/plain').send(rows.map(msgLine).join('\n') + (rows.length ? '\n' : ''));
});

// Full body of one message.
app.get('/message/:id', (req, res) => {
  const m = db.prepare('SELECT * FROM message WHERE id = ?').get(Number(req.params.id));
  if (!m) return res.status(404).type('text/plain').send('not found\n');
  res.type('text/plain').send(`# ${msgLine(m)}\n\n${m.body}\n`);
});

// ---- inbox dedup ledger: seen email Message-IDs (was inbox/processed.log) --------
// In the DB so it rides the daily backup: a rebuilt VM remembers which mails were
// already handled and never re-runs orchestrator sessions for the last 7 days.
// The inbox runner (cli/util/inbox.js) reads/writes here first, classic file as offline fallback.

// Full ledger as plain text, one Message-ID per line (the set is tiny — one row
// per captured request ever).
app.get('/seen', (req, res) => {
  const rows = db.prepare('SELECT message_id FROM inbox_seen ORDER BY ts').all();
  res.type('text/plain').send(rows.map((r) => r.message_id).join('\n') + (rows.length ? '\n' : ''));
});

// Record one seen Message-ID. Idempotent: re-posting a known id is a no-op.
// When the id is a page-comment ref, the comment's lifecycle advances to 'answered'
// (the runner calls this only AFTER its handling attempt, WS-M1): optional
// `answer_id` stores the inbox-reply message id so the answer is retrievable
// (`GET /message/:answer_id`); NULL means the attempt concluded without a stored
// reply (already opslogged failed by the runner). never_processed is TERMINAL and is
// never resurrected — a slow runner finishing after expiry still records the ref for
// dedupe, but the state stands.
app.post('/seen', (req, res) => {
  const b = req.body || {};
  if (typeof b.message_id !== 'string' || !b.message_id.trim()) {
    return res.status(400).json({ ok: false, error: 'missing field: message_id' });
  }
  const key = b.message_id.trim();
  const now = new Date().toISOString();
  const info = db.prepare('INSERT OR IGNORE INTO inbox_seen (message_id, ts, file) VALUES (?, ?, ?)').run(
    key,
    now,
    b.file ? String(b.file).trim() : null
  );
  const comment = db.prepare("SELECT id, comment_state FROM message WHERE kind = 'page-comment' AND ref = ?").get(key);
  if (comment && comment.comment_state !== 'never_processed') {
    const answerId = Number(b.answer_id || 0) > 0 ? Number(b.answer_id) : null;
    db.prepare(
      "UPDATE message SET comment_state = 'answered', comment_state_ts = ?, answer_id = COALESCE(?, answer_id) WHERE id = ?"
    ).run(now, answerId, comment.id);
  }
  res.status(info.changes ? 201 : 200).json({ ok: true, duplicate: !info.changes });
});

// Atomic dispatch claim: ws run-inbox claims a request key (comment ref or mail
// Message-ID) BEFORE spawning the agent session, so a manual run racing the
// scheduled one cannot double-run the same request. Claim rows live in inbox_seen
// under 'claim:<key>' — they never collide with real refs/Message-IDs and ride
// the daily backup. A stale claim (crashed run, older than ttl_minutes) is taken
// over so crash-retry still works. Node's single thread + sync SQLite make the
// insert-or-takeover sequence atomic per request.
// Lifecycle alignment (WS-M3 rework): a granted claim on a page-comment ref advances
// that comment to 'read' — the state column mirrors THIS claim, never a second claim
// system. never_processed is terminal: the claim is denied outright (no dispatch),
// covering the race where a comment expires between the poll and the claim.
app.post('/claim', (req, res) => {
  const b = req.body || {};
  if (typeof b.key !== 'string' || !b.key.trim()) {
    return res.status(400).json({ ok: false, error: 'missing field: key' });
  }
  const rawKey = b.key.trim();
  const key = 'claim:' + rawKey;
  const ttlMin = b.ttl_minutes !== undefined ? Number(b.ttl_minutes) : 60;
  if (!Number.isFinite(ttlMin) || ttlMin < 0) {
    return res.status(400).json({ ok: false, error: 'invalid ttl_minutes' });
  }
  const comment = db.prepare("SELECT id, comment_state FROM message WHERE kind = 'page-comment' AND ref = ?").get(rawKey);
  if (comment && comment.comment_state === 'never_processed') {
    return res.json({ ok: true, granted: false, takeover: false, reason: 'never_processed' });
  }
  const now = new Date().toISOString();
  // Granted (fresh or takeover) + a comment in waiting/read -> read. answered stays
  // answered: a re-claim of a handled comment must not regress the record.
  const markRead = () => {
    if (!comment) return;
    db.prepare(
      "UPDATE message SET comment_state = 'read', comment_state_ts = ? WHERE id = ? AND comment_state IN ('waiting', 'read')"
    ).run(now, comment.id);
  };
  const info = db.prepare('INSERT OR IGNORE INTO inbox_seen (message_id, ts, file) VALUES (?, ?, ?)').run(
    key, now, b.file ? String(b.file).trim() : null
  );
  if (info.changes) {
    markRead();
    return res.status(201).json({ ok: true, granted: true, takeover: false });
  }
  const cutoff = new Date(Date.now() - ttlMin * 60000).toISOString();
  const upd = db.prepare('UPDATE inbox_seen SET ts = ? WHERE message_id = ? AND ts < ?').run(now, key, cutoff);
  if (upd.changes > 0) markRead();
  res.json({ ok: true, granted: upd.changes > 0, takeover: upd.changes > 0 });
});

// ---- plans: the DB is the source of truth (read/write via `ws plan`) ------------------
// Every plan is one row keyed by slug; edits snapshot the previous body into
// plan_revision, so nothing the md files' git history held is lost.

const planLine = (p) => `${p.slug} | ${p.kind} | ${p.status} | ${String(p.updated_at).slice(0, 10)} | ${p.title}`;
// `baseline` is the regression baseline carrier (backlog 59, one plan per repo,
// slug test-baseline-<repo>). It is a DISTINCT kind from `test-plan` on purpose:
// pr-watch sweeps active test-plan-kind plans closed on PR merge and would
// otherwise close a repo's baseline the first time any PR landed.
// `history` is NOT a kind (the CEO, 2026-08-02): archived documents keep their
// original kind and carry `status: archived` — a kind that exists only to hold
// archived items hides what a document actually is. The legacy rows were
// migrated on 2026-08-02 (evidence: `ws plan get history-kind-migration-2026-08`).
const PLAN_KINDS = ['plan', 'audit', 'design', 'test-plan', 'doc', 'baseline'];

// The exact INVERSE of the read rendering below (`GET /plan/:slug` sends
// `# <planLine>\n\n<body>\n` so a human reading `ws plan get` gets the banner),
// applied on every write.
//
// WHY IT LIVES HERE: this endpoint stores what it is handed, verbatim. So every
// read-modify-write baked the banner into the body and the next read rendered
// another on top — headers stacked, one per write, and five plans were corrupted
// that way on 2026-08-01. The trap is in the contract, not in one caller: the
// most common path is an agent running `ws plan get x > f`, editing f, then
// `ws plan set x --file f`, which no client-side change can catch. Stripping at
// the single write choke point fixes every writer at once — this repo's client,
// plans-import, hub, curl, and any client too old to know about the fix.
//
// PRECISION: only a line carrying THIS plan's own slug, one of PLAN_KINDS and an
// ISO date is removed, so a legitimate body-leading H1 with a pipe in it
// (`# Something | something else`) is never eaten. Each stripped banner also
// takes back the ONE trailing newline its read appended, which is what makes
// read → write → read byte-identical; a body that already carries stacked
// banners self-heals on its next write.
const reEscape = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * @param {unknown} body
 * @param {string} slug
 * @returns {unknown} the body as it was stored before rendering
 */
function stripRenderedHeader(body, slug) {
  if (typeof body !== 'string') return body;
  const banner = new RegExp(
    `^\\uFEFF?#[ \\t]+${reEscape(slug)}[ \\t]*\\|[ \\t]*(?:${PLAN_KINDS.map(reEscape).join('|')})[ \\t]*\\|` +
    '[ \\t]*[^|\\n]+\\|[ \\t]*\\d{4}-\\d{2}-\\d{2}[ \\t]*\\|[^\\n]*\\r?\\n(?:\\r?\\n)?'
  );
  let out = body;
  let stripped = 0;
  for (;;) {
    const next = out.replace(banner, '');
    if (next === out) break;
    out = next;
    stripped++;
  }
  for (let i = 0; i < stripped; i++) out = out.replace(/\r?\n$/, '');
  return out;
}

// Index of plans, compact lines by default (agent-cheap); ?status= / ?kind= equality
// filters; ?exclude=done,archived hides those statuses (status NOT IN (...)) so a
// default view is one query, not fetch-all-and-hide. All filters compose (AND).
// ?format=json elides bodies (same convention as GET /message).
app.get('/plan', (req, res) => {
  const where = [];
  const args = [];
  if (req.query.status) { where.push('status = ?'); args.push(req.query.status); }
  if (req.query.kind) { where.push('kind = ?'); args.push(req.query.kind); }
  if (req.query.exclude) {
    const excluded = String(req.query.exclude).split(',').map((s) => s.trim()).filter(Boolean);
    if (excluded.length) {
      where.push(`status NOT IN (${excluded.map(() => '?').join(', ')})`);
      args.push(...excluded);
    }
  }
  const rows = db.prepare(
    `SELECT * FROM plan ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY updated_at DESC, id DESC`
  ).all(...args);
  if (req.query.format === 'json') {
    return res.json({ ok: true, count: rows.length, plans: rows.map(({ body, ...p }) => ({ ...p, body_length: body.length })) });
  }
  res.type('text/plain').send(rows.map(planLine).join('\n') + (rows.length ? '\n' : ''));
});

// One plan, full body as text; ?format=json returns the full row (hub page).
app.get('/plan/:slug', (req, res) => {
  const p = db.prepare('SELECT * FROM plan WHERE slug = ?').get(req.params.slug);
  if (!p) {
    if (req.query.format === 'json') return res.status(404).json({ ok: false, error: 'not found' });
    return res.status(404).type('text/plain').send('not found\n');
  }
  if (req.query.format === 'json') return res.json({ ok: true, plan: p });
  res.type('text/plain').send(`# ${planLine(p)}\n\n${p.body}\n`);
});

// Revision history — the READ path for plan_revision (each update snapshots the
// body as it was BEFORE the edit; this endpoint is what makes "replaces the git
// history the md files had" true from every environment, not just via direct
// SQLite access on the VM). Compact index lines by default, newest first;
// ?format=json returns the full rows INCLUDING bodies (that's the point of a
// history read), bounded by ?limit= (default 50, cap 200).
app.get('/plan/:slug/revisions', (req, res) => {
  const p = db.prepare('SELECT id FROM plan WHERE slug = ?').get(req.params.slug);
  if (!p) {
    if (req.query.format === 'json') return res.status(404).json({ ok: false, error: 'not found' });
    return res.status(404).type('text/plain').send('not found\n');
  }
  const limit = Math.min(Number(req.query.limit || 50), 200);
  const rows = db.prepare('SELECT * FROM plan_revision WHERE plan_id = ? ORDER BY id DESC LIMIT ?').all(p.id, limit);
  if (req.query.format === 'json') return res.json({ ok: true, count: rows.length, revisions: rows });
  const revLine = (r) => `${r.id} | ${String(r.ts).slice(0, 10)} | ${r.updated_by || '-'} | ${r.body.length} chars`;
  res.type('text/plain').send(rows.map(revLine).join('\n') + (rows.length ? '\n' : ''));
});

// Upsert — the ONE write call. Create requires title + body; update accepts any
// subset (only provided fields change) and snapshots the previous body into
// plan_revision first. Re-reads the row before returning: 201/200 + row is the
// proof of save, same as POST /log.
app.put('/plan/:slug', (req, res) => {
  const slug = req.params.slug.trim();
  if (!slug) return res.status(400).json({ ok: false, error: 'missing field: slug' });
  const b = req.body || {};
  const field = (f) => (typeof b[f] === 'string' && b[f].trim() ? b[f] : undefined);
  const title = field('title');
  // Never store the banner the read path renders (see stripRenderedHeader).
  const body = stripRenderedHeader(field('body'), slug);
  const kind = field('kind');
  const status = field('status');
  const repo = field('repo');
  const agent = field('agent');
  if (kind !== undefined && !PLAN_KINDS.includes(kind.trim())) {
    return res.status(400).json({ ok: false, error: `invalid kind: ${kind.trim()} (expected ${PLAN_KINDS.join('|')})` });
  }
  const now = new Date().toISOString();
  const existing = db.prepare('SELECT * FROM plan WHERE slug = ?').get(slug);
  if (!existing) {
    for (const f of ['title', 'body']) {
      if (!field(f)) return res.status(400).json({ ok: false, error: `missing field: ${f}` });
    }
    db.prepare(
      'INSERT INTO plan (slug, title, kind, status, repo, body, created_at, updated_at, updated_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(slug, title.trim(), kind ? kind.trim() : 'plan', status ? status.trim() : 'active', repo ? repo.trim() : null, body, now, now, agent ? agent.trim() : null);
  } else {
    if (title === undefined && body === undefined && kind === undefined && status === undefined && repo === undefined) {
      return res.status(400).json({ ok: false, error: 'no fields to update' });
    }
    db.prepare('INSERT INTO plan_revision (plan_id, ts, body, updated_by) VALUES (?, ?, ?, ?)')
      .run(existing.id, now, existing.body, existing.updated_by);
    db.prepare(
      'UPDATE plan SET title = ?, kind = ?, status = ?, repo = ?, body = ?, updated_at = ?, updated_by = ? WHERE id = ?'
    ).run(
      title !== undefined ? title.trim() : existing.title,
      kind !== undefined ? kind.trim() : existing.kind,
      status !== undefined ? status.trim() : existing.status,
      repo !== undefined ? repo.trim() : existing.repo,
      body !== undefined ? body : existing.body,
      now,
      agent ? agent.trim() : existing.updated_by,
      existing.id
    );
  }
  const p = db.prepare('SELECT * FROM plan WHERE slug = ?').get(slug);
  if (!p) return res.status(500).json({ ok: false, error: 'upsert verification failed: row not found after write' });
  res.status(existing ? 200 : 201).json({ ok: true, plan: p, line: planLine(p) });
});

// ---- station registry (W3/D1b): observed station state, one row per station -------
// Every station's 15-min `ws pull` tick PUTs its own env-doctor payload here.
// DELIBERATELY NOT the plan carrier: planSet snapshots a revision on every write,
// and 3 stations x ~96 ticks/day would be revision bloat by construction. This is
// observed state with no history value - last-write-wins, one row per station
// (rationale also in server/README.md). configs/environments.json stays the
// DEFINITION (identity, ports, tunnel); this table holds only what stations report.
// Staleness is judged HERE, at read time, control-plane-side: a station whose
// tunnel/API access is down is exactly the one that cannot file a report, so
// "no report in N ticks" and "never reported" must be findings of the reader.

const ENVS_CONFIG = process.env.WS_ENVS_CONFIG || path.join(__dirname, '..', 'configs', 'environments.json');
const configuredEnvs = () => {
  try { return Object.keys(JSON.parse(fs.readFileSync(ENVS_CONFIG, 'utf8')).environments || {}); }
  catch { return []; }
};
const STALE_MINUTES_DEFAULT = 45; // 3 missed 15-min ticks

const stationAgeMin = (r, nowMs) => Math.max(0, Math.round((nowMs - Date.parse(r.ts)) / 60000));
const stationFailIds = (r) => {
  try {
    const results = JSON.parse(r.report).results || [];
    return results.filter((c) => c.level === 'FAIL').map((c) => c.id).join(',');
  } catch { return ''; }
};
const stationLine = (r, nowMs, staleMin, known) => {
  const age = stationAgeMin(r, nowMs);
  const verdict = r.ok ? 'ok' : `FAILING${stationFailIds(r) ? ':' + stationFailIds(r) : ''}`;
  return `${r.env} | ${verdict} | last ${r.ts} (${age}m ago${age > staleMin ? ', STALE' : ''})`
    + ` | ip ${r.public_ip || '-'} | ${r.platform || '-'}${known ? '' : ' | not in configs/environments.json'}`;
};

// Upsert - last-write-wins, no revision. Body: { report: <object> } where report is
// the env-doctor `payload()` (+ publicIp) the station observed; the server stamps
// ts/date itself and extracts the indexed columns from the report. Re-reads the row
// before returning (201 created / 200 updated + row = proof of save, as POST /log).
app.put('/station/:env', (req, res) => {
  const env = req.params.env.trim();
  if (!env) return res.status(400).json({ ok: false, error: 'missing field: env' });
  const report = (req.body || {}).report;
  if (!report || typeof report !== 'object' || Array.isArray(report)) {
    return res.status(400).json({ ok: false, error: 'missing field: report (object)' });
  }
  const existing = db.prepare('SELECT env FROM station WHERE env = ?').get(env);
  db.prepare(
    `INSERT INTO station (env, ts, date, platform, ok, public_ip, report) VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(env) DO UPDATE SET ts = excluded.ts, date = excluded.date, platform = excluded.platform,
       ok = excluded.ok, public_ip = excluded.public_ip, report = excluded.report`
  ).run(
    env,
    new Date().toISOString(),
    localDate(),
    report.platform ? String(report.platform) : null,
    report.ok ? 1 : 0,
    report.publicIp ? String(report.publicIp) : null,
    JSON.stringify(report)
  );
  const r = db.prepare('SELECT * FROM station WHERE env = ?').get(env);
  if (!r) return res.status(500).json({ ok: false, error: 'upsert verification failed: row not found after write' });
  res.status(existing ? 200 : 201).json({ ok: true, line: stationLine(r, Date.now(), STALE_MINUTES_DEFAULT, true) });
});

// Roster view: every reported row PLUS every configured-but-silent station -
// absence ("NEVER REPORTED") is a first-class finding, not an empty list.
// ?stale_minutes= overrides the 45-min default; format=json for the hub page.
app.get('/station', (req, res) => {
  const staleMin = Number(req.query.stale_minutes) > 0 ? Number(req.query.stale_minutes) : STALE_MINUTES_DEFAULT;
  const nowMs = Date.now();
  const rows = db.prepare('SELECT * FROM station ORDER BY env').all();
  const known = configuredEnvs();
  const reported = new Set(rows.map((r) => r.env));
  const silent = known.filter((e) => !reported.has(e));
  if (req.query.format === 'json') {
    return res.json({
      ok: true,
      count: rows.length,
      stale_minutes: staleMin,
      stations: rows.map((r) => {
        let report = null;
        try { report = JSON.parse(r.report); } catch { /* stored by us, but never trust a parse */ }
        const { report: _raw, ...rest } = r;
        return { ...rest, ok: Boolean(r.ok), age_minutes: stationAgeMin(r, nowMs), stale: stationAgeMin(r, nowMs) > staleMin, configured: known.includes(r.env), report };
      }),
      never_reported: silent,
    });
  }
  const out = rows.map((r) => stationLine(r, nowMs, staleMin, known.includes(r.env)));
  for (const e of silent) out.push(`${e} | NEVER REPORTED - no row (station cannot reach the API, or predates the registry)`);
  res.type('text/plain').send(out.join('\n') + (out.length ? '\n' : ''));
});

// One station's full stored report.
app.get('/station/:env', (req, res) => {
  const r = db.prepare('SELECT * FROM station WHERE env = ?').get(req.params.env.trim());
  if (!r) {
    if (req.query.format === 'json') return res.status(404).json({ ok: false, error: 'not found' });
    return res.status(404).type('text/plain').send('not found\n');
  }
  if (req.query.format === 'json') {
    let report = null;
    try { report = JSON.parse(r.report); } catch { /* keep null */ }
    return res.json({ ok: true, station: { ...r, ok: Boolean(r.ok), report } });
  }
  let pretty = r.report;
  try { pretty = JSON.stringify(JSON.parse(r.report), null, 2); } catch { /* raw */ }
  res.type('text/plain').send(`# ${stationLine(r, Date.now(), STALE_MINUTES_DEFAULT, configuredEnvs().includes(r.env))}\n\n${pretty}\n`);
});

// ---- feature registry (design plan features-ui-restructure-design, 2026-08-27) -----
// The DECLARED catalog lives in configs/features.json (repo = definition); this
// endpoint is the JOIN POINT the design names: registry x station-table reports x
// job-run `runner` log rows, aggregated server-side so the hub, ws CLI and
// env-doctor all read one feature-major answer. Liveness is DERIVED only —
// evidence that cannot be found reads `unmeasured`, never `ready` (never fake
// liveness). The registry is read FRESH on every request (tiny file, same policy
// as configuredEnvs() above — no cache to go stale); loader/validator + the pure
// state derivation live in cli/util/features.js (ESM, lazily imported like ceo.js).
// Response contract: server/README.md "Feature registry" (the one home).
const FEATURES_CONFIG = process.env.WS_FEATURES_CONFIG || path.join(__dirname, '..', 'configs', 'features.json');
/** @type {any} */
let featuresMod = null;
const loadFeaturesMod = async () => {
  if (!featuresMod) {
    const url = require('node:url').pathToFileURL(path.join(__dirname, '..', 'cli', 'util', 'features.js')).href;
    featuresMod = await import(url);
  }
  return featuresMod;
};

app.get('/feature', async (req, res) => {
  let mod;
  try {
    mod = await loadFeaturesMod();
  } catch (e) {
    return res.status(500).json({ ok: false, error: `features module unavailable: ${e instanceof Error ? e.message : e}` });
  }
  const { registry, errors } = mod.loadFeatures({ featuresPath: FEATURES_CONFIG, envsPath: ENVS_CONFIG, jobsPath: JOBS_CONFIG });
  if (!registry) return res.status(500).json({ ok: false, error: 'invalid feature registry', errors });
  let envsCfg = {};
  let jobsCfg = { jobs: [] };
  try { envsCfg = JSON.parse(fs.readFileSync(ENVS_CONFIG, 'utf8')); } catch { /* loadFeatures already validated */ }
  try { jobsCfg = JSON.parse(fs.readFileSync(JOBS_CONFIG, 'utf8')); } catch { /* ditto */ }
  const staleMin = Number(req.query.stale_minutes) > 0 ? Number(req.query.stale_minutes) : STALE_MINUTES_DEFAULT;
  const nowMs = Date.now();
  // Observed side of the join: every stored station report, staleness judged here
  // at read time exactly like GET /station (a station that cannot reach the API is
  // exactly the one that cannot report).
  const stations = {};
  for (const r of db.prepare('SELECT * FROM station ORDER BY env').all()) {
    let results = [];
    try { results = JSON.parse(r.report).results || []; } catch { /* stored by us, but never trust a parse */ }
    const age = stationAgeMin(r, nowMs);
    stations[r.env] = { ts: r.ts, age, stale: age > staleMin, results };
  }
  const envNames = Object.keys(envsCfg.environments || {});
  // Control-plane facts (cp-*) are probed by a tunneled station ABOUT the VM host,
  // so a check id absent from the target station's own report is looked up in the
  // newest other report carrying it; the cell then says `via` (and goes stale with
  // its source).
  const findCheck = (env, id) => {
    const own = stations[env];
    const hit = own && own.results.find((c) => c.id === id);
    if (hit) return { check: hit, via: null, stale: own.stale };
    const others = Object.entries(stations)
      .filter(([e]) => e !== env)
      .sort((a, b) => Date.parse(b[1].ts) - Date.parse(a[1].ts));
    for (const [e, s] of others) {
      const h = s.results.find((c) => c.id === id);
      if (h) return { check: h, via: e, stale: s.stale };
    }
    return null;
  };
  // Job-run side of the join: the newest `runner` row in the job's own area (plus
  // any declared runner-log areas — db-backup logs area `backup`). Jobs whose
  // runner writes no per-run rows honestly stay unmeasured.
  const lastRun = (areas) => {
    if (!areas.length) return null;
    const q = `SELECT date, status, message, ts, area FROM log WHERE agent = 'runner' AND area IN (${areas.map(() => '?').join(',')}) ORDER BY id DESC LIMIT 1`;
    return db.prepare(q).get(...areas) || null;
  };
  const owner = envsCfg.scheduleOwner || null;
  const features = registry.features.map((f) => {
    const checkIds = f.evidence.filter((e) => e.startsWith('check:')).map((e) => e.slice('check:'.length));
    const jobNames = f.evidence.filter((e) => e.startsWith('job:')).map((e) => e.slice('job:'.length));
    const runnerAreas = f.evidence.filter((e) => e.startsWith('runner-log:')).map((e) => e.slice('runner-log:'.length));
    let job = null;
    if (jobNames.length) {
      const name = jobNames[0];
      const spec = (jobsCfg.jobs || []).find((j) => j && j.name === name) || {};
      const run = lastRun([name, ...runnerAreas]);
      job = {
        name,
        cron: spec.cron || null,
        disabled: Boolean(spec.disabled),
        last_run: run ? { date: run.date, status: run.status, message: run.message, ts: run.ts, area: run.area } : null,
      };
    }
    const cells = {};
    for (const env of envNames) {
      if (!mod.scopeIncludes(f.scope, env, envsCfg)) { cells[env] = { state: 'n/a' }; continue; }
      const st = stations[env];
      if (!st) { cells[env] = { state: 'never-reported' }; continue; }
      if (st.stale) { cells[env] = { state: 'stale', age_minutes: st.age }; continue; }
      const states = [];
      const checks = [];
      for (const id of checkIds) {
        const found = findCheck(env, id);
        if (!found) { states.push('unmeasured'); checks.push({ id, state: 'unmeasured' }); continue; }
        const state = found.stale ? 'stale' : mod.checkState(found.check);
        states.push(state);
        checks.push({ id, state, level: found.check.level, detail: found.check.detail, ...(found.via ? { via: found.via } : {}) });
      }
      if (job && env === owner) states.push(mod.jobCellState({ disabled: job.disabled, lastRunStatus: job.last_run ? job.last_run.status : null }));
      cells[env] = { state: mod.combineStates(states), age_minutes: st.age, ...(checks.length ? { checks } : {}) };
    }
    return {
      id: f.id, title: f.title, description: f.description, kind: f.kind, scope: f.scope,
      ...(f.note ? { note: f.note } : {}),
      measured: f.evidence.length > 0,
      ...(job ? { job } : {}),
      cells,
    };
  });
  if (req.query.format === 'json') {
    return res.json({ ok: true, count: features.length, stale_minutes: staleMin, schedule_owner: owner, stations: envNames, features });
  }
  const out = features.map((f) => {
    const cellsTxt = envNames.map((e) => `${e}=${f.cells[e].state}`).join(' ');
    const jobTxt = f.job
      ? ` | job ${f.job.name}: ${f.job.disabled ? 'disabled' : (f.job.last_run ? `last ${f.job.last_run.status} ${f.job.last_run.date}` : 'no runs recorded')}`
      : '';
    return `${f.id} | ${f.kind} | ${f.scope} | ${cellsTxt}${f.measured ? '' : ' | declared, unmeasured'}${jobTxt}`;
  });
  res.type('text/plain').send(out.join('\n') + (out.length ? '\n' : ''));
});

// ---- introspection: table definitions + row counts (for Hector to iterate on) ----
app.get('/schema', (req, res) => {
  const out = [];
  for (const t of db.prepare("SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all()) {
    const { n } = db.prepare(`SELECT COUNT(*) AS n FROM "${t.name}"`).get();
    out.push(`-- ${t.name}: ${n} rows`);
    out.push(t.sql + ';');
    for (const i of db.prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND tbl_name = ? AND sql IS NOT NULL").all(t.name)) {
      out.push(i.sql + ';');
    }
    out.push('');
  }
  res.type('text/plain').send(out.join('\n'));
});

const srv = app.listen(PORT, HOST, () => {
  // Print the *bound* port: with LOG_API_PORT=0 (tests) the OS picks a free one.
  console.log(`[log-api] listening on http://${HOST}:${srv.address().port}, db=${DB_PATH}`);
});
