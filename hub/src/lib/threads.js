'use strict';

const { renderMarkdown } = require('./render-markdown');

/**
 * Log API client for document threads (design: central-DB plan
 * nexus-document-threads-design, N1). A thread is the flat, ordered exchange
 * anchored to one document — the CEO commenting, the agent answering — read from
 * `GET /thread?doc_kind=<k>&doc_ref=<r>` (workspace server/README.md "Document
 * threads"). Same server-side client pattern as digests/plans: the API key stays
 * in the Node process, and every entry body is rendered through the one
 * sanitized-markdown pipeline before anything reaches the browser — thread
 * bodies ARE captured page-comment content, untrusted quoted data (WS-H2).
 */

/**
 * The page-comment meta contract's pageType → thread doc_kind map — a verbatim
 * mirror of workspace server/threads.js PAGE_TYPE_TO_DOC_KIND (W1 test plan
 * `test-plan-document-threads-w1`, assumption 1). The two sides MUST agree or a
 * page reads a different anchor than its comments write.
 */
const PAGE_TYPE_TO_DOC_KIND = {
  plans: 'plan',
  digests: 'digest',
  agents: 'agent',
  skills: 'skill',
  knowledge: 'knowledge',
  conversations: 'conversation',
};

/** Ref guard (plan slugs, digest dates, agent/skill names) — rejects anything
 *  path-shaped before it reaches the API. Same shape as the plans SLUG_RE. */
const REF_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

/**
 * A document-less conversation thread's doc_ref (N2 convention, documented in
 * CLAUDE.md "Conversations data"): `conv-<epoch-ms>`, generated server-side when
 * the compose box opens one. Never digits-only, so it can never collide with a
 * legacy `/conversation` store id (those are numeric).
 */
const CONV_REF_RE = /^conv-\d+$/;
const newConversationRef = () => `conv-${Date.now()}`;

/** The intake body contract (src/lib/page-comments.js buildComment):
 *  `## Instruction\n<text>\n\n## Page context (...)\n<content>`. */
const INSTRUCTION_RE = /^## Instruction\n([\s\S]*?)\n+## Page context \(/;

/** A conversation OPENER has no page to quote, so its body is the instruction
 *  section alone (buildConversationOpener) — same contract, context omitted. */
const INSTRUCTION_ONLY_RE = /^## Instruction\n([\s\S]*)$/;

function isConfigured(config) {
  return Boolean(config.logApiUrl);
}

/**
 * What a thread entry DISPLAYS. A role-`ceo` entry is a stored page comment whose
 * body carries the full capture contract — instruction plus the page-context
 * echo. Rendering that echo would reprint the whole document inside its own
 * thread, so only the instruction section is shown (test-plan assumption 1);
 * the DB row stays raw and complete. Any body that does not match the contract
 * shape (agent replies, trigger sources, foreign messages) renders in full.
 */
function displayBody(message) {
  const body = String((message && message.body) || '');
  if (message && message.kind === 'page-comment') {
    const m = INSTRUCTION_RE.exec(body) || INSTRUCTION_ONLY_RE.exec(body);
    if (m) return m[1];
  }
  return body;
}

/**
 * A conversation thread's display title, from its opening entry's subject: the
 * intake wrappers (`Conversation: <title> (conversations/<ref>)`,
 * `Page comment: <title> (<pageType>/<slug>)`) are stripped down to the title;
 * anything else stands as-is; no subject falls back to the ref.
 */
function titleFromSubject(subject, fallback) {
  const s = String(subject || '').trim();
  if (!s) return String(fallback || '');
  return s
    .replace(/^(?:Conversation|Page comment):\s*/, '')
    .replace(/\s*\([a-z-]+\/[^)\s]+\)$/, '')
    .trim() || String(fallback || '');
}

/**
 * One document's thread, display-ready, or null when the pageType/slug cannot
 * map to an anchor (unknown pageType, path-shaped ref — the route 404s without
 * any upstream call). `trigger` entries partition to the TOP ("this document
 * exists because of this exchange" — design contract), the rest keep the API's
 * flat `created` order. An anchor with no entries is an empty thread (the page
 * renders just the comment box), never an error. Throws on API failure so the
 * route can render a 502.
 */
/** Raw thread entries for an anchor (server-side only — bodies are untrusted). */
async function fetchThreadEntries(config, docKind, docRef) {
  const headers = {};
  if (config.logApiKey) headers['X-Api-Key'] = config.logApiKey;
  const res = await fetch(
    `${config.logApiUrl}/thread?doc_kind=${docKind}&doc_ref=${encodeURIComponent(docRef)}`,
    { headers }
  );
  if (!res.ok) throw new Error(`log API responded ${res.status}`);
  return (await res.json()).entries || [];
}

/**
 * A page-born conversation thread's archive state: the OPENER's conversation
 * row (`conversation.status` is the one home of archive state — piece 1,
 * workspace server/README.md "Page-born conversations"). Best-effort and
 * normalizing: no conversation id on any entry (pre-piece-1 API), a failed
 * lookup, or an unknown status all read as `active` — the thread page must
 * render either way (TP-convarch-009).
 */
