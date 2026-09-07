// Stale-status sweep — the scripted closer for dangling non-terminal log lines,
// run by `ws pull` right after the PR watch (zero tokens). A scripted log writer
// (CLAUDE.md "Logging convention" roster; detail: SYSTEM.md "Stale-status sweep").
//
// WHY THIS EXISTS: `ws query --summary` reports the newest line per (repo, area)
// — that IS the CEO's status board. pr-watch closes only the `pr-<n>` areas it
// opened; an implementer logs its own `PR-open` under a BRANCH-name area
// (`feat/…`, `tests`, `test/…`) and nothing ever closed that area, and `blocked`
// had no scripted closer at all. On 2026-08-01 nine finished ho-nexus items sat
// on the board as open — a board that shows finished work as open decays into
// noise, and a noisy board is one the CEO stops reading.
//
// WHAT COUNTS AS EVIDENCE (per status — never elapsed time, never inference):
//   PR-open          → EVERY PR the message cites (`PR #<n>`, or a
//                      `/<repo>/pull/<n>` URL of the entry's own repo) is merged
//                      or closed on GitHub. pr-watch's own lines are exempt — it
//                      owns the `pr-<n>` lifecycle and its open lines are live.
//   blocked          → EVERY test-plan slug the message cites (`test[- ]plan
//                      <slug>`) is now done/archived in the DB. A merged PR cited
//                      by a blocked line is NOT proof the blocker cleared.
//   deployed-staging → no sound "production deployed exactly this" signal exists,
//                      so these are ALWAYS left, with an explicit reason.
// Evidence is conjunctive: one open citation holds the whole line. Missing,
// ambiguous, or unfetchable evidence (gh/log-API/plan-API failure) leaves the
// line — prefer stale noise over a lost signal, every time.
//
// IDEMPOTENT BY CONSTRUCTION (the planclose TP-planclose-033 lesson, one module
// over): a resolution is a terminal `done` line in the same area, so it becomes
// the area's newest line and the next sweep never selects the area again. No
// state file, no dedupe ledger — the log itself is the state, shared by every
// environment that ticks. And like pr-watch's catch-up reconciler, history is
// never back-logged: an entry that is no longer the newest line for its area is
// silently skipped (nothing is dangling there).
//
// Never throws, never fails the pull; a whole-sweep failure degrades to a
// summary string. No calendar dates are computed here: the log API server stamps
// every entry (clock.js rule satisfied by construction).
import { execFileSync } from 'node:child_process';
import * as api from './apiclient.js';
import { WATCH_AGENT } from './prwatch.js';

export const SWEEP_AGENT = 'status-sweep';
/** Newest lines considered per status (same window discipline as prwatch). */
const QUERY_LIMIT = 500;
/** The non-terminal statuses a newest-line-per-area can dangle in. */
const STALE_STATUSES = /** @type {const} */ (['PR-open', 'blocked', 'deployed-staging']);
/** Plan statuses that count as "this plan is finished". */
const TERMINAL_PLAN = new Set(['done', 'archived']);

/** @typedef {{id: number, repo: string, area: string, status: string, agent: string|null, message?: string}} LogEntry */
/** @typedef {{repo: string, area: string, id: number, status: string, action: 'resolve'|'leave', reason: string}} Decision */

/**
 * @param {string[]} args
 * @returns {string} stdout
 */
function ghExec(args) {
  return execFileSync('gh', args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 60000,
  });
}

/** @param {string} s */
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * One /log read (same contract as prwatch's: an envelope without `entries` throws
 * so incomplete data is never read as "nothing there").
 * @param {typeof api.query} query @param {Record<string, string|number>} params
 * @returns {Promise<LogEntry[]>}
 */
async function fetchLog(query, params) {
  const text = await query({ endpoint: '/log', params: { ...params, format: 'json' } });
  const { entries } = /** @type {{entries: LogEntry[]}} */ (JSON.parse(text));
  if (!Array.isArray(entries)) throw new Error('log API response has no entries array');
  return entries;
}

/**
 * PR numbers a message cites as its own repo's: `PR #<n>` / `PR#<n>` (bare
 * citations read as the entry's own repo, prwatch's textCitesPR reading), or a
 * repo-scoped `/<repo>/pull/<n>` URL. Foreign repos' URLs never count.
 * @param {string} message @param {string} repo
 * @returns {number[]}
 */
