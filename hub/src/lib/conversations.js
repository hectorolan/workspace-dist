'use strict';

const { renderMarkdown } = require('./render-markdown');
const { CONV_REF_RE, artifactIndex, conversationArtifacts, fetchThreadEntries, listThreadAnchors, listTriggerEntries, titleFromSubject } = require('./threads');
const { getIdentity } = require('./identity');

/**
 * Log API client for the Conversations section. All calls run server-side with the
 * X-Api-Key header (config.logApiKey) — nothing API-related is ever sent to the
 * browser except the rendered HTML.
 */

/** Digits-only id guard — rejects anything path-shaped before it reaches the API. */
const ID_RE = /^\d{1,12}$/;

/**
 * Listing filters (R2). `active` (the default view) and `archived` are passed to the
 * API as `?status=`; `all` omits the param (contract: omit = all). Anything else falls
 * back to `active`.
 */
const LIST_STATUSES = ['active', 'archived', 'all'];

/** Soft-delete states a conversation can be set to (R1). */
const SET_STATUSES = ['active', 'archived'];

/**
 * Normalize a row's `status`: rows from an API that predates the `status` column — the
 * pre-archive contract — have no field and are treated as `active`, so the page renders
 * (never 500s) before the server deploys the column. Mirror of plans.js normalizeKind.
 */
function normalizeStatus(row) {
  return { ...row, status: SET_STATUSES.includes(row.status) ? row.status : 'active' };
}

/**
 * How each stored message kind is presented in a thread. The CEO-side speaker
 * label comes from the instance identity (GET /identity — naming-is-config,
 * TP-ceoconf-010), never a hardcoded name; the generic `ceo` rail class matches
 * the document-thread styling.
 */
function rolesFor(identity) {
  return {
    'inbox-request': { who: identity.name, cls: 'ceo' },
    'inbox-reply': { who: 'Agent', cls: 'agent' },
    'inbox-error': { who: 'Agent · failure notice', cls: 'agent-error' },
  };
}

function isConfigured(config) {
  return Boolean(config.logApiUrl);
}

async function apiGet(config, apiPath) {
  const headers = {};
  if (config.logApiKey) headers['X-Api-Key'] = config.logApiKey;
  return fetch(config.logApiUrl + apiPath, { headers });
}

/**
 * Newest-activity-first conversation index:
 * [{id, title, status, created_at, updated_at, message_count}].
 * `status` (active|archived|all) is passed to the API as a server-side filter; `active`
 * is the default view (R2). `all` omits the param (contract: omit = all). Every row's
 * `status` is normalized so a pre-`status` API degrades gracefully (rows render as
 * `active`), never a 500 (TP-conv-filter-006).
 */
async function listConversations(config, status = 'active') {
  const filter = status === 'active' || status === 'archived' ? `&status=${status}` : '';
  const res = await apiGet(config, `/conversation?format=json&limit=200${filter}`);
  if (!res.ok) throw new Error(`log API responded ${res.status}`);
  const data = await res.json();
  return (data.conversations || []).map(normalizeStatus);
}

/**
 * The Plans-page conversation view (N2): active legacy email conversations from
 * the `/conversation` store merged with the document-less threads from the
 * `/thread` anchor listing, newest activity first. Two rules, both under test:
 * digits-only thread refs are comments left ON a legacy conversation's page —
 * they render there, never as standalone rows; and legacy rows keep their own
 * message_count while thread rows carry their entry count. Rows:
 * `{ref, title, legacy, status, updated, entries, artifacts?}` — `ref` is the
 * /conversations/:ref path segment either way (assumption 3/4 of the N2 test
 * plan). `includeArchived` (the Conversations-subtab toggle,
 * hn-documents-subtabs-2026-08-15 TP-docsub-016) adds archived rows of BOTH
 * populations: a page-born thread's archive state is its opener's
 * `conversation_status` from the anchor listing (piece 1) — absent on an old
 * API, which normalizes to `active`, today's behavior (TP-convarch-007).
 *
 * Two piece-1 joins, both from calls this listing already affords:
 *  - artifacts: the one-call trigger reverse lookup (listTriggerEntries,
 *    best-effort []) — legacy rows match a trigger message's `conversation_id`,
 *    page-born rows match their anchor's opener `conversation_id` OR the
 *    trigger's `message_ref` (a page-born opener's ref IS its `conv-*`
 *    doc_ref); each artifact renders as a chip linking /plans/<ref>
 *    (TP-convarch-005/006);
 *  - opener dedupe: a page-born opener always has a backing `conversation` row
 *    that the legacy listing also returns — rows whose id appears as a `conv-*`
 *    anchor's `conversation_id` are the SAME conversation wearing its store
 *    face, so they never list as their own row (TP-convarch-008). Follow-up
 *    rows spanning the same thread are not deduped (would cost one thread read
 *    per row — accepted residual, unchanged from before piece 1).
 */