async function conversationStatusOf(config, rawEntries) {
  const opener = rawEntries.find((e) => e.message && e.message.conversation_id != null);
  if (!opener) return 'active';
  try {
    const headers = {};
    if (config.logApiKey) headers['X-Api-Key'] = config.logApiKey;
    const res = await fetch(`${config.logApiUrl}/conversation/${opener.message.conversation_id}`, { headers });
    if (!res.ok) return 'active';
    const data = await res.json();
    return data.conversation && data.conversation.status === 'archived' ? 'archived' : 'active';
  } catch {
    return 'active';
  }
}

/**
 * The trigger-entry → artifact join (piece 1 reverse lookup), shared by the
 * Conversations index AND both conversation detail surfaces — one logic, never
 * duplicated (test plan hub-conversation-detail-artifact-chips-2026-08-17).
 * Maps trigger rows two ways: `byConv` on the trigger message's
 * `conversation_id` (legacy rows, page-born backing rows) and `byRef` on its
 * `message_ref` (a page-born opener's ref IS its `conv-*` doc_ref).
 * `artifactsFor(...lists)` dedupes and returns a spreadable fragment —
 * `{artifacts: [{kind, ref}]}` or `{}`: absence over empty, so an unlinked
 * row or page carries no field at all.
 */
function artifactIndex(triggers) {
  const push = (map, key, val) => {
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(val);
  };
  const byConv = new Map(); // conversation_id -> artifacts
  const byRef = new Map(); // opener message_ref -> artifacts
  for (const t of triggers) {
    const artifact = { kind: t.doc_kind, ref: String(t.doc_ref) };
    if (t.conversation_id != null) push(byConv, String(t.conversation_id), artifact);
    if (t.message_ref) push(byRef, String(t.message_ref), artifact);
  }
  const artifactsFor = (...lists) => {
    const seen = new Set();
    const out = [];
    for (const list of lists) {
      for (const a of list || []) {
        const key = `${a.kind}/${a.ref}`;
        if (!seen.has(key)) {
          seen.add(key);
          out.push(a);
        }
      }
    }
    return out.length ? { artifacts: out } : {};
  };
  return { byConv, byRef, artifactsFor };
}

/**
 * ONE conversation's generated-artifact fragment ({artifacts} or {}) for the
 * detail pages (TP-convchip-001/002): the same best-effort trigger lookup the
 * index joins from — a pre-piece-1 API or any failure yields {} and the page
 * renders chip-less, never broken (TP-convchip-003).
 */
async function conversationArtifacts(config, { conversationIds = [], refs = [] } = {}) {
  const { byConv, byRef, artifactsFor } = artifactIndex(await listTriggerEntries(config));
  return artifactsFor(
    ...conversationIds.map((id) => byConv.get(String(id))),
    ...refs.map((r) => byRef.get(String(r)))
  );
}

async function getThread(config, pageType, slug) {
  const docKind = PAGE_TYPE_TO_DOC_KIND[pageType];
  const docRef = String(slug || '');
  if (!docKind || !REF_RE.test(docRef)) return null;
  const raw = await fetchThreadEntries(config, docKind, docRef);
  // Page-born conversation pages carry their archive state so the thread page
  // can render the archive/unarchive control (TP-convarch-009) — and their
  // artifact linkage, so the header wears the same chips as the index row
  // (TP-convchip-002): matched on every distinct backing conversation id in
  // the thread plus the conv-* ref itself. Other kinds carry neither, and
  // legacy pages read theirs from the store route.
  const isConvThread = docKind === 'conversation' && CONV_REF_RE.test(docRef) && raw.length > 0;
  const [status, artifacts] = isConvThread
    ? await Promise.all([
        conversationStatusOf(config, raw),
        conversationArtifacts(config, {
          conversationIds: [...new Set(raw.map((e) => (e.message ? e.message.conversation_id : null)).filter((v) => v != null))],
          refs: [docRef],
        }),
      ])
    : [undefined, {}];
  // Display fields come from the MESSAGE, not the thread_entry (the CEO,
  // 2026-08-02): `created` is the LINK time — for backfilled history that is
  // the day the entry was attached, not the day the words were written — so it
  // stays ordering plumbing only. `date`/`ts` stamp the entry; message_id,
  // kind and conversation_id (workspace de7b932; null on messages born outside
  // a conversation, and on an API predating the field) are the provenance keys
  // that trace how the entry is saved. Raw body/meta still never leave here.
  const entries = raw.map((e) => {
    const m = e.message || {};
    return {
      id: e.id,
      role: e.role,
      created: e.created,
      date: m.date || String(e.created || '').slice(0, 10),
      ts: m.ts || null,
      message_id: m.id ?? e.message_id ?? null,
      kind: m.kind || null,
      conversation_id: m.conversation_id ?? null,
      html: renderMarkdown(displayBody(e.message)), // sanitized — untrusted quoted data (WS-H2)
    };
  });
  // Thread title (used by the thread-only conversation page): the opening
  // non-trigger entry's subject, unwrapped. Harmless surplus for other kinds.
  const opener = raw.find((e) => e.role !== 'trigger') || raw[0];
  return {
    docKind,
    docRef,
    title: titleFromSubject(opener && opener.message && opener.message.subject, docRef),
    ...(status ? { status } : {}),
    ...artifacts,
    entries: [...entries.filter((e) => e.role === 'trigger'), ...entries.filter((e) => e.role !== 'trigger')],
  };
}