export function citedPRs(message, repo) {
  /** @type {Set<number>} */
  const nums = new Set();
  for (const [, n] of message.matchAll(/\bPR\s*#(\d+)(?![0-9])/gi)) nums.add(Number(n));
  for (const [, n] of message.matchAll(new RegExp(`/${escapeRe(repo)}/pull/(\\d+)(?![0-9])`, 'gi'))) {
    nums.add(Number(n));
  }
  return [...nums].sort((a, b) => a - b);
}

/**
 * Test-plan slugs a message cites: `test-plan <slug>` / `test plan <slug>`.
 * A captured token that is not a real plan slug resolves nothing — the caller
 * looks it up in the plan index and leaves the line when it is unknown.
 * @param {string} message
 * @returns {string[]}
 */
export function citedPlanSlugs(message) {
  /** @type {Set<string>} */
  const slugs = new Set();
  for (const [, slug] of message.matchAll(/\btest[- ]plan\s+([A-Za-z0-9][A-Za-z0-9-]{2,})/gi)) {
    slugs.add(slug.replace(/-+$/, ''));
  }
  return [...slugs];
}

/**
 * Is this entry still the newest line for its (repo, area)? The same rule
 * /summary's "attention" list uses — a later line in the area resolves it.
 * @param {typeof api.query} query @param {LogEntry} entry
 */
async function isLatestInArea(query, entry) {
  const rows = await fetchLog(query, { repo: entry.repo, area: entry.area, limit: 1 });
  return rows.length > 0 && rows[rows.length - 1].id === entry.id;
}

/**
 * One sweep: find (repo, area) pairs whose newest line is non-terminal and whose
 * work is PROVABLY finished, resolve each with one `done` line, leave everything
 * else with a reason. Returns a one-line summary for the `ws pull` diagnostic
 * output plus the per-line decisions (the dry-run tool prints them); NEVER throws.
 * @param {{gh?: (args: string[]) => string, query?: typeof api.query, log?: typeof api.log, planList?: typeof api.planList, dryRun?: boolean}} [deps]
 * @returns {Promise<{summary: string, decisions: Decision[]}>}
 */
export async function sweepStaleStatus({
  gh = ghExec,
  query = api.query,
  log = api.log,
  planList = api.planList,
  dryRun = false,
} = {}) {
  /** @type {LogEntry[]} */
  const entries = [];
  try {
    for (const status of STALE_STATUSES) {
      entries.push(...await fetchLog(query, { status, limit: QUERY_LIMIT }));
    }
  } catch {
    return { summary: 'skipped (log API query failed)', decisions: [] };
  }
  // Newest fetched line per (repo, area). Older same-area lines are already
  // resolved by definition; the is-latest check below re-verifies against the
  // FULL log (a newer done/failed line outside this fetch also resolves).
  /** @type {Map<string, LogEntry>} */
  const byArea = new Map();
  for (const e of entries) {
    const key = `${e.repo}\u0000${e.area}`;
    const prev = byArea.get(key);
    if (!prev || e.id > prev.id) byArea.set(key, e);
  }

  // Lazy shared resources — fetched at most once per sweep, and only when a
  // candidate actually needs them. A failure poisons only its own evidence path
  // (those lines are left), never the other path and never the sweep.
  /** @type {Map<string, string>|null|undefined} repo → nameWithOwner; null = failed */
  let repos;
  const repoMap = () => {
    if (repos !== undefined) return repos;
    try {
      const rows = /** @type {{nameWithOwner: string}[]} */ (
        JSON.parse(gh(['repo', 'list', '--no-archived', '--limit', '100', '--json', 'nameWithOwner']))
      );
      repos = new Map(rows.map((r) => [r.nameWithOwner.split('/')[1], r.nameWithOwner]));
    } catch {
      repos = null;
    }
    return repos;
  };
  /** @type {Map<string, string>|null|undefined} slug → status; null = failed */
  let planStatuses;
  const planIndex = async () => {
    if (planStatuses !== undefined) return planStatuses;
    try {
      const text = await planList({ format: 'json' });
      const rows = /** @type {{plans?: Array<{slug: string, status: string}>}} */ (JSON.parse(text)).plans || [];
      planStatuses = new Map(rows.map((p) => [p.slug, p.status]));
    } catch {
      planStatuses = null;
    }
    return planStatuses;
  };
  /** @type {Map<string, string|null>} `${repo}#${n}` → state; null = view failed */
  const prStates = new Map();
  /** @param {string} nameWithOwner @param {string} repo @param {number} n */
  const prState = (nameWithOwner, repo, n) => {
    const key = `${repo}#${n}`;
    if (!prStates.has(key)) {
      try {
        const view = /** @type {{state?: string}} */ (
          JSON.parse(gh(['pr', 'view', String(n), '-R', nameWithOwner, '--json', 'state']))
        );
        prStates.set(key, view.state || null);
      } catch {
        prStates.set(key, null);
      }
    }
    return prStates.get(key) ?? null;
  };

  /** @type {Decision[]} */
  const decisions = [];
  /** @type {Array<{entry: LogEntry, message: string}>} */
  const resolutions = [];
  /** @param {LogEntry} e @param {string} reason */
  const leave = (e, reason) =>
    decisions.push({ repo: e.repo, area: e.area, id: e.id, status: e.status, action: 'leave', reason });

  for (const e of [...byArea.values()].sort((a, b) => a.id - b.id)) {
    try {
      if (!(await isLatestInArea(query, e))) continue; // not dangling — silent, never back-logged
    } catch {
      leave(e, 'log API is-latest check failed — evidence unavailable');
      continue;
    }
    if (e.status === 'deployed-staging') {
      leave(e, 'deployed-staging has no sound production-deploy signal — deliberately left');
      continue;
    }
    if (e.status === 'PR-open') {
      if (e.agent === WATCH_AGENT) {
        leave(e, `pr-watch owns the pr-<n> lifecycle — its open line is a live signal`);
        continue;
      }
      const nums = citedPRs(e.message || '', e.repo);
      if (!nums.length) {
        leave(e, 'no PR citation in the message — no evidence');
        continue;
      }
      const map = repoMap();
      const nameWithOwner = map?.get(e.repo);
      if (!nameWithOwner) {
        leave(e, map === null ? 'gh repo list failed — evidence unavailable' : `repo ${e.repo} not on the GitHub roster — evidence unavailable`);
        continue;
      }
      const states = nums.map((n) => ({ n, state: prState(nameWithOwner, e.repo, n) }));
      const unfetched = states.filter((s) => s.state === null);
      if (unfetched.length) {
        leave(e, `gh pr view failed for PR #${unfetched.map((s) => s.n).join(', #')} — evidence unavailable`);
        continue;
      }
      const open = states.filter((s) => s.state === 'OPEN');
      if (open.length) {
        leave(e, `PR #${open.map((s) => s.n).join(', #')} still open — live signal`);
        continue;
      }
      const outcome = states
        .map((s) => `PR #${s.n} ${s.state === 'MERGED' ? 'merged' : 'closed without merge'}`)
        .join(', ');
      resolutions.push({ entry: e, message: `${outcome} — stale PR-open line resolved (status sweep: every PR this line cites is finished on GitHub)` });
      continue;
    }
    // blocked — resolves only on cited-plan evidence.
    const slugs = citedPlanSlugs(e.message || '');
    if (!slugs.length) {
      leave(e, 'no test-plan citation in the message — no evidence');
      continue;
    }
    const index = await planIndex();
    if (index === null) {
      leave(e, 'plan API list failed — evidence unavailable');
      continue;
    }
    const unknown = slugs.filter((s) => !index.has(s));
    if (unknown.length) {
      leave(e, `cited plan(s) not found: ${unknown.join(', ')} — no evidence`);
      continue;
    }
    const active = slugs.filter((s) => !TERMINAL_PLAN.has(index.get(s) || ''));
    if (active.length) {
      leave(e, `test-plan ${active.join(', ')} still active — live signal`);
      continue;
    }
    const outcome = slugs.map((s) => `test-plan ${s} now ${index.get(s)}`).join(', ');
    resolutions.push({ entry: e, message: `${outcome} — stale blocked line resolved (status sweep: every plan this line cites is closed in the DB)` });
  }

  let resolved = 0;
  if (!dryRun) {
    for (const { entry, message } of resolutions) {
      try {
        await log({ repo: entry.repo, area: entry.area, status: 'done', message, agent: SWEEP_AGENT });
        decisions.push({ repo: entry.repo, area: entry.area, id: entry.id, status: entry.status, action: 'resolve', reason: message });
        resolved++;
      } catch {
        leave(entry, 'resolution write failed — will retry next sweep');
      }
    }
  } else {
    for (const { entry, message } of resolutions) {
      decisions.push({ repo: entry.repo, area: entry.area, id: entry.id, status: entry.status, action: 'resolve', reason: message });
      resolved++;
    }
  }
  const left = decisions.filter((d) => d.action === 'leave').length;
  const label = dryRun ? 'dry-run: would resolve' : 'resolved';
  return {
    summary: `${label} ${resolved} stale line(s)${resolved ? ` (${resolutions.map((r) => `${r.entry.repo}/${r.entry.area}`).join(', ')})` : ''}, left ${left} alone`,
    decisions,
  };
}
