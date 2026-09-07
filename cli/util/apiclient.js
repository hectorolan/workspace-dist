// HTTP client for the central log API — the ONE implementation behind `ws log`,
// `ws query`, and friends, on every host. Zero npm dependencies: global fetch + node:fs only, so `ws log`
// works on a fresh clone before any npm install.
import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync, renameSync } from 'node:fs';
import path from 'node:path';
import { today, workspaceDir, dataDir } from './clock.js';

export { workspaceDir, dataDir };

const API = process.env.LOG_API_URL || 'http://127.0.0.1:8790';

/**
 * A dead connection, as opposed to a dead server. `fetch` reports both as
 * `fetch failed`; only the cause code tells them apart, and only this class is worth
 * repeating — a refused connection or a DNS failure would just fail again, slower.
 * @param {unknown} e
 * @returns {boolean}
 */
function socketDied(e) {
  const cause = /** @type {{code?: string}|undefined} */ (
    e instanceof Error ? /** @type {{cause?: unknown}} */ (e).cause || undefined : undefined
  );
  return !!cause && ['UND_ERR_SOCKET', 'ECONNRESET', 'EPIPE'].includes(String(cause.code));
}

/**
 * Methods safe to send twice. HTTP idempotence is the whole test and it is not a
 * judgement call: `PUT /plan` is an upsert keyed by slug, `GET` reads. `POST` appends
 * (`/log`, `/thread`) — a repeat could store the same row twice if the first attempt
 * reached the DB before the connection died, and for `ws log` that is strictly worse
 * than the fallback file it already falls back to (which `ws pull` replays).
 */
const REPEATABLE = new Set(['GET', 'HEAD', 'PUT', 'DELETE']);

/**
 * @param {string} method
 * @param {string} pathname
 * @param {{params?: Record<string, string|number|undefined>, body?: object}} [opts]
 */
async function call(method, pathname, opts = {}) {
  const url = new URL(API.replace(/\/$/, '') + pathname);
  for (const [k, v] of Object.entries(opts.params || {})) {
    if (v !== undefined && v !== '') url.searchParams.set(k, String(v));
  }
  /** @type {Record<string, string>} */
  const headers = {};
  if (process.env.LOG_API_KEY) headers['X-Api-Key'] = process.env.LOG_API_KEY;
  if (opts.body) headers['Content-Type'] = 'application/json';
  // A fresh timeout signal per attempt — a signal is consumed once.
  const send = () => fetch(url, {
    method,
    headers,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
    signal: AbortSignal.timeout(15000),
  });
  try {
    return await send();
  } catch (e) {
    // ONE retry, and only for a connection that died under a repeatable method.
    // Why this exists (windows-pc, 2026-08-18): `ws sync` opens a pooled keep-alive
    // socket reading the baseline, then blocks its event loop ~26 s in the ci-guard
    // gates; through the SSH tunnel the far end is gone by the time the post-push
    // `planSet` is written, so the request is sent onto a dead socket. That write is
    // a best-effort path, so the station silently stopped advancing its baseline and
    // closing its test-plans. Retrying it costs one round trip on a path that only
    // runs after a suite has already taken half a minute.
    if (!socketDied(e) || !REPEATABLE.has(method)) throw e;
    return await send();
  }
}

/** The workspace `ws log` offline-fallback file, in the per-machine data dir (unversioned). */
export function fallbackLog() {
  return path.join(dataDir(), 'fallback', 'log.md');
}

/**
 * One audit line. Falls back to a classic md append when the API is unreachable —
 * nothing is ever lost. Workspace fallback: <data>/fallback/log.md (the DB is the
 * source of truth; the data dir holds runtime/offline state, outside git). Project
 * repos keep their own ops/log.md convention. `ws pull` replays the workspace
 * fallback into the API on the next healthy tick (replayFallback).
 * @param {{area: string, status: string, message: string, repo?: string, agent?: string}} entry
 * @returns {Promise<{ok: true, line: string} | {ok: false, fallback: string}>}
 */