async function listConversationItems(config, { includeArchived = false } = {}) {
  const [legacy, anchors, triggers] = await Promise.all([
    listConversations(config, includeArchived ? 'all' : 'active'),
    listThreadAnchors(config, 'conversation'),
    listTriggerEntries(config), // best-effort: [] on an old API or any failure
  ]);

  // The shared trigger-join (threads.js artifactIndex — the SAME logic the
  // detail pages resolve their header chips with): byConv/byRef maps plus the
  // deduping `{artifacts}` fragment builder ({} when unlinked — absence over
  // empty).
  const { byConv, byRef, artifactsFor } = artifactIndex(triggers);

  const born = anchors.filter((t) => !/^\d+$/.test(String(t.doc_ref)));
  const openerConvIds = new Set(born.filter((t) => t.conversation_id != null).map((t) => String(t.conversation_id)));
  const bornStatus = (t) => (t.conversation_status === 'archived' ? 'archived' : 'active');

  return [
    ...legacy
      .filter((c) => !openerConvIds.has(String(c.id))) // opener dedupe
      // `all` omits the status param; keep only known states either way.
      .filter((c) => c.status === 'active' || (includeArchived && c.status === 'archived'))
      .map((c) => ({
        ref: String(c.id),
        title: c.title,
        legacy: true,
        status: c.status,
        updated: c.updated_at,
        entries: c.message_count,
        ...artifactsFor(byConv.get(String(c.id))),
      })),
    ...born
      .filter((t) => bornStatus(t) === 'active' || includeArchived)
      .map((t) => ({
        ref: String(t.doc_ref),
        title: titleFromSubject(t.subject, t.doc_ref),
        legacy: false,
        status: bornStatus(t),
        updated: t.last,
        entries: Number(t.entries) || 0,
        ...artifactsFor(
          t.conversation_id != null ? byConv.get(String(t.conversation_id)) : null,
          byRef.get(String(t.doc_ref))
        ),
      })),
  ].sort((a, b) => String(b.updated).localeCompare(String(a.updated)));
}

/** One `PATCH /conversation/:id {status}` — the single upstream write shape. */
async function patchConversationStatus(config, id, status) {
  const headers = { 'Content-Type': 'application/json' };
  if (config.logApiKey) headers['X-Api-Key'] = config.logApiKey;
  const res = await fetch(`${config.logApiUrl}/conversation/${id}`, {
    method: 'PATCH',
    headers,
    body: JSON.stringify({ status }),
  });
  if (!res.ok) throw new Error(`log API responded ${res.status}`);
  const data = await res.json().catch(() => ({}));
  if (data.ok === false) throw new Error('log API returned not-ok');
  return data;
}

/**
 * Archive/unarchive a conversation via `PATCH /conversation/:id {status}` — same
 * server-side client (logApiUrl + X-Api-Key) as the rest of this lib, never a parallel
 * API implementation, and the key never reaches the browser. Both populations
 * (TP-convarch-001..004), fully reversible, never a delete:
 *  - a numeric id is a legacy `/conversation` store row — one PATCH;
 *  - a `conv-<epoch-ms>` ref is a page-born thread — archive state lives in its
 *    backing conversation rows (piece 1, workspace server/README.md "Page-born
 *    conversations"): read the thread and PATCH every distinct non-null
 *    `message.conversation_id` (one thread can span an opener plus follow-up
 *    conversation rows). No rows to PATCH (empty thread, or a pre-piece-1 API
 *    whose entries carry no conversation_id) returns null — a clean 404, never
 *    a broken page.
 * Returns null for an invalid ref or status (guarded before any request); throws
 * on an API failure so the caller can show a friendly error.
 */
async function setConversationStatus(config, id, status) {
  if (!SET_STATUSES.includes(status)) return null;
  const ref = String(id);
  if (CONV_REF_RE.test(ref)) {
    const entries = await fetchThreadEntries(config, 'conversation', ref);
    const ids = [...new Set(
      entries.map((e) => (e.message ? e.message.conversation_id : null)).filter((v) => v != null)
    )];
    if (ids.length === 0) return null;
    for (const convId of ids) await patchConversationStatus(config, convId, status);
    return { ok: true, ids };
  }
  if (!ID_RE.test(ref)) return null;
  return patchConversationStatus(config, ref, status);
}

/**
 * One conversation with its messages rendered for display, or null when the id is
 * invalid (TP-conversations-viewer-005) or unknown (404 from the API). The
 * payload carries the conversation's generated-artifact linkage for the detail
 * header's chips (TP-convchip-001) — the shared trigger-join, best-effort:
 * unlinked or degraded means no `artifacts` field, never a failure.
 */
async function loadConversation(config, id) {
  if (!ID_RE.test(String(id))) return null;
  const res = await apiGet(config, `/conversation/${id}`);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`log API responded ${res.status}`);
  const data = await res.json();
  const [identity, artifacts] = await Promise.all([
    getIdentity(config),
    conversationArtifacts(config, { conversationIds: [String(id)] }),
  ]);
  const roles = rolesFor(identity);
  const messages = (data.messages || []).map((m) => {
    const role = roles[m.kind] || { who: m.kind, cls: 'other' };
    return {
      id: m.id,
      kind: m.kind,
      date: m.date,
      ts: m.ts,
      who: role.who,
      cls: role.cls,
      body: m.body || '', // raw source — page-comments transcript (TP-page-comments-006)
      html: renderMarkdown(m.body), // sanitized — email-origin content (TP-audit-remediation-002)
    };
  });
  return { conversation: normalizeStatus(data.conversation || {}), messages, ...artifacts };
}

module.exports = {
  isConfigured,
  listConversations,
  listConversationItems,
  loadConversation,
  setConversationStatus,
  LIST_STATUSES,
  SET_STATUSES,
};