/**
 * A page-born conversation as page-comment CONTEXT (fetchPageContext's
 * `conversations` branch for `conv-*` refs): the thread rendered as a plain
 * transcript, the same presentation the legacy branch gives `/conversation`
 * store transcripts — so a follow-up comment on a conversation thread carries
 * the exchange so far. Returns null when the thread has no entries (no such
 * conversation). Server-side only: raw display bodies never reach the browser
 * through this path — they go into the stored page-context section, which the
 * runner fences as untrusted (WS-H2).
 */
async function getConversationContext(config, ref) {
  if (!CONV_REF_RE.test(String(ref))) return null;
  const raw = await fetchThreadEntries(config, 'conversation', String(ref));
  if (raw.length === 0) return null;
  const who = { ceo: 'CEO', agent: 'Agent', trigger: 'Origin' };
  const opener = raw.find((e) => e.role !== 'trigger') || raw[0];
  return {
    title: titleFromSubject(opener.message && opener.message.subject, ref),
    content: raw
      .map((e) => `### ${who[e.role] || e.role} — ${String(e.created || '').slice(0, 10)}\n\n${displayBody(e.message)}`)
      .join('\n\n'),
  };
}

/**
 * The anchor listing for one doc_kind — `GET /thread?doc_kind=<k>&format=json`
 * (W1 shape: rows {doc_kind, doc_ref, entries, first, last, subject}). Powers
 * the Plans-index/digest-index count joins and the conversation listing.
 * Throws on API failure; count-join callers catch and degrade (assumption 5 of
 * the N2 test plan) — the listing caller surfaces a 502.
 */
async function listThreadAnchors(config, docKind) {
  const headers = {};
  if (config.logApiKey) headers['X-Api-Key'] = config.logApiKey;
  const res = await fetch(`${config.logApiUrl}/thread?doc_kind=${docKind}&format=json&limit=500`, { headers });
  if (!res.ok) throw new Error(`log API responded ${res.status}`);
  const data = await res.json();
  return data.threads || [];
}

/**
 * Every role-`trigger` thread entry — the ONE-call conversation → generated-
 * artifacts reverse lookup (piece 1: `GET /thread?role=trigger`, workspace
 * server/README.md). Rows: {id, doc_kind, doc_ref, role, created, message_id,
 * message_ref, conversation_id, subject}. NEVER throws and feature-detects the
 * API: a pre-piece-1 server ignores `role` and answers with the anchor listing
 * (text lines here, since this call sends no `format=json`), a 400/404, or an
 * `entries`-less JSON shape — all of which degrade to [] so the Conversations
 * index renders with no badges instead of breaking (TP-convarch-006).
 */
async function listTriggerEntries(config) {
  if (!isConfigured(config)) return [];
  try {
    const headers = {};
    if (config.logApiKey) headers['X-Api-Key'] = config.logApiKey;
    const res = await fetch(`${config.logApiUrl}/thread?role=trigger&limit=1000`, { headers });
    if (!res.ok) return []; // old API rejecting, or any upstream error: no badges
    const data = await res.json().catch(() => null); // text lines from an old API land here
    return data && Array.isArray(data.entries) ? data.entries : [];
  } catch (err) {
    console.error(`threads: trigger reverse lookup skipped (${err.message})`);
    return [];
  }
}

/**
 * Best-effort doc_ref → entry-count map for one doc_kind. NEVER throws: the
 * count join is decoration on the Plans / Digests indexes — an upstream
 * failure means no counts, not a broken page. Zero-count refs simply have no
 * key (quiet ledger: absence, not "0").
 */
async function threadCounts(config, docKind) {
  if (!isConfigured(config)) return {}; // TP-nexus-thr-013: no fetch to nowhere
  try {
    const counts = {};
    for (const t of await listThreadAnchors(config, docKind)) {
      if (Number(t.entries) > 0) counts[t.doc_ref] = Number(t.entries);
    }
    return counts;
  } catch (err) {
    console.error(`threads: count join skipped (${err.message})`);
    return {};
  }
}

module.exports = {
  PAGE_TYPE_TO_DOC_KIND,
  CONV_REF_RE,
  newConversationRef,
  isConfigured,
  artifactIndex,
  conversationArtifacts,
  getThread,
  getConversationContext,
  displayBody,
  titleFromSubject,
  fetchThreadEntries,
  listThreadAnchors,
  listTriggerEntries,
  threadCounts,
};
