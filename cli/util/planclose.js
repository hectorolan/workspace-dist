// Plan close — evidence-based test-plan closure for main-direct repos, and the
// CEO block that names what is holding a plan open.
//
// WHY THIS EXISTS: `ws pull`'s PR watch closes a test-plan when its PR merges
// (util/prwatch.js). The workspace repo is main-direct by rule (CLAUDE.md GitHub
// sync rule 3) — no PR ever exists — so its test-plans had NO closure trigger at
// all and simply accumulated: 7 active on 2026-07-31, one of them
// (test-plan-ci-guard) stating outright that every case is automated with no
// manual and no deferred, and still sitting open because nothing was ever going
// to sweep it. This module is the missing trigger.
//
// WHAT COUNTS AS EVIDENCE (Hector, 2026-07-31): a green test run that
// covers the plan's cases — never elapsed time, never "the sync was green" on its
// own. `ws sync` already runs the gates and util/baseline.js already extracts the
// passing case IDs out of that output, so the evidence is a by-product of the
// push that is happening anyway; a plan closes because its tests demonstrably
// ran and passed. A plan whose automated cases are ALL covered and which has no
// unperformed manual/deferred case closes with one `done` audit line. Anything
// else stays active, and the reason is pinned where the CEO will see it.
//
// THE CEO BLOCK: a blockquote pinned at the very top of a held plan naming ONLY
// what is blocked on the CEO — never a summary of the plan, never what is already
// done (his words: "IN THE TOP ONLY GOES WHAT IS BLOCKED BECAUSE THE CEO"). It is
// written and removed by this script alone, so it can never go stale: the moment
// the last manual case is performed, the next sweep strips it.
//
// Closure stays SCRIPTED, never agent-decided (CLAUDE.md: "Test-plans close on
// PR merge by script, never by agents") — this module only widens that rule to
// cover the no-PR case, it does not hand the decision to a model.
import * as api from './apiclient.js';
import { audit } from './audit.js';
import { CASE_ID_SOURCE, baselineSlug, expandCaseIds, parseBaseline } from './baseline.js';
import { ceoName, ceoPattern } from './ceo.js';
import { hasOpenFollowUps, unperformedCases } from './prwatch.js';

/** Agent name on the audit lines this module writes (a scripted log-writer). */
export const CLOSE_AGENT = 'plan-close';

/** Terminal statuses are never close candidates (same list prwatch excludes). */
const PLAN_EXCLUDE = 'done,archived';

/**
 * Drop the `# <slug> | <kind> | <status> | <date> | <title>` line(s) the plan API
 * RENDERS on top of a stored body — a READ-side normalizer, not the fix.
 *
 * THE REAL FIX for header stacking is server-side (`stripRenderedHeader` in
 * server/server.js): `PUT /plan/:slug` now strips the banner it renders, so no
 * writer of any kind — this module, `ws plan set --file`, plans-import, curl —
 * can bake one into a body any more.
 *
 * This stays because the READ is still rendered on purpose (the banner is what
 * makes `ws plan get` readable to a human), so a caller that reads a body and
 * then reasons about it has to normalize what it read. Here that matters
 * concretely: the sweep compares `pinned !== body` to decide whether the CEO
 * block actually changed, and an un-normalized read would differ every single
 * sweep and write a duplicate `blocked` line on every sync. Repeated leading
 * headers are all removed, so a plan corrupted before the server fix reads
 * correctly too.
 * @param {string} body
 */
