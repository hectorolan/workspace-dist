// IMAP capture of the CEO's email requests.
// Captures messages that are agent requests: From OWNER_EMAIL, addressed to
// AGENT_EMAIL (the +alias), NOT carrying X-Workspace-Agent (marks our own outgoing
// mail), Message-ID not already seen. The from/to pair is pushed into the
// server-side IMAP search so non-agent mail is never even downloaded.
// Capture only — no AI call happens here. checkPageComments does the same for
// hub page comments already sitting in the central message table.
//
// Security note: anything captured becomes an agent prompt. The from-owner +
// to-agent gate plus the marker header keep random senders out, but email "From"
// can be spoofed; the orchestrator's standing rules (never merge, never deploy,
// human review gate) are the real blast-radius limit. Keep them.
import { mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import * as api from './apiclient.js';

const WINDOW_DAYS = 7;

/**
 * Trust boundary for page-comment capture: wrap everything from the first
 * "## Page context" heading in a random-delimiter fence, so the orchestrator can
 * tell the CEO's "## Instruction" section apart from quoted page content — which
 * may itself contain "## Instruction" headings or imperative text (plan bodies,
 * digest markdown, and notably conversation transcripts carrying inbound email
 * bodies). The random suffix means the quoted content cannot fake the closing
 * marker. The dispatch prompt (runinbox.js) tells the agent the fenced block is
 * untrusted quoted data. Bodies without the heading pass through unchanged.
 * @param {string} body
 */
export function fencePageContext(body) {
  const m = /^## Page context.*$/m.exec(body || '');
  if (!m) return body;
  const head = body.slice(0, m.index);
  const rest = body.slice(m.index + m[0].length).replace(/^\r?\n/, '');
  const tag = `UNTRUSTED-PAGE-CONTEXT-${randomBytes(6).toString('hex')}`;
  return `${head}${m[0]}\n<<<${tag}\n${rest.trimEnd()}\n${tag}>>>`;
}

/** Strip the quoted reply history ("On ... wrote:" / "> quoted"). @param {string} text */
export function stripQuotedHistory(text) {
  const lines = [];
  for (const line of (text || '').split(/\r?\n/)) {
    if (/^On .{0,200}wrote:\s*$/.test(line) || line.startsWith('>')) break;
    lines.push(line);
  }
  return lines.join('\n').trim();
}

/**
 * Parse a captured request file's frontmatter + body. `kind` is empty for email
 * captures and `page-comment` for hub comment captures; `ref` carries the
 * comment's dedupe key (empty for email — its key is the Message-ID).
 * @param {string} file
 * @returns {{subject: string, messageId: string, inReplyTo: string, references: string, kind: string, ref: string, body: string}}
 */
export function parseRequest(file) {
  const raw = readFileSync(file, 'utf8');
  const m = raw.match(/^---\n([\s\S]*?)\n---\n\n?([\s\S]*)$/);
  /** @type {Record<string, string>} */
  const fm = {};
  if (m) {
    for (const line of m[1].split('\n')) {
      const i = line.indexOf(': ');
      if (i > 0) fm[line.slice(0, i)] = line.slice(i + 2).trim();
    }
  }
  return {
    subject: fm['subject'] || '',
    messageId: fm['message-id'] || '',
    inReplyTo: fm['in-reply-to'] || '',
    references: fm['references'] || '',
    kind: fm['kind'] || '',
    ref: fm['ref'] || '',
    body: m ? m[2].trim() : raw.trim(),
  };
}

/** Merge processed.log's ids (the offline fallback ledger) into a seen set. @param {Set<string>} seen @param {string} processed */
function unionProcessed(seen, processed) {
  if (!existsSync(processed)) return;
  for (const line of readFileSync(processed, 'utf8').split('\n')) {
    const id = line.split('|')[0].trim();
    if (id) seen.add(id);
  }
}

/**
 * Poll the inbox and capture new requests to <data>/inbox-tmp/.
 * The seen-ID ledger lives in the central DB (inbox_seen — rides the daily
 * backup); processed.log stays as the offline fallback: reads union both
 * sources. Capture does NOT mark the Message-ID seen (WS-M1, 2026-07-24 audit):
 * the runner records it (DB + processed.log) only AFTER the handling attempt,
 * mirroring page comments — a crash between capture and dispatch re-captures on
 * the next poll instead of silently losing the request.
 * @param {{log?: (line: string) => void}} [opts]
 * @returns {Promise<string[]>} captured file paths
 */
export async function checkInbox({ log = () => {} } = {}) {
  // Identity has NO code defaults (2026-07-20): fail fast rather than poll the
  // wrong mailbox. MAIL_ACCOUNT is a derivation (login account of the alias).
  if (!process.env.OWNER_EMAIL || !process.env.AGENT_EMAIL) {
    throw new Error('OWNER_EMAIL / AGENT_EMAIL are not set — mail identity has no code default (see .env.example)');
  }
  const owner = process.env.OWNER_EMAIL.toLowerCase();
  const agent = process.env.AGENT_EMAIL.toLowerCase();
  const account = process.env.MAIL_ACCOUNT || owner;
  const password = process.env.GMAIL_APP_PASSWORD;
  if (!password) throw new Error('GMAIL_APP_PASSWORD not set');

  const inboxDir = path.join(api.dataDir(), 'inbox-tmp');
  const processed = path.join(inboxDir, 'processed.log');
  mkdirSync(inboxDir, { recursive: true });

  /** @type {Set<string>} */
  let seen;
  try {
    seen = await api.seenIds();
  } catch (e) {
    log(`check-inbox: log API unreachable (${e instanceof Error ? e.message : e}) — using processed.log only`);
    seen = new Set();
  }
  unionProcessed(seen, processed);

  const { ImapFlow } = await import('imapflow');
  const { simpleParser } = await import('mailparser');
  const client = new ImapFlow({
    host: 'imap.gmail.com',
    port: 993,
    secure: true,
    auth: { user: account, pass: password },
    logger: false,
  });
  await client.connect();

  /** @type {string[]} */
  const captured = [];
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  const lock = await client.getMailboxLock('INBOX');
  try {
    const since = new Date(Date.now() - WINDOW_DAYS * 86400000);
    const uids = await client.search({ since, from: owner, to: agent });
    for (const uid of uids || []) {
      const msg = await client.fetchOne(uid, { source: true });
      if (!msg || !msg.source) continue;
      const parsed = await simpleParser(msg.source);

      const messageId = (parsed.messageId || '').trim();
      const fromAddr = (parsed.from?.value?.[0]?.address || '').toLowerCase();
      const rcpt = [parsed.to, parsed.cc]
        .flatMap((a) => (a ? (Array.isArray(a) ? a : [a]) : []))
        .flatMap((a) => a.value.map((v) => (v.address || '').toLowerCase()));
      if (!messageId || seen.has(messageId)) continue;
      if (fromAddr !== owner) continue;
      if (!rcpt.includes(agent)) continue;
      if (parsed.headers.has('x-workspace-agent')) continue; // our own outgoing mail

      const body = stripQuotedHistory(parsed.text || '');
      if (!body) continue;

      const out = path.join(inboxDir, `${stamp}-${captured.length + 1}.md`);
      const collapse = (/** @type {string|undefined} */ v) => (v || '').split(/\s+/).join(' ');
      const refs = Array.isArray(parsed.references) ? parsed.references.join(' ') : parsed.references;
      writeFileSync(
        out,
        '---\n' +
          `subject: ${parsed.subject || ''}\n` +
          `date: ${parsed.date ? parsed.date.toUTCString() : ''}\n` +
          `message-id: ${messageId}\n` +
          `in-reply-to: ${collapse(parsed.inReplyTo)}\n` +
          `references: ${collapse(refs)}\n` +
          '---\n\n' +
          `${body}\n`,
        'utf8',
      );
      seen.add(messageId); // in-run dedupe only — the runner marks seen after handling (WS-M1)
      captured.push(out);
    }
  } finally {
    lock.release();
    await client.logout().catch(() => {});
  }
  return captured;
}

/**
 * Poll the central message table for hub page comments (kind `page-comment`,
 * contract: `ws plan get page-comments-design`) and capture the unseen ones as
 * request files in <data>/inbox-tmp/ — same frontmatter format as the email
 * capture, so the runner handles both through one loop. The dedupe key is the
 * message ref (`page-comment-<ts>`); the runner records it via POST /seen only
 * AFTER the comment is handled, so a crashed run retries (mail works the same
 * way since WS-M1). The body is written with the page-context section fenced
 * (fencePageContext, WS-H2) so the dispatch prompt can declare it untrusted.
 * API unreachable → empty result, never a throw: the comments already
 * live in the message table and simply wait for the next poll.
 *
 * WS-M3 (reworked 2026-07-25 — lifecycle): the poll fetches ONLY comments in
 * lifecycle state `waiting` (server-side filter; state machine in
 * server/README.md) — no time window, no row-cap semantics decide what gets
 * processed. Paging (`before_id`, descending) still walks the whole waiting set,
 * and the server sweeps stale `read` claims back to waiting and >24h waiting
 * rows to terminal `never_processed` BEFORE answering, so nothing waiting is
 * ever skipped and nothing expired is ever dispatched. If the scan cannot be
 * proven complete (page guard hit, or a not-yet-redeployed server ignores
 * `before_id`/`state` — then the seen-set below filters, ce6a3ed behavior),
 * whatever was visible is still captured AND a `failed` compliance line is
 * logged (never-hide rule). `pageLimit`/`maxPages`/`listArchived` are test
 * seams; production callers pass nothing.
 *
 * Archived conversations are DROPPED at selection time (the CEO's ruling,
 * 2026-08-17: replies normally arrive faster than the CEO could archive, so an
 * archive on an unanswered thread means it was lingering or they no longer hold
 * interest — do not attend to it). The filter reads the archived conversation
 * ids once per poll and skips any waiting comment whose conversation_id is in
 * that set — nothing is captured, claimed, or marked seen, and comment_state
 * stays `waiting`, so UNARCHIVING makes the comment eligible again with no
 * restore step (until the untouched 24h waiting-expiry retires it, as for any
 * waiting comment). Every skip is one line in the run's own log, repeated every
 * poll while it persists — visible, never silent; and the filter fails OPEN
 * with a loud line (blocking all intake on it would be worse, and listMessages
 * on the same API would almost certainly have failed first).
 * @param {{log?: (line: string) => void, pageLimit?: number, maxPages?: number,
 *   listArchived?: () => Promise<Array<{id: number}>>}} [opts]
 * @returns {Promise<string[]>} captured file paths
 */
export async function checkPageComments({ log = () => {}, pageLimit = 200, maxPages = 25, listArchived } = {}) {
  const inboxDir = path.join(api.dataDir(), 'inbox-tmp');
  const processed = path.join(inboxDir, 'processed.log');
  mkdirSync(inboxDir, { recursive: true });

  /** @type {Set<string>} */
  let seen;
  /** @type {Awaited<ReturnType<typeof api.listMessages>>} */
  const entries = [];
  let complete = false;
  try {
    seen = await api.seenIds();
    /** @type {number | undefined} */
    let beforeId;
    for (let page = 0; page < maxPages; page++) {
      const batch = await api.listMessages({ kind: 'page-comment', state: 'waiting', limit: pageLimit, beforeId });
      if (batch.length === 0) { complete = true; break; }
      const minId = Math.min(...batch.map((m) => m.id));
      if (beforeId !== undefined && minId >= beforeId) break; // ids stopped descending: server ignored before_id (deployment skew) — incomplete
      entries.push(...batch);
      if (batch.length < pageLimit) { complete = true; break; }
      beforeId = minId;
    }
  } catch (e) {
    log(`check-page-comments: log API unreachable (${e instanceof Error ? e.message : e}) — comments wait in the message table`);
    return [];
  }
  entries.sort((a, b) => a.id - b.id); // oldest first: a drained backlog replies in arrival order
  if (!complete) {
    // Never silent (WS-M3): older comments beyond what this scan could see stay
    // invisible until the backlog drains — say so loudly, every poll it persists.
    const msg = `compliance: page-comment poll truncated after ${entries.length} rows — older comments may be waiting unseen until the backlog drains (WS-M3)`;
    log(`check-page-comments: ${msg}`);
    await api.log({ area: 'inbox', status: 'failed', message: msg, agent: 'runner' });
  }
  unionProcessed(seen, processed);

  // The archived-conversation set (archive-means-drop, doc above). /conversation
  // caps limit at 500 — beyond 500 archived conversations the oldest would escape
  // the filter (orders of magnitude above current scale, recorded in the test plan).
  /** @type {Set<number>} */
  let archived = new Set();
  try {
    const rows = await (listArchived ? listArchived() : api.convList({ status: 'archived', limit: 500 }));
    archived = new Set(rows.map((c) => c.id));
  } catch (e) {
    log(`check-page-comments: archived-conversation fetch failed (${e instanceof Error ? e.message : e}) — archive skip filter inactive this poll`);
  }

  /** @type {string[]} */
  const captured = [];
  for (const m of entries) {
    const ref = (m.ref || '').trim();
    // Seen-set filter stays as the belt under the server-side waiting filter: it
    // covers refs recorded only in processed.log (markSeen failed offline — the row
    // is still `waiting` server-side) and a not-yet-redeployed server that ignores
    // the `state` param entirely.
    if (!ref || seen.has(ref)) continue;
    if (m.conversation_id && archived.has(m.conversation_id)) {
      // Selection-time skip only — state and seen-ledger untouched, so an
      // unarchive restores eligibility on the next poll. Loud on every poll.
      log(`check-page-comments: skipped ${ref} — conversation ${m.conversation_id} is archived (archive means drop; unarchive to make it eligible again)`);
      continue;
    }
    let body;
    try {
      body = (await api.messageBody(m.id)).trim();
    } catch (e) {
      log(`check-page-comments: body fetch failed for message ${m.id} (${e instanceof Error ? e.message : e})`);
      continue;
    }
    if (!body) continue;
    const out = path.join(inboxDir, `${ref}.md`);
    writeFileSync(
      out,
      '---\n' +
        `subject: ${m.subject || ''}\n` +
        `date: ${m.ts || ''}\n` +
        'kind: page-comment\n' +
        `ref: ${ref}\n` +
        '---\n\n' +
        `${fencePageContext(body)}\n`,
      'utf8',
    );
    captured.push(out);
  }
  return captured;
}