export async function log({ area, status, message, repo = 'workspace', agent = '' }) {
  try {
    const res = await call('POST', '/log', { body: { repo, area, status, message, agent } });
    const json = /** @type {{ok?: boolean, line?: string}} */ (await res.json());
    if (json.ok) return { ok: true, line: json.line || '' };
    throw new Error('API returned not-ok');
  } catch {
    let target = fallbackLog();
    if (repo !== 'workspace') {
      const sibling = path.join(workspaceDir(), '..', repo);
      if (existsSync(sibling)) target = path.join(sibling, 'ops', 'log.md');
    }
    mkdirSync(path.dirname(target), { recursive: true });
    const line = `${today()} | ${area} | ${status} | ${message}`;
    appendFileSync(target, line + '\n', 'utf8');
    return { ok: false, fallback: target };
  }
}

/**
 * Replay the workspace offline-fallback file (<data>/fallback/log.md) into the API.
 * Called from `ws pull` on every healthy tick, both environments: when the API is
 * back, drain the queue so no line stays stranded on one machine. Line-by-line and
 * idempotent-safe — a line that posts is dropped from the file, a line that fails
 * stays queued, so a partial failure never double-posts on the next tick. Archives
 * the file when fully drained. Quiet no-op when there is nothing to replay or the
 * API is still unreachable.
 * @returns {Promise<{status: 'none'|'offline'|'replayed'|'failed', replayed: number, remaining: number}>}
 */
export async function replayFallback() {
  const target = fallbackLog();
  if (!existsSync(target)) return { status: 'none', replayed: 0, remaining: 0 };
  const raw = readFileSync(target, 'utf8');
  const lines = raw.split(/\r?\n/);
  if (!lines.some((l) => l.trim() && !l.trim().startsWith('#'))) {
    return { status: 'none', replayed: 0, remaining: 0 };
  }
  // Probe reachability first so an offline tick stays a quiet no-op (file untouched).
  try {
    const res = await call('GET', '/health');
    if (!res.ok) throw new Error('health not ok');
  } catch {
    return { status: 'offline', replayed: 0, remaining: 0 };
  }
  const LINE = /^(\d{4}-\d{2}-\d{2})\s*\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|\s*(.+)$/;
  /** @type {string[]} */
  const remaining = [];
  let replayed = 0;
  for (const raw2 of lines) {
    const t = raw2.trim();
    if (!t || t.startsWith('#') || t.startsWith('<!--')) continue; // headers/comments dropped
    const m = t.match(LINE);
    if (!m) { remaining.push(raw2); continue; } // keep unparseable lines, never lose them
    const [, date, area, status, message] = m;
    try {
      const res = await call('POST', '/log', {
        body: { repo: 'workspace', date, area, status, message, source: 'fallback-replay' },
      });
      const json = /** @type {{ok?: boolean}} */ (await res.json());
      if (!json.ok) throw new Error('not ok');
      replayed++;
    } catch {
      remaining.push(raw2);
    }
  }
  if (remaining.length) {
    writeFileSync(target, remaining.join('\n') + '\n', 'utf8');
    return { status: 'failed', replayed, remaining: remaining.length };
  }
  // Fully drained — archive the file so it can't be replayed twice.
  const archive = path.join(dataDir(), 'fallback', 'replayed');
  mkdirSync(archive, { recursive: true });
  try { renameSync(target, path.join(archive, `${Date.now()}.md`)); } catch { /* best effort */ }
  return { status: 'replayed', replayed, remaining: 0 };
}

/**
 * Store a full document in the message table. Throws on failure — the file on
 * disk remains the source of truth (caller decides how loudly to warn).
 * `id` is the stored row's message id (present on duplicates too) — the runner passes
 * an inbox-reply's id to markSeen so an answered page comment records its answer.
 * @param {{kind: string, subject: string, ref: string, bodyPath: string, meta?: string}} doc
 * @returns {Promise<{id?: number, line: string, conversation?: {id: number, created?: boolean}}>}
 */