export function stripPlanHeader(body) {
  let out = body.replace(/^﻿/, '');
  for (;;) {
    const next = out.replace(/^#\s+\S+\s+\|[^\n]*\n+/, '');
    if (next === out) return out;
    out = next;
  }
}

/** Markers delimiting the pinned CEO block. HTML comments: invisible when rendered. */
const CEO_OPEN = '<!-- ceo-block -->';
const CEO_CLOSE = '<!-- /ceo-block -->';
/** Built per call, not frozen at import: the name is config (cli/util/ceo.js). */
const ceoLead = () => `> **${ceoName()}, I need you to:**`;

/**
 * Colloquial asks authored by whoever wrote the plan, one bullet per case ID,
 * under a `## Needs <CEO>` heading. The script pins only the ones whose case is
 * STILL unperformed, so the author writes the sentence once and never maintains
 * it. Case text is the fallback when the author left no bullet — mechanical and
 * ugly on purpose, so a missing sentence is visible rather than silently absent.
 */
const needsHeadingRe = () => new RegExp(`^#{1,6}\\s*needs?\\s+(?:the\\s+)?(?:${ceoPattern()})\\b`, 'i');

/**
 * Author-supplied colloquial asks, keyed by case ID.
 * @param {string} body
 * @returns {Map<string, string>}
 */
export function authoredAsks(body) {
  const caseId = new RegExp(CASE_ID_SOURCE);
  /** @type {Map<string, string>} */
  const asks = new Map();
  const lines = body.split(/\r?\n/);
  let inSection = false;
  for (let i = 0; i < lines.length; i++) {
    if (/^#{1,6}\s/.test(lines[i])) {
      inSection = needsHeadingRe().test(lines[i]);
      continue;
    }
    if (!inSection) continue;
    const m = /^\s*[-*]\s+(.*)$/.exec(lines[i]);
    if (!m) continue;
    const id = (caseId.exec(m[1]) || [''])[0];
    if (!id) continue;
    // A colloquial sentence routinely wraps across lines; reading only the first
    // one truncates it mid-thought ("open the Stations page and check the new
    // control-plane" — the actual ask lost). Absorb the continuation lines.
    let text = m[1];
    let j = i + 1;
    for (; j < lines.length; j++) {
      const t = lines[j].trim();
      if (!t || /^#{1,6}\s/.test(t) || /^\s*[-*]\s/.test(lines[j]) || t.startsWith('|')) break;
      text += ` ${t}`;
    }
    i = j - 1;
    // Drop the ID and any leading dash/colon separator — the sentence is what shows.
    const clean = text.replace(id, '').replace(/^\s*[-—:–]\s*/, '').replace(/\s+/g, ' ').trim();
    if (clean) asks.set(id, clean);
  }
  return asks;
}

/**
 * One colloquial line per thing that needs the CEO.
 * @param {string} body
 * @returns {string[]}
 */
export function ceoAsks(body) {
  const asks = authoredAsks(body);
  return unperformedCases(body).map(({ id, text }) => {
    const authored = id && asks.get(id);
    if (authored) return id ? `${authored} (${id})` : authored;
    // Mechanical fallback: the case's own description cell, which is technical
    // rather than colloquial — that is the signal to go author a real sentence.
    const cell = text.trim().startsWith('|')
      ? (text.trim().split('|').map((c) => c.trim()).filter(Boolean)[1] || text.trim())
      : text.split(/\r?\n/)[0].replace(/^\s*[-*]\s+/, '').trim();
    return id ? `${cell} (${id})` : cell;
  });
}

/**
 * Body with any existing CEO block removed (and the blank line it owned).
 * Idempotence matters: every sweep rewrites the block, so a stale one must never
 * survive alongside a fresh one.
 * @param {string} body
 */
export function stripCeoBlock(body) {
  const open = body.indexOf(CEO_OPEN);
  if (open === -1) return body;
  const close = body.indexOf(CEO_CLOSE, open);
  if (close === -1) return body; // malformed — leave it alone rather than eat content
  const head = body.slice(0, open);
  const tail = body.slice(close + CEO_CLOSE.length).replace(/^(\r?\n){1,2}/, '');
  // The block owned exactly one blank line on each side; collapse what is left
  // so repeated pin→strip cycles cannot accrete whitespace at the top.
  return head.replace(/(\r?\n){2,}$/, '\n\n') + tail;
}

/**
 * Body with the CEO block pinned directly under the plan's H1 (or at the very
 * top when there is none). No asks → the block is simply absent.
 * @param {string} body
 * @param {string[]} asks
 */
export function pinCeoBlock(body, asks) {
  const base = stripCeoBlock(body);
  if (!asks.length) return base;
  const block = [
    CEO_OPEN,
    ceoLead(),
    '>',
    ...asks.map((a) => `> - ${a}`),
    CEO_CLOSE,
  ].join('\n');
  const lines = base.split(/\r?\n/);
  const h1 = lines.findIndex((l) => /^#\s/.test(l));
  if (h1 === -1) return `${block}\n\n${base}`;
  const head = lines.slice(0, h1 + 1).join('\n');
  const tail = lines.slice(h1 + 1).join('\n').replace(/^(\r?\n)+/, '');
  return `${head}\n\n${block}\n\n${tail}`;
}

/** Full case IDs plus `A/B/C` shorthand runs. */
const ID_RUN_SOURCE = `${CASE_ID_SOURCE.replace(/\\b$/, '')}(?:/\\d{3})*\\b`;

/**
 * Case IDs a coverage cell cites as covering it, excluding the row's own ID.
 *
 * Full IDs are read FIRST and then removed from the text, because the tail of a
 * shorthand run (`TP-prwatch-plan-close-001/002/005`) otherwise looks exactly
 * like a bare local citation and would be resolved against the wrong prefix —
 * inventing `TP-obs48b-002` out of another plan's `002` and holding the plan on
 * a case that was never cited.
 * @param {string} cover
 * @param {string} id the row's own case ID
 * @returns {string[]}
 */
function citedIds(cover, id) {
  const prefix = id.slice(0, id.lastIndexOf('-') + 1);
  /** @type {Set<string>} */
  const cites = new Set();
  const rest = cover.replace(new RegExp(ID_RUN_SOURCE, 'g'), (token) => {
    for (const c of expandCaseIds(token)) if (c !== id) cites.add(c);
    return ' ';
  });
  // Bare numbers may carry the duplicate-resolution suffix (`079_2` cites the
  // suffixed case); the trailing `[0-9_]` guard keeps `079` from being invented
  // out of `079_2`. Suffixes ride the head only — run tails stay bare, the same
  // grammar CASE_ID_RUN speaks (see CASE_ID_SOURCE in util/baseline.js).
  for (const [, group] of rest.matchAll(/(?<![A-Za-z0-9-])(\d{3}(?:_\d+)?(?:\/\d{3})*)(?![0-9_])/g)) {
    for (const n of group.split('/')) if (`${prefix}${n}` !== id) cites.add(`${prefix}${n}`);
  }
  return [...cites];
}

/**
 * Automated rows of a plan: the case ID, plus any case IDs its coverage cell
 * CITES as the thing that actually covers it.
 *
 * Citation exists because "regression: the existing suites still pass" is a real
 * and common case type, and no test will ever be named for it. Without a way to
 * express that, every plan would carry one such case and could never close —
 * which would defeat the whole feature. Citation keeps it TRACEABLE rather than
 * trusted: `automated (TP-prwatch-plan-close-001/002/005 kept green)` is covered
 * only when those IDs are themselves covered by the run. Bare numbers are
 * resolved against the row's own prefix, since plans write `(010/012 cover it)`.
 *
 * Rows leading with manual/deferred are excluded by construction — a plan full
 * of manual cases is never "missing coverage" for them; it is held by the CEO
 * block instead.
 *
 * THIRD FORM — a list introduced as automated. Plans also write the mode ONCE,
 * over a whole list ("Server suite (`server/test/x.test.js`) — all `automated`:"),
 * and then bold each ID: `- **TP-convarch-001** — what it proves`. Reading only
 * the per-row forms made `hub-conversation-archive-api-2026-08-17` report "no
 * automated case IDs" with all 10 of its cases green and its tests tagged — the
 * same permanently-unclosable failure the bullet form was added to remove
 * (2026-08-18). The lead-in must END in `:` with automated/manual/deferred as its
 * last word, which is the list-introducer idiom and nothing else: a paragraph that
 * merely mentions the word ("Manual cases: **none** — everything above is
 * machine-checkable") does not set a mode, and a heading clears it.
 * @param {string} body
 * @returns {Array<{id: string, cites: string[]}>}
 */
export function automatedRows(body) {
  const caseId = new RegExp(CASE_ID_SOURCE);
  /** @type {Map<string, string[]>} */
  const rows = new Map();
  /** @type {string} mode declared by the current list's lead-in ('' = none) */
  let listMode = '';
  for (const line of body.split(/\r?\n/)) {
    const trimmed = line.trim();
    const isBullet = /^\s*[-*]\s+/.test(line);
    if (!isBullet && !trimmed.startsWith('|')) {
      if (trimmed.startsWith('#')) listMode = '';
      const leadIn = /(automated|manual|deferred)[`*_\s]*:$/i.exec(trimmed);
      if (leadIn) listMode = leadIn[1].toLowerCase();
    }
    if (trimmed.startsWith('|')) {
      const cells = trimmed.split('|').map((c) => c.trim()).filter(Boolean);
      if (cells.length < 2) continue;
      const cover = cells[cells.length - 1];
      if (/^[*_\s]*(manual|deferred)\b/i.test(cover)) continue;
      const id = (caseId.exec(cells[0]) || [''])[0];
      if (id) rows.set(id, citedIds(cover, id));
      continue;
    }
    // Bullet form: `- TP-server-tz-001 (automated): …`. Plans use it as freely as
    // the table form, and reading only tables made a whole plan look like it had
    // no automated cases at all — permanently unclosable, the exact failure this
    // module exists to remove.
    // Bold IDs are as common as bare ones (`- **TP-x-001** …`) — the asterisks are
    // emphasis, never grammar.
    const bullet = /^\s*[-*]\s+[*_]*(TP-[A-Za-z0-9-]*-\d{3}(?:_\d+)?)[*_]*\s*(?:\(([^)]*)\))?/.exec(line);
    if (!bullet) continue;
    const [, id, parenthetical] = bullet;
    // An explicit `(automated)` on the row wins; otherwise the list's declared mode.
    const mode = parenthetical === undefined ? listMode : (/\b(manual|deferred)\b/i.test(parenthetical) ? 'manual' : (/\bautomated\b/i.test(parenthetical) ? 'automated' : ''));
    if (mode !== 'automated') continue;
    // Citations are read from an explicit coverage parenthetical ONLY. A free-prose
    // description is not a coverage cell: `citedIds` resolves bare three-digit runs
    // against the row's prefix, so "unknown `role` → 400" would invent a citation of
    // TP-<slug>-400 and hold the plan open forever on a case that does not exist.
    rows.set(id, parenthetical === undefined ? [] : citedIds(parenthetical, id));
  }
  return [...rows].map(([id, cites]) => ({ id, cites })).sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * Back-compat view: just the automated case IDs.
 * @param {string} body
 * @returns {string[]} sorted, deduped
 */
export function automatedCaseIds(body) {
  return automatedRows(body).map((r) => r.id);
}

/**
 * @typedef {object} Verdict
 * @property {'close'|'hold'|'skip'} action
 * @property {string} reason one line, safe to log
 * @property {string[]} asks CEO-block lines (empty unless action==='hold' on a human)
 * @property {string[]} missing automated case IDs the run did not cover
 */

/**
 * Should this plan close against the case IDs a green run just covered?
 *
 * Order matters: coverage is checked BEFORE the human hold, so a plan whose
 * tests have not all run yet is `skip` (nothing to say — the work is simply not
 * finished) rather than `hold` (the CEO is the blocker). Pinning a CEO block on a
 * plan whose code is still being written would train him to ignore the block.
 *
 * @param {{body: string, covered: Iterable<string>}} p
 * @returns {Verdict}
 */
export function closureVerdict({ body, covered }) {
  const have = new Set(covered);
  const rows = automatedRows(body);
  const expect = rows.map((r) => r.id);
  // A row is satisfied by its own passing test, or — when it cites others — by
  // every cited case being covered. Citations must be non-empty to count: a row
  // citing nothing has to stand on its own ID.
  const missing = rows
    .filter((r) => !have.has(r.id) && !(r.cites.length && r.cites.every((c) => have.has(c))))
    .map((r) => r.id);
  if (!expect.length) {
    return { action: 'skip', reason: 'no automated case IDs — nothing a test run can evidence', asks: [], missing: [] };
  }
  if (missing.length) {
    return {
      action: 'skip',
      reason: `${missing.length}/${expect.length} automated case(s) not covered by this run: ${missing.slice(0, 5).join(', ')}`,
      asks: [],
      missing,
    };
  }
  if (hasOpenFollowUps(body)) {
    return {
      action: 'hold',
      reason: `all ${expect.length} automated case(s) green, held by open follow-ups / unperformed manual cases`,
      asks: ceoAsks(body),
      missing: [],
    };
  }
  return { action: 'close', reason: `all ${expect.length} automated case(s) covered by a green run`, asks: [], missing: [] };
}

/** @typedef {{list: typeof api.planList, get: typeof api.planGet, set: typeof api.planSet}} PlanDeps */

/**
 * Sweep the repo's active test-plans against one green run's covered case IDs.
 *
 * Never throws into the caller: this runs AFTER a push has already landed, so a
 * plan-API failure must degrade to a note exactly like the baseline advance does
 * — the push is not undone by a bookkeeping failure. Failures that strand a plan
 * (list/set) get a loud `failed` line, matching prwatch's backlog-48b rule: no
 * retry is coming, so silence would make a stranded plan indistinguishable from
 * a healthy one. Every one of those lines goes through util/audit.js, so a
 * failure of the audit write itself is loud and durable too (backlog 42) — these
 * used to be `.catch(() => {})`, which lost the evidence and said nothing.
 *
 * `sink` overrides where `audit()` persists a write it could not deliver. Tests
 * MUST set it: the default is `<WS_DATA_DIR>/fallback/audit-failures.md`, the
 * disaster-recovery re-import file, and a suite exercising the failure path
 * otherwise appends fabricated audit lines to it on every run (audit 2026-08-01).
 * @param {{repo: string, covered: Iterable<string>, plans?: PlanDeps, log?: typeof api.log, sink?: string}} p
 * @returns {Promise<{closed: string[], held: string[], notes: string[]}>}
 */
export async function sweepClosures({ repo, covered, plans, log = api.log, sink }) {
  const p = plans || { list: api.planList, get: api.planGet, set: api.planSet };
  /** @type {{closed: string[], held: string[], notes: string[]}} */
  const out = { closed: [], held: [], notes: [] };
  /** @type {Array<{slug: string, repo: string|null}>} */
  let rows;
  try {
    // Shape is `{ok, count, plans}` — NOT a bare array (the same envelope
    // prwatch.plansForPR unwraps). `exclude` drops terminal statuses server-side,
    // so "active" is the list itself rather than a field to filter on.
    const text = await p.list({ kind: 'test-plan', exclude: PLAN_EXCLUDE, format: 'json' });
    rows = /** @type {{plans?: Array<{slug: string, repo: string|null}>}} */ (JSON.parse(text)).plans || [];
  } catch {
    await audit({
      repo,
      area: 'plan-close',
      status: 'failed',
      message: `test-plan close sweep could not run (plan API list failed) — ${repo} test-plans may be left active with no closure`,
      agent: CLOSE_AGENT,
    }, { log, sink });
    return { ...out, notes: ['sweep skipped (plan list failed)'] };
  }
  // A null repo means workspace — same default prwatch applies, so both sweeps
  // agree on which plans belong to the main-direct repo.
  const mine = rows.filter((r) => (r.repo || 'workspace') === repo);
  for (const row of mine) {
    /** @type {string} */
    let body;
    try {
      // Normalize the rendered read before reasoning about the body (see stripPlanHeader).
      body = stripPlanHeader(await p.get(row.slug));
    } catch {
      out.notes.push(`${row.slug} skipped (plan get failed)`);
      continue;
    }
    const v = closureVerdict({ body, covered });
    if (v.action === 'skip') {
      out.notes.push(`${row.slug}: ${v.reason}`);
      continue;
    }
    if (v.action === 'hold') {
      const pinned = pinCeoBlock(body, v.asks);
      // The pinned block IS the state: identical block ⇒ the hold has not changed.
      // Log only on a TRANSITION (newly held, or the asks changed). Logging every
      // sweep wrote the same `blocked` line on every sync — 4 identical copies in
      // two days — burying the real signal in the surface built to surface it.
      const changed = pinned !== body;
      if (changed) {
        try {
          await p.set(row.slug, { body: pinned, agent: CLOSE_AGENT });
        } catch {
          out.notes.push(`${row.slug} CEO block not pinned (plan API set failed)`);
          continue;
        }
      }
      out.held.push(row.slug);
      if (!changed) {
        out.notes.push(`${row.slug} still held, unchanged — no duplicate line`);
        continue;
      }
      await audit({
        repo,
        area: 'plan-close',
        status: 'blocked',
        message: `test-plan ${row.slug} ${v.reason} — needs ${ceoName()}: ${v.asks.join(' ;; ') || 'see plan'}`,
        agent: CLOSE_AGENT,
      }, { log, sink });
      continue;
    }
    // Closing: strip any CEO block first, so a plan that was once held does not
    // close carrying a stale "I need you to" banner into the archive.
    const cleaned = stripCeoBlock(body);
    try {
      await p.set(row.slug, { status: 'done', agent: CLOSE_AGENT, ...(cleaned !== body ? { body: cleaned } : {}) });
    } catch {
      await audit({
        repo,
        area: 'plan-close',
        status: 'failed',
        message: `test-plan ${row.slug} close FAILED (plan API set failed) — left active with all automated cases green and no closure line`,
        agent: CLOSE_AGENT,
      }, { log, sink });
      out.notes.push(`${row.slug} close FAILED (plan set failed)`);
      continue;
    }
    out.closed.push(row.slug);
    await audit({
      repo,
      area: 'plan-close',
      status: 'done',
      message: `test-plan ${row.slug} closed (status done) — ${v.reason}`,
      agent: CLOSE_AGENT,
    }, { log, sink });
  }
  return out;
}

/**
 * Cadence-driven sweep for the `ws pull` tick: judge the repo's active test-plans
 * against the STORED baseline plan instead of a fresh run's tallies.
 *
 * WHY: the `ws sync` sweep above fires only on a green push, and it runs against
 * the plan list as it stands at that moment — so a test-plan CREATED after its
 * own landing sync's sweep had no trigger left at all and sat stranded until an
 * unrelated future commit (dist-phase2-rulings-2026-08-26: the plan's first
 * revision was 631, that sync's baseline advance 629). The evidence, though, is
 * already standing: `test-baseline-<repo>` IS "the last green run of each suite"
 * (SYSTEM.md "Regression baseline"), which is exactly the covered set the sync
 * sweep judges. Re-running the same judgement on the pull cadence closes the
 * ordering gap with zero new evidence machinery and zero tokens.
 *
 * Degradation follows the pull-tick contract (prwatch/statussweep): an absent,
 * unparseable, or UNREACHABLE baseline is a QUIET skip — the next tick (15 min)
 * retries, and a loud line per tick during an API outage would flood the offline
 * fallback queue. The loud backlog-48b `failed` lines stay inside sweepClosures
 * (plan list/set failures), which by construction can only fire once the API was
 * healthy enough to serve the baseline — a genuine anomaly, not an outage.
 * Idempotence and quiet come from sweepClosures itself: a close is terminal (the
 * plan leaves the active list), and a hold logs on TRANSITION only (the pinned
 * CEO block is the state), so repeated ticks on every station write nothing new.
 *
 * @param {{repo?: string, getBaseline?: (slug: string) => Promise<string>, plans?: PlanDeps, log?: typeof api.log, sink?: string}} [p]
 * @returns {Promise<{summary: string, closed: string[], held: string[], notes: string[]}>}
 */
export async function sweepFromBaseline({ repo = 'workspace', getBaseline = api.planGet, plans, log = api.log, sink } = {}) {
  /** @type {import('./baseline.js').Baseline|null} */
  let baseline = null;
  try {
    baseline = parseBaseline(await getBaseline(baselineSlug(repo)));
  } catch {
    baseline = null; // unreachable reads as absent — quiet, retried next tick
  }
  if (!baseline) {
    return { summary: 'skipped (no readable baseline — nothing to judge against; retries next tick)', closed: [], held: [], notes: [] };
  }
  const covered = new Set(Object.values(baseline.suites || {}).flatMap((s) => s.cases || []));
  if (!covered.size) {
    return { summary: 'skipped (baseline holds no covered case IDs)', closed: [], held: [], notes: [] };
  }
  const out = await sweepClosures({ repo, covered, plans, log, sink });
  const parts = [
    out.closed.length ? `closed ${out.closed.join(', ')}` : 'closed 0',
    out.held.length ? `held ${out.held.join(', ')}` : 'held 0',
  ];
  return { summary: `${parts.join(', ')} (judged against ${covered.size} baseline-covered case ID(s))`, ...out };
}