export async function storeMessage({ kind, subject, ref, bodyPath, meta = '' }) {
  const body = readFileSync(bodyPath, 'utf8');
  const res = await call('POST', '/message', { body: { kind, subject, ref, body, meta } });
  const json = /** @type {{ok?: boolean, id?: number, line?: string, conversation?: {id: number, created?: boolean}}} */ (await res.json());
  if (!json.ok) throw new Error('API returned not-ok');
  return { id: json.id, line: json.line || '', conversation: json.conversation };
}

/**
 * Message index as structured rows (`GET /message?format=json` — bodies elided,
 * fetch one via messageBody). Throws when the API is unreachable or refuses.
 * `beforeId` maps to `?before_id=` (rows with id < N — descending pagination,
 * WS-M3: how the page-comment poll walks the whole table, never a time window).
 * `state` filters page-comment rows by lifecycle state (waiting|read|answered|
 * never_processed — the poll fetches ONLY waiting; state machine in server/README.md).
 * @param {{kind?: string, days?: number, limit?: number, q?: string, beforeId?: number, state?: string}} [params]
 * @returns {Promise<Array<{id: number, ts: string, date: string, kind: string, subject: string|null, ref: string|null, meta: string|null, body_length: number, comment_state?: string|null, answer_id?: number|null, conversation_id?: number|null}>>}
 */
export async function listMessages({ kind, days, limit, q, beforeId, state } = {}) {
  const res = await call('GET', '/message', { params: { kind, days, limit, q, before_id: beforeId, state, format: 'json' } });
  const json = /** @type {{ok?: boolean, entries?: any[]}} */ (await res.json());
  if (!json.ok) throw new Error('API returned not-ok');
  return json.entries || [];
}

/**
 * Full body of one message (`GET /message/:id`, the `# index line` header stripped).
 * The thrown error carries `.status` so callers can tell a miss (404) from an
 * unreachable API (fetch rejects, no status) without matching on the message.
 * @param {string|number} id
 * @returns {Promise<string>}
 */
export async function messageBody(id) {
  const res = await call('GET', `/message/${id}`);
  if (!res.ok) {
    throw Object.assign(new Error(`message not found: ${id}`), { status: res.status });
  }
  const text = await res.text();
  return text.replace(/^# [^\n]*\n\n?/, '').replace(/\n$/, '');
}

/** The seen-mail dedup ledger (inbox_seen). @returns {Promise<Set<string>>} */
export async function seenIds() {
  const res = await call('GET', '/seen');
  const text = await res.text();
  return new Set(text.split('\n').map((s) => s.trim()).filter(Boolean));
}

/**
 * Record a handled request key. For a page-comment ref this also advances the
 * lifecycle to `answered`; `answerId` (the stored inbox-reply message id, from
 * storeMessage) makes the answer retrievable via `ws query --message-id <id>`.
 * @param {string} messageId @param {string} file @param {number} [answerId]
 */
export async function markSeen(messageId, file, answerId) {
  await call('POST', '/seen', { body: { message_id: messageId, file, answer_id: answerId } });
}

/**
 * Atomic dispatch claim (`POST /claim`, WS-M2): grants exactly one runner the
 * right to handle a request key (mail Message-ID or page-comment ref) before an
 * agent session spawns. A stale claim (older than the server-side TTL, default
 * 60 min — crashed run) is taken over so crash-retry survives. Throws when the
 * API is unreachable or refuses; the caller decides whether to proceed.
 * @param {string} key
 * @param {{file?: string, ttlMinutes?: number}} [opts]
 * @returns {Promise<{granted: boolean, takeover: boolean}>}
 */
export async function claim(key, { file, ttlMinutes } = {}) {
  const res = await call('POST', '/claim', { body: { key, file, ttl_minutes: ttlMinutes } });
  const json = /** @type {{ok?: boolean, granted?: boolean, takeover?: boolean, error?: string}} */ (await res.json());
  if (!json.ok) throw new Error(json.error || 'API returned not-ok');
  return { granted: Boolean(json.granted), takeover: Boolean(json.takeover) };
}

/**
 * Capture an outgoing email (kind email-out). Ref derives from date+subject so
 * same-day retries dedupe — identical derivation to the legacy clients.
 * @param {{subject: string, bodyPath: string, meta?: string}} mail
 */
export async function emailOut({ subject, bodyPath, meta = '' }) {
  let slug = subject.replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  if (slug.length > 60) slug = slug.slice(0, 60);
  const ref = `${today()}-${slug}`;
  return storeMessage({ kind: 'email-out', subject, ref, bodyPath, meta });
}

/**
 * @param {string|number} id
 * @param {string} title
 * @returns {Promise<string>} the stored title
 */
export async function convTitle(id, title) {
  const res = await call('PATCH', `/conversation/${id}`, { body: { title } });
  const json = /** @type {{ok?: boolean, conversation?: {title?: string}}} */ (await res.json());
  if (!json.ok) throw new Error('API returned not-ok');
  return (json.conversation && json.conversation.title) || title;
}

/**
 * One conversation with its ordered full messages (`GET /conversation/:id`).
 * Throws on unknown id — callers treat that as "nothing to attach", not a crash.
 * @param {string|number} id
 * @returns {Promise<{conversation: {id: number, title: string|null, status: string}, messages: Array<{id: number, kind: string, subject: string|null}>}>}
 */
export async function convGet(id) {
  const res = await call('GET', `/conversation/${id}`);
  const json = /** @type {{ok?: boolean, conversation?: any, messages?: any[]}} */ (await res.json());
  if (!json.ok || !json.conversation) throw new Error(`conversation ${id} not found`);
  return { conversation: json.conversation, messages: json.messages || [] };
}

/**
 * Conversation index as structured rows (`GET /conversation?format=json` —
 * `{id, title, status, created_at, updated_at, message_count}`). `status`
 * filters server-side (`active`|`archived`; omitted = all). The inbox runner
 * reads the archived set through this to enforce the CEO's archive-means-drop
 * ruling (2026-08-17) at comment selection time. Throws when the API is
 * unreachable or refuses — the caller decides how loudly to degrade.
 * @param {{status?: string, days?: number, limit?: number}} [params]
 * @returns {Promise<Array<{id: number, title: string, status: string, created_at: string, updated_at: string, message_count: number}>>}
 */
export async function convList({ status, days, limit } = {}) {
  const res = await call('GET', '/conversation', { params: { status, days, limit, format: 'json' } });
  const json = /** @type {{ok?: boolean, conversations?: any[]}} */ (await res.json());
  if (!json.ok) throw new Error('API returned not-ok');
  return json.conversations || [];
}

/**
 * Archive/unarchive a conversation (soft-delete; never hard-deleted).
 * @param {string|number} id
 * @param {'active'|'archived'} status
 * @returns {Promise<string>} the stored status
 */
export async function convStatus(id, status) {
  const res = await call('PATCH', `/conversation/${id}`, { body: { status } });
  const json = /** @type {{ok?: boolean, conversation?: {status?: string}}} */ (await res.json());
  if (!json.ok) throw new Error('API returned not-ok');
  return (json.conversation && json.conversation.status) || status;
}

/**
 * Plan index (compact `slug | kind | status | date | title` lines by default;
 * `format: 'json'` returns the JSON index text — rows incl. `repo`, bodies elided;
 * `exclude` hides comma-separated statuses server-side).
 * @param {{status?: string, kind?: string, exclude?: string, format?: string}} [params]
 * @returns {Promise<string>}
 */
export async function planList({ status, kind, exclude, format } = {}) {
  const res = await call('GET', '/plan', { params: { status, kind, exclude, format } });
  return res.text();
}

/**
 * One plan, full body as text. Throws 'not found' on unknown slug.
 * @param {string} slug
 * @returns {Promise<string>}
 */
export async function planGet(slug) {
  const res = await call('GET', `/plan/${encodeURIComponent(slug)}`);
  if (res.status === 404) throw new Error(`plan not found: ${slug}`);
  return res.text();
}

/**
 * Revision history of one plan (`GET /plan/:slug/revisions` — the WS-M4 read
 * path for plan_revision): compact `id | date | updated_by | n chars` lines,
 * newest first. Throws 'not found' on unknown slug.
 * @param {string} slug
 * @param {{limit?: number}} [opts]
 * @returns {Promise<string>}
 */
export async function planRevisions(slug, { limit } = {}) {
  const res = await call('GET', `/plan/${encodeURIComponent(slug)}/revisions`, { params: { limit } });
  if (res.status === 404) throw new Error(`plan not found: ${slug}`);
  return res.text();
}

/**
 * Upsert one plan — the ONE write call. NO offline fallback (plans are not
 * append-only log lines): throws when the API is unreachable or refuses, and the
 * caller fails loudly. `kind` is plan|audit|design|test-plan|doc|baseline (server-validated).
 * @param {string} slug
 * @param {{title?: string, body?: string, kind?: string, status?: string, repo?: string, agent?: string}} fields
 * @returns {Promise<{line: string, created: boolean}>}
 */
export async function planSet(slug, { title, body, kind, status, repo, agent } = {}) {
  const res = await call('PUT', `/plan/${encodeURIComponent(slug)}`, {
    body: { title, body, kind, status, repo, agent },
  });
  const json = /** @type {{ok?: boolean, error?: string, line?: string}} */ (await res.json());
  if (!json.ok) throw new Error(json.error || 'API returned not-ok');
  return { line: json.line || '', created: res.status === 201 };
}

/**
 * Append one document-thread entry (`POST /thread` — design: `ws plan get
 * nexus-document-threads-design`, W1). The entry body is an EXISTING message row
 * (store it first via storeMessage — never duplicated here). Anchor: explicit
 * `docKind` + `docRef`, or `anchorRef` = a page-comment ref whose existing thread
 * entry supplies the anchor (the inbox runner's reply path). Idempotent on the
 * exact entry; throws when the API is unreachable or refuses (404 = no anchor —
 * e.g. a pre-threads comment; the error carries `.status` like messageBody).
 * @param {{docKind?: string, docRef?: string, anchorRef?: string, messageId: number, role: 'ceo'|'agent'|'trigger'}} entry
 * @returns {Promise<{entry: {id: number, doc_kind: string, doc_ref: string, message_id: number, role: string, created: string}, duplicate: boolean}>}
 */
export async function threadPost({ docKind, docRef, anchorRef, messageId, role }) {
  const res = await call('POST', '/thread', {
    body: { doc_kind: docKind, doc_ref: docRef, anchor_ref: anchorRef, message_id: messageId, role },
  });
  const json = /** @type {{ok?: boolean, error?: string, duplicate?: boolean, entry?: any}} */ (await res.json());
  if (!json.ok) throw Object.assign(new Error(json.error || 'API returned not-ok'), { status: res.status });
  return { entry: json.entry, duplicate: Boolean(json.duplicate) };
}

/**
 * One document thread (`GET /thread?doc_kind=&doc_ref=`): entries joined with
 * their full message bodies, flat-ordered by created, roles carried. An anchor
 * with no entries returns ok with an empty list (empty thread, not an error).
 * @param {string} docKind
 * @param {string} docRef
 * @returns {Promise<{doc_kind: string, doc_ref: string, count: number, entries: Array<{id: number, role: string, created: string, message_id: number, message: {id: number, ts: string, date: string, kind: string, subject: string|null, ref: string|null, meta: string|null, body: string}}>}>}
 */
export async function threadGet(docKind, docRef) {
  const res = await call('GET', '/thread', { params: { doc_kind: docKind, doc_ref: docRef } });
  const json = /** @type {{ok?: boolean, error?: string} & any} */ (await res.json());
  if (!json.ok) throw new Error(json.error || 'API returned not-ok');
  return json;
}

/**
 * Re-anchor one document-thread entry (`PATCH /thread/:id`) — move it to a new
 * `(doc_kind, doc_ref)`; the only mutation on an entry (no delete exists). The
 * monthly backlog prune uses this to carry prior-month `plan/backlog` entries
 * into that month's `backlog-history-YYYY-MM` (SYSTEM.md "Monthly backlog
 * prune"). Idempotent: the current anchor is a no-op (`moved: false`). Throws
 * when the API is unreachable or refuses (404 = unknown entry, 409 = an
 * identical row already at the target; `.status` carried like threadPost).
 * @param {number} id the thread entry id
 * @param {{docKind: string, docRef: string}} anchor
 * @returns {Promise<{entry: {id: number, doc_kind: string, doc_ref: string, message_id: number, role: string, created: string}, moved: boolean}>}
 */
export async function threadMove(id, { docKind, docRef }) {
  const res = await call('PATCH', `/thread/${encodeURIComponent(String(id))}`, {
    body: { doc_kind: docKind, doc_ref: docRef },
  });
  const json = /** @type {{ok?: boolean, error?: string, moved?: boolean, entry?: any}} */ (await res.json());
  if (!json.ok) throw Object.assign(new Error(json.error || 'API returned not-ok'), { status: res.status });
  return { entry: json.entry, moved: Boolean(json.moved) };
}

/**
 * The thread listing (`GET /thread` without doc_ref): anchors with entry counts
 * and last activity, newest first — `docKind: 'conversation'` is the N2 view of
 * document-less threads. Text lines by default; `format: 'json'` for the envelope.
 * @param {{docKind?: string, limit?: number, format?: string}} [opts]
 * @returns {Promise<string>}
 */
export async function threadList({ docKind, limit, format } = {}) {
  const res = await call('GET', '/thread', { params: { doc_kind: docKind, limit, format } });
  return res.text();
}

/**
 * Report one station's observed state (`PUT /station/:env` - the W3/D1b station
 * registry, one row per station, last-write-wins, NO revision history; rationale
 * in server/README.md). Throws when the API is unreachable or refuses - the
 * caller (cli/util/station.js) fails soft, never the pull tick.
 * @param {string} env the station's WS_ENV
 * @param {Record<string, unknown>} report the env-doctor payload (+ publicIp)
 * @returns {Promise<{line: string, created: boolean}>}
 */
export async function stationReport(env, report) {
  const res = await call('PUT', `/station/${encodeURIComponent(env)}`, { body: { report } });
  const json = /** @type {{ok?: boolean, error?: string, line?: string}} */ (await res.json());
  if (!json.ok) throw new Error(json.error || 'API returned not-ok');
  return { line: json.line || '', created: res.status === 201 };
}

/**
 * The station roster (`GET /station`): every reported row plus every
 * configured-but-silent station (NEVER REPORTED) - absence and staleness are
 * control-plane findings computed server-side at read time.
 * @param {{staleMinutes?: number, format?: string}} [opts]
 * @returns {Promise<string>}
 */
export async function stationList({ staleMinutes, format } = {}) {
  const res = await call('GET', '/station', { params: { stale_minutes: staleMinutes, format } });
  return res.text();
}

/**
 * One station's full stored report (`GET /station/:env`). Throws 'not found'
 * on an env that never reported.
 * @param {string} env
 * @param {{format?: string}} [opts]
 * @returns {Promise<string>}
 */
export async function stationGet(env, { format } = {}) {
  const res = await call('GET', `/station/${encodeURIComponent(env)}`, { params: { format } });
  if (res.status === 404) throw new Error(`station not found: ${env}`);
  return res.text();
}

/**
 * Read endpoint (compact text lines, or JSON text with format=json).
 * @param {{endpoint: '/log'|'/summary'|'/message', params?: Record<string, string|number|undefined>}} q
 * @returns {Promise<string>}
 */
export async function query({ endpoint, params = {} }) {
  const res = await call('GET', endpoint, { params });
  return res.text();
}

/** @returns {Promise<string>} the /health JSON as text */
export async function health() {
  const res = await call('GET', '/health');
  return res.text();
}
