// PR watch — the deterministic PR-state logger run by `ws pull` (zero tokens).
// The ONE scripted writer to the central log (CLAUDE.md "Logging convention"
// carve-out, Hector 2026-07-21): open PRs across all of the authenticated user's
// non-archived repos (gh repo list — the live container has no sibling project
// clones, so local enumeration would be a no-op there) are transition-logged:
//   PR newly open            → one `PR-open` line (Dependabot PRs tagged)
//   watched PR merged/closed → one `done` line
//   PR the watcher NEVER saw open (opened and closed inside one tick gap, or
//                              during a watch outage) → catch-up reconciliation:
//                              see reconcileMissedPRs below
//   PR merged                → matching active test-plans (kind test-plan, same
//                              repo, PR referenced in slug or body) are set
//                              status=done via the plan API + one `done` audit
//                              line each — UNLESS the plan body has open
//                              follow-ups (see hasOpenFollowUps below: unchecked
//                              `- [ ]`, a populated Follow-ups/Pending heading,
//                              or an unperformed manual/deferred test case):
//                              then it stays active and ONE `blocked` line
//                              flags it for the CEO.
//                              A close that CANNOT happen (plan list/set API
//                              failure after the merge line landed — never
//                              retried, the PR is now seen) writes ONE `failed`
//                              line instead of stranding the plan silently
//                              (backlog 48b).
//                              Closed-without-merge never touches plans.
// Lines carry repo=<repo>, area=pr-<n>, agent=pr-watch, so /summary's
// latest-line-per-(repo,area) "attention" logic resolves them naturally.
//
// Dedupe is central-log-based (NOT a state file): both environments run the pull
// tick, and the shared log is the only state both can see. A PR is "known open"
// iff its newest watcher PR-open line is newer than its newest watcher done line.
//
// Never throws, never fails the pull; any inconsistency (gh offline, partial
// listings, API unreachable) skips the whole sweep — a false "closed" line is
// worse than a 15-minute delay. No calendar dates are computed here: the log API
// server stamps every entry (clock.js rule satisfied by construction).
import { execFileSync } from 'node:child_process';
import * as api from './apiclient.js';
import { audit } from './audit.js';
import { CASE_ID_SOURCE } from './baseline.js';
import { ceoName, ceoPattern } from './ceo.js';

export const WATCH_AGENT = 'pr-watch';
const AREA_RE = /^pr-(\d+)$/;
const QUERY_LIMIT = 500; // newest watcher lines considered; see the test plan
const PLAN_EXCLUDE = 'done,archived'; // terminal statuses are never close candidates
// Recently-closed PRs reconciled per repo per sweep (catch-up window). A 15-minute
// sweep cadence cannot see a PR that opens and merges between two ticks — ho-nexus
// PR #16 lived 2m37s on 2026-07-26 — so every sweep also looks back over closed PRs.
const CLOSED_LOOKBACK = 20;

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

/** @typedef {{repo: string, nameWithOwner: string, number: number, title: string, author: string, dependabot: boolean, url: string}} OpenPR */
/** @typedef {{id: number, repo: string, area: string, status: string, agent: string|null, message?: string}} LogEntry */

/**
 * @param {(args: string[]) => string} gh
 * @returns {Map<string, string>} repo name → nameWithOwner
 */
function listRepos(gh) {
  const rows = /** @type {{nameWithOwner: string}[]} */ (
    JSON.parse(gh(['repo', 'list', '--no-archived', '--limit', '100', '--json', 'nameWithOwner']))
  );
  return new Map(rows.map((r) => [r.nameWithOwner.split('/')[1], r.nameWithOwner]));
}

/**
 * @param {(args: string[]) => string} gh
 * @param {Map<string, string>} repos
 * @returns {Map<string, OpenPR>} `${repo}#${number}` → PR
 */
function listOpenPRs(gh, repos) {
  /** @type {Map<string, OpenPR>} */
  const open = new Map();
  for (const [repo, nameWithOwner] of repos) {
    const rows = /** @type {{number: number, title: string, url: string, author?: {login?: string}}[]} */ (
      JSON.parse(gh(['pr', 'list', '-R', nameWithOwner, '--state', 'open', '--json', 'number,title,author,url']))
    );
    for (const pr of rows) {
      const author = pr.author?.login || 'unknown';
      open.set(`${repo}#${pr.number}`, {
        repo,
        nameWithOwner,
        number: pr.number,
        title: pr.title,
        author,
        dependabot: /dependabot/i.test(author),
        url: pr.url,
      });
    }
  }
  return open;
}

/** @typedef {{repo: string, nameWithOwner: string, number: number, title: string, state: string, url: string}} ClosedPR */

/**
 * Recently closed PRs (merged or closed-without-merge) per repo — the catch-up
 * window that lets a sweep notice PRs it never saw open. `--state closed` covers
 * merged PRs too; the per-row `state` field distinguishes them, so no extra
 * `gh pr view` call is needed here.
 * @param {(args: string[]) => string} gh
 * @param {Map<string, string>} repos
 * @returns {Map<string, ClosedPR>} `${repo}#${number}` → PR
 */
function listClosedPRs(gh, repos) {
  /** @type {Map<string, ClosedPR>} */
  const closed = new Map();
  for (const [repo, nameWithOwner] of repos) {
    const rows = /** @type {{number: number, title: string, url: string, state?: string}[]} */ (
      JSON.parse(gh(['pr', 'list', '-R', nameWithOwner, '--state', 'closed',
        '--limit', String(CLOSED_LOOKBACK), '--json', 'number,title,state,url']))
    );
    for (const pr of rows) {
      closed.set(`${repo}#${pr.number}`, {
        repo,
        nameWithOwner,
        number: pr.number,
        title: pr.title,
        state: pr.state || 'CLOSED',
        url: pr.url,
      });
    }
  }
  return closed;
}

/**
 * One /log read. Throws (→ the caller skips the whole sweep) when the response
 * carries no `entries` array: incomplete data must never be read as "nothing
 * there", which would fake closures.
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
 * Watcher state from the central log:
 *  - `open`: `${repo}#${number}` of every PR whose newest watcher PR-open line is
 *            newer than its newest watcher done line.
 *  - `seen`: every PR the watcher has EVER written a `pr-<n>` line for. A PR absent
 *            from `seen` is one the watcher never observed — the catch-up candidate.
 *  - `prOpen`: every PR-open line (any agent, any area) — the raw material for
 *            finding dangling PR-open lines an implementer wrote by hand.
 * @param {typeof api.query} query
 */
async function watcherState(query) {
  const openEntries = await fetchLog(query, { status: 'PR-open', limit: QUERY_LIMIT });
  const doneEntries = await fetchLog(query, { status: 'done', limit: QUERY_LIMIT });
  /** @param {LogEntry[]} entries */
  const newestWatcher = (entries) => {
    /** @type {Map<string, number>} */
    const newest = new Map();
    for (const e of entries) {
      const m = e.agent === WATCH_AGENT ? AREA_RE.exec(e.area) : null;
      if (!m) continue;
      const key = `${e.repo}#${m[1]}`;
      newest.set(key, Math.max(newest.get(key) ?? 0, e.id));
    }
    return newest;
  };
  const opened = newestWatcher(openEntries);
  const closed = newestWatcher(doneEntries);
  return {
    open: new Set([...opened].filter(([key, id]) => id > (closed.get(key) ?? 0)).map(([key]) => key)),
    seen: new Set([...opened.keys(), ...closed.keys()]),
    prOpen: openEntries,
  };
}

// --- Open follow-up detection (rules derived 2026-07-25 from the 12 real plan
// bodies audited in `ws plan get test-plan-prwatch-manual-case-hold`) ---
//
// A test-plan case is "executed" when its text carries past-tense evidence:
const EVIDENCE_WORDS = 'verified|executed|performed|checked|confirmed|completed|covered';
// Judgement words are a separate, stricter class. A deferred case that was
// waiting on a JUDGEMENT completes by being judged — there is nothing to
// perform — but bare past tense is NOT enough evidence: "the CEO decided to
// postpone until Phase 7" and "until the CEO has decided on pricing" are
// natural phrasings for a case that is still open, and adding answered|decided
// to EVIDENCE_WORDS made exactly those shapes auto-close (audit H1, 2026-08-01,
// reproduced — worst case an UNPERFORMED manual case closed via "once the CEO
// has answered…"). A judgement therefore counts only when DATE-STAMPED
// ("answered NO 2026-08-01"), the same deliberate act the backlog's
// RESOLVED-YYYY-MM-DD convention asks for, and pending phrasings — future forms
// and conditional perfects ("will be decided", "once/until … has answered") —
// are stripped first so not even a date can make them count.
const JUDGEMENT_WORDS = 'answered|decided';
const PENDING_JUDGEMENT_RE = new RegExp(
  `\\b(?:(?:to|will|would|should|must|needs?(?:\\s+to)?)\\s+be|(?:once|until|after|when|before|unless)\\b[^|\\n]{0,60}?\\b(?:has|have|is|are))\\s+(?:${JUDGEMENT_WORDS})\\b`,
  'gi');
const JUDGED_RE = new RegExp(`\\b(?:${JUDGEMENT_WORDS})\\b[^|\\n]{0,40}?\\b\\d{4}-\\d{2}-\\d{2}\\b`, 'i');
const EVIDENCE_RE = new RegExp(`\\b(?:${EVIDENCE_WORDS})\\b`, 'i');
// …but future phrasing ("To be performed by Hector") is a pending item, not
// evidence — strip those constructions before testing.
const FUTURE_EVIDENCE_RE = new RegExp(
  `\\b(?:to|will|should|must|cannot|can't|won't|needs?(?:\\s+to)?)\\s+be\\s+(?:${EVIDENCE_WORDS})\\b`, 'gi');
// A deferred-only case holds the plan only when it names a human actor
// (the CEO's pending action); deferred-to-a-system-event auto-resolves.
const humanRe = () => new RegExp(`\\b(?:${ceoPattern()})\\b`, 'i');
const HEADING_RE = /^#{1,6}\s/;
const BULLET_RE = /^\s*[-*]\s/;
// Coverage markers must LEAD a table row's last cell ("automated (…); behavior
// manual per TP-x" is a cross-reference, not a manual case).
const CELL_MARKER_RE = /^[*_\s]*(manual|deferred)\b/i;

/** @param {string} unit one case unit's full text */
const isExecuted = (unit) => {
  const noFuture = unit.replace(FUTURE_EVIDENCE_RE, '');
  return EVIDENCE_RE.test(noFuture) || JUDGED_RE.test(noFuture.replace(PENDING_JUDGEMENT_RE, ''));
};

/**
 * @param {string} unit
 * @param {{manual: boolean, deferred: boolean}} flags
 */
function unitHolds(unit, { manual, deferred }) {
  if (isExecuted(unit)) return false;
  return manual || (deferred && humanRe().test(unit));
}

/**
 * Unperformed manual/deferred test cases — the real-world hold pattern (all 5
 * plans held by the 2026-07-25 devops sweep matched this and nothing else).
 * Case units: a markdown table row whose LAST cell leads with manual/deferred,
 * or a bullet whose first line has a parenthetical containing manual/deferred
 * plus its wrapped continuation lines (until blank/heading/bullet/table row).
 * Prose and headings mentioning "manual" never hold.
 *
 * Returns the units themselves, not just a boolean, because the CEO block
 * (util/planclose.js) has to NAME what is holding a plan — "2 things need you"
 * is only actionable if it can say which two. One classifier owns "is this case
 * unperformed"; a second copy would drift and the pinned block would then
 * disagree with the hold that produced it.
 * @param {string} body
 * @returns {Array<{id: string, text: string}>} in body order; id '' when the unit names none
 */
export function unperformedCases(body) {
  const caseId = new RegExp(CASE_ID_SOURCE);
  /** @param {string} unit */
  const idOf = (unit) => (caseId.exec(unit) || [''])[0];
  /** @type {Array<{id: string, text: string}>} */
  const found = [];
  const lines = body.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (trimmed.startsWith('|')) {
      const cells = trimmed.split('|').map((c) => c.trim()).filter(Boolean);
      const cover = cells[cells.length - 1] || '';
      const lead = CELL_MARKER_RE.exec(cover);
      if (!lead) continue;
      const flags = {
        manual: /\bmanual\b/i.test(cover),
        deferred: /\bdeferred\b/i.test(cover),
      };
      if (unitHolds(trimmed, flags)) found.push({ id: idOf(trimmed), text: trimmed });
      continue;
    }
    if (!BULLET_RE.test(lines[i])) continue;
    let manual = false;
    let deferred = false;
    for (const [, inner] of lines[i].matchAll(/\(([^)]*)\)/g)) {
      if (/\bmanual\b/i.test(inner)) manual = true;
      if (/\bdeferred\b/i.test(inner)) deferred = true;
    }
    if (!manual && !deferred) continue;
    let unit = lines[i];
    let j = i + 1;
    for (; j < lines.length; j++) {
      const cont = lines[j];
      const t = cont.trim();
      if (!t || HEADING_RE.test(t) || BULLET_RE.test(cont) || t.startsWith('|')) break;
      unit += `\n${cont}`;
    }
    if (unitHolds(unit, { manual, deferred })) found.push({ id: idOf(unit), text: unit });
    i = j - 1; // continuation lines already consumed
  }
  return found;
}

/**
 * Open follow-up detection — the guard that keeps a test-plan alive past its
 * PR's merge. True when the body has an unchecked task checkbox, a
 * Follow-ups / Follow ups / Followup / Pending markdown heading with non-blank
 * content before the next heading (an empty section does not block), or an
 * unperformed manual/deferred test case (see unperformedCases).
 * @param {string} body
 */
export function hasOpenFollowUps(body) {
  if (/^\s*[-*]\s*\[ \]/m.test(body)) return true;
  const lines = body.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    if (!/^#{1,6}\s*(follow[\s-]?ups?|pending)\b/i.test(lines[i])) continue;
    for (let j = i + 1; j < lines.length; j++) {
      if (/^#{1,6}\s/.test(lines[j])) break;
      if (lines[j].trim()) return true;
    }
  }
  return unperformedCases(body).length > 0;
}

/** @param {string} s */
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Does free text cite PR <number> of <repo>? `PR #<n>` / `PR#<n>`, or a repo-scoped
 * `/<repo>/pull/<n>` URL (foreign repos' PR URLs never match — cross-repo citations
 * must not close plans or resolve log lines).
 * @param {string} text @param {string} repo @param {number} number
 */
function textCitesPR(text, repo, number) {
  if (new RegExp(`\\bPR\\s*#${number}(?![0-9])`, 'i').test(text)) return true;
  if (new RegExp(`/${escapeRe(repo)}/pull/${number}(?![0-9])`, 'i').test(text)) return true;
  return false;
}

/**
 * Does this plan reference PR <number> of <repo>? Slug: a `pr-<n>` segment;
 * body: any citation textCitesPR recognises.
 * @param {{slug: string, body: string, repo: string, number: number}} p
 */
function referencesPR({ slug, body, repo, number }) {
  if (new RegExp(`(?:^|-)pr-?${number}(?:-|$)`).test(slug)) return true;
  return textCitesPR(body, repo, number);
}

/** @typedef {{list: typeof api.planList, get: typeof api.planGet, set: typeof api.planSet}} PlanDeps */

/**
 * Active (non-terminal) test-plans of <repo> that reference PR <number>, with bodies.
 * Shared by the merge path and the catch-up reconciler so both agree on what a
 * plan reference means. Never throws: a failed list sets `failed`, a failed get
 * degrades to a note.
 * @param {{repo: string, number: number, plans: PlanDeps}} p
 * @returns {Promise<{failed: boolean, matches: Array<{slug: string, body: string}>, notes: string[]}>}
 */
async function plansForPR({ repo, number, plans }) {
  /** @type {Array<{slug: string, repo: string|null}>} */
  let rows;
  try {
    const text = await plans.list({ kind: 'test-plan', exclude: PLAN_EXCLUDE, format: 'json' });
    rows = /** @type {{plans?: Array<{slug: string, repo: string|null}>}} */ (JSON.parse(text)).plans || [];
  } catch {
    return { failed: true, matches: [], notes: [] };
  }
  /** @type {Array<{slug: string, body: string}>} */
  const matches = [];
  /** @type {string[]} */
  const notes = [];
  for (const row of rows) {
    if ((row.repo || 'workspace') !== repo) continue;
    /** @type {string} */
    let body;
    try {
      body = await plans.get(row.slug);
    } catch {
      notes.push(`test-plan ${row.slug} skipped (plan get failed)`);
      continue;
    }
    if (!referencesPR({ slug: row.slug, body, repo, number })) continue;
    matches.push({ slug: row.slug, body });
  }
  return { failed: false, matches, notes };
}

/**
 * Close test-plans that were HELD when their PR merged and have since been released.
 *
 * WHY THIS EXISTS (found live 2026-08-01): `closeTestPlans` runs on the merge
 * TRANSITION. A plan holding open follow-ups at that moment gets a `blocked` line
 * and is never revisited — the transition has already fired, so no later sweep
 * looks at it again. When the CEO then performs the manual case or answers the
 * question, the hold releases and the plan sits `active` forever with nothing left
 * to close it. Two plans reached that state the day the machinery shipped.
 *
 * This is the same shape as the main-direct gap `plan-close` was built for: work
 * that is genuinely finished, with no surviving trigger. Runs every sweep over the
 * recently-closed PR window, so it is cheap and self-healing, and closes nothing a
 * merge would not have closed — `hasOpenFollowUps` is still the gate.
 * @param {{closed: Map<string, ClosedPR>, plans: PlanDeps, log: typeof api.log, query?: typeof api.query}} p
 * @returns {Promise<string[]>}
 */
export async function resweepReleasedHolds({ closed, plans, log, query = api.query }) {
  /** @type {string[]} */
  const notes = [];
  const merged = [...closed.values()].filter((p) => p.state === 'MERGED');
  if (!merged.length) return notes;
  // ONE plan list per sweep, then per-ACTIVE-plan matching — never per merged PR.
  // The first version called plansForPR once per merged PR, and the closed-PR
  // window never empties (hub's last-20 stays saturated), so every 15-min
  // tick on every station paid ~24 identical list calls forever with nothing to
  // do (audit M3, 2026-08-01, measured). Steady state — zero active test-plans —
  // is now exactly one list call. Inverting the loop also removes the need for
  // a per-sweep dedupe set: each plan is visited once.
  /** @type {Array<{slug: string, repo: string|null}>} */
  let rows;
  try {
    const text = await plans.list({ kind: 'test-plan', exclude: PLAN_EXCLUDE, format: 'json' });
    rows = /** @type {{plans?: Array<{slug: string, repo: string|null}>}} */ (JSON.parse(text)).plans || [];
  } catch {
    return notes; // transient list failure — next sweep retries
  }
  for (const row of rows) {
    const repo = row.repo || 'workspace';
    /** @type {string} */
    let body;
    try {
      body = await plans.get(row.slug);
    } catch {
      continue;
    }
    if (hasOpenFollowUps(body)) continue; // still genuinely held — the gate is unchanged
    // ANCHOR SELECTION (two defects, both live 2026-08-02). `referencesPR` cannot
    // tell ownership from CONTEXT ("Builds on PR #33" closed a plan whose own PR
    // was still open), and a body that never cites its own PR at all cannot be a
    // way in either (three plans stranded exactly so). Ownership therefore comes
    // from PRIOR DECLARATIONS in the log, never from body prose:
    //   1. the `blocked` flag closeTestPlans wrote at merge (plan held there), or
    //   2. an implementer's PR-open line citing BOTH this slug and the PR
    //      ("… PR #<n>, test plan <slug>") — the missed-merge-close recovery.
    // Body citations only NOMINATE candidates for path 1; path 2 needs no body
    // citation at all. Any fetch failure skips — doubt never closes.
    /** @type {ClosedPR|null} */
    let pr = null;
    let anchored = false;
    try {
      const refCands = merged.filter((p) => p.repo === repo
        && referencesPR({ slug: row.slug, body, repo: p.repo, number: p.number }));
      for (const cand of refCands) {
        const held = await fetchLog(query, { area: `pr-${cand.number}`, status: 'blocked', limit: 50 });
        if (held.some((e) => e.agent === WATCH_AGENT && e.repo === repo
          && typeof e.message === 'string' && e.message.includes(row.slug))) {
          pr = cand; anchored = true; break;
        }
      }
      if (!pr) {
        const opened = await fetchLog(query, { status: 'PR-open', q: row.slug, limit: 50 });
        for (const cand of merged) {
          if (cand.repo !== repo) continue;
          if (opened.some((e) => e.repo === repo && typeof e.message === 'string'
            && e.message.includes(row.slug) && textCitesPR(e.message, repo, cand.number))) {
            pr = cand; anchored = true; break;
          }
        }
      }
      if (!pr) {
        if (refCands.length) {
          notes.push(`${row.slug} cites merged PR #${refCands[0].number} but was never flagged held nor declared its owner — left alone`);
        }
        continue;
      }
    } catch {
      notes.push(`${row.slug} hold-evidence fetch failed — left alone (never close on doubt)`);
      continue;
    }
    try {
      await plans.set(row.slug, { status: 'done', agent: WATCH_AGENT });
    } catch {
      notes.push(`test-plan ${row.slug} re-sweep close FAILED (plan API set failed)`);
      continue;
    }
    await audit({
      repo,
      area: `pr-${pr.number}`,
      status: 'done',
      message: `test-plan ${row.slug} closed (status done) — held at PR #${pr.number} merge, hold since released`,
      agent: WATCH_AGENT,
    }, { log });
    notes.push(`test-plan ${row.slug} closed (released hold)`);
  }
  return notes;
}

/**
 * Script-enforced test-plan closure for one merged PR (requirement: the script,
 * never an agent, closes plans on merge). Every failure degrades to a summary
 * note — never throws past the sweep. Returns summary tokens.
 *
 * Every audit write here goes through util/audit.js (backlog 42): each one
 * follows a state change that will NEVER be retried (the PR is now "seen", the
 * plan is already `done`), so a failing `log()` used to close a plan with no
 * line at all and abort the rest of the sweep with a generic "interrupted".
 * audit() makes that failure loud and durable, and never throws back.
 * @param {{repo: string, number: number, plans: PlanDeps, log: typeof api.log}} p
 * @returns {Promise<string[]>}
 */
async function closeTestPlans({ repo, number, plans, log }) {
  const found = await plansForPR({ repo, number, plans });
  if (found.failed) {
    // The merge line already landed, so this PR is "seen" and the sweep never
    // retries — without a line, a stranded plan looks identical to a missed one
    // (backlog 48b). api.log itself falls back to the offline md when the API is
    // the thing that is down, so the evidence is durable either way.
    await audit({
      repo,
      area: `pr-${number}`,
      status: 'failed',
      message: `test-plan sweep for merged PR #${number} could not run (plan API list failed) — test-plans referencing it may be left active with no closure`,
      agent: WATCH_AGENT,
    }, { log });
    return [`test-plan sweep skipped for pr-${number} (plan API list failed)`];
  }
  /** @type {string[]} */
  const notes = [...found.notes];
  for (const { slug, body } of found.matches) {
    const row = { slug };
    if (hasOpenFollowUps(body)) {
      await audit({
        repo,
        area: `pr-${number}`,
        status: 'blocked',
        message: `test-plan ${row.slug} left active after PR #${number} merge — open follow-ups / unperformed manual cases need ${ceoName()}'s review`,
        agent: WATCH_AGENT,
      }, { log });
      notes.push(`test-plan ${row.slug} flagged (open follow-ups)`);
      continue;
    }
    try {
      await plans.set(row.slug, { status: 'done', agent: WATCH_AGENT });
    } catch {
      // Same stranding risk as the list failure above: no retry ever comes, so the
      // failure must be a log line, not just a pull-diagnostic note (backlog 48b).
      await audit({
        repo,
        area: `pr-${number}`,
        status: 'failed',
        message: `test-plan ${row.slug} close FAILED (plan API set failed) — left active after PR #${number} merge with no closure line`,
        agent: WATCH_AGENT,
      }, { log });
      notes.push(`test-plan ${row.slug} close FAILED (plan API set failed)`);
      continue;
    }
    await audit({
      repo,
      area: `pr-${number}`,
      status: 'done',
      message: `test-plan ${row.slug} closed (status done) — PR #${number} merged`,
      agent: WATCH_AGENT,
    }, { log });
    notes.push(`test-plan ${row.slug} closed`);
  }
  return notes;
}

/**
 * Is this log entry still the newest line for its (repo, area)? A later line in the
 * same area resolves it — the same rule /summary's "attention" list uses.
 * @param {typeof api.query} query @param {LogEntry} entry
 */
async function isLatestInArea(query, entry) {
  const rows = await fetchLog(query, { repo: entry.repo, area: entry.area, limit: 1 });
  return rows.length > 0 && rows[rows.length - 1].id === entry.id;
}

/**
 * Catch-up reconciliation — the self-healing half of the watcher.
 *
 * A 15-minute poll cannot observe a PR that opens and merges between two ticks
 * (ho-nexus PR #16, 2026-07-26, was open 2m37s), and knownOpen-based closure
 * detection only ever fires for PRs the watcher itself logged open. Such a PR was
 * invisible forever: no merge transition, no test-plan close. Fast merges are
 * normal here (one reviewer), so this is a permanent condition, not an outage.
 *
 * So each sweep also looks back over recently closed PRs and reconciles the ones
 * the watcher never saw (`state.seen` misses them) against the two places a
 * dangling reference can live:
 *   (a) a PR-open log line in ANY area, written by anyone but the watcher (the
 *       implementer logs its own, e.g. area `feat/<branch>`), still the newest
 *       line for its area; and
 *   (b) an active test-plan referencing the PR.
 * With neither, there is nothing dangling and the sweep stays silent — no
 * back-logging of ancient PRs. When there is, the watcher writes the missing
 * `pr-<n>` transition (which also marks the PR seen, so this runs exactly once),
 * closes each dangling foreign area, and runs the normal merge plan-closure.
 * @param {{closed: Map<string, ClosedPR>, state: {seen: Set<string>, prOpen: LogEntry[]}, query: typeof api.query, log: typeof api.log, plans: PlanDeps}} p
 * @returns {Promise<string[]>} transition tokens
 */
async function reconcileMissedPRs({ closed, state, query, log, plans }) {
  /** @type {string[]} */
  const transitions = [];
  for (const [key, pr] of closed) {
    if (state.seen.has(key)) continue; // the watcher already logged this PR's life
    // (a) dangling PR-open lines in any non-watcher area that cite this PR
    /** @type {Map<string, LogEntry>} */
    const byArea = new Map();
    for (const e of state.prOpen) {
      if (e.repo !== pr.repo || e.agent === WATCH_AGENT) continue;
      if (!textCitesPR(e.message || '', pr.repo, pr.number)) continue;
      const prev = byArea.get(e.area);
      if (!prev || e.id > prev.id) byArea.set(e.area, e);
    }
    /** @type {LogEntry[]} */
    const dangling = [];
    for (const e of byArea.values()) {
      if (await isLatestInArea(query, e)) dangling.push(e);
    }
    // (b) active test-plans referencing this PR
    const found = await plansForPR({ repo: pr.repo, number: pr.number, plans });
    if (found.failed) {
      transitions.push(`${key} catch-up deferred (plan API list failed)`);
      continue; // fail closed: try again next sweep rather than half-reconcile
    }
    if (!dangling.length && !found.matches.length) continue; // nothing dangling
    const merged = pr.state === 'MERGED';
    const outcome = merged ? 'merged' : 'closed without merge';
    await log({
      repo: pr.repo,
      area: `pr-${pr.number}`,
      status: 'done',
      message: `PR #${pr.number} ${outcome} — "${pr.title}" (catch-up: the watcher never saw it open — opened and closed between sweeps)`,
      agent: WATCH_AGENT,
    });
    transitions.push(`${key} ${merged ? 'merged' : 'closed'} (catch-up)`);
    for (const e of dangling) {
      await log({
        repo: pr.repo,
        area: e.area,
        status: 'done',
        message: `PR #${pr.number} ${outcome} — "${pr.title}" (catch-up: this area's PR-open line had no closing line)`,
        agent: WATCH_AGENT,
      });
      transitions.push(`${pr.repo}/${e.area} resolved`);
    }
    if (merged) transitions.push(...await closeTestPlans({ repo: pr.repo, number: pr.number, plans, log }));
  }
  return transitions;
}

/**
 * One sweep: diff GitHub's open PRs against the watcher state in the central log
 * and write one line per transition. Returns a one-line human summary for the
 * `ws pull` diagnostic output; NEVER throws.
 * @param {{gh?: (args: string[]) => string, query?: typeof api.query, log?: typeof api.log, plans?: PlanDeps}} [deps] injectable for tests
 * @returns {Promise<string>}
 */
export async function sweepPRs({
  gh = ghExec,
  query = api.query,
  log = api.log,
  plans = { list: api.planList, get: api.planGet, set: api.planSet },
} = {}) {
  /** @type {Map<string, string>} */
  let repos;
  try {
    repos = listRepos(gh);
  } catch {
    return 'skipped (gh repo list failed — gh missing, offline, or unauthenticated)';
  }
  /** @type {Map<string, OpenPR>} */
  let open;
  try {
    open = listOpenPRs(gh, repos);
  } catch {
    return 'skipped (gh pr list failed for a repo — partial data would fake closures)';
  }
  /** @type {Map<string, ClosedPR>} */
  let closed;
  try {
    closed = listClosedPRs(gh, repos);
  } catch {
    return 'skipped (gh pr list --state closed failed for a repo — partial data would fake closures)';
  }
  /** @type {{open: Set<string>, seen: Set<string>, prOpen: LogEntry[]}} */
  let state;
  try {
    state = await watcherState(query);
  } catch {
    return 'skipped (log API query failed)';
  }
  const known = state.open;

  /** @type {string[]} */
  const transitions = [];
  try {
    // Newly open (or reopened) PRs → PR-open.
    for (const [key, pr] of open) {
      if (known.has(key)) continue;
      const tag = pr.dependabot ? ' [dependabot]' : '';
      await log({
        repo: pr.repo,
        area: `pr-${pr.number}`,
        status: 'PR-open',
        message: `PR #${pr.number} open — "${pr.title}" by ${pr.author}${tag} — ${pr.url}`,
        agent: WATCH_AGENT,
      });
      transitions.push(`${key} open`);
    }
    // Watched PRs no longer open → done (outcome from one gh pr view per closure).
    for (const key of known) {
      if (open.has(key)) continue;
      const [repo, number] = key.split('#');
      const nameWithOwner = repos.get(repo);
      /** @type {string} */
      let message;
      /** @type {string} */
      let label;
      if (!nameWithOwner) {
        message = `PR #${number} closed out — repo no longer listed (archived or renamed)`;
        label = 'closed';
      } else {
        /** @type {{state?: string, title?: string}} */
        let view = {};
        try {
          view = JSON.parse(gh(['pr', 'view', number, '-R', nameWithOwner, '--json', 'state,title']));
        } catch {
          /* view failure → generic closure below */
        }
        if (view.state === 'OPEN') continue; // listing raced — leave it for the next tick
        label = view.state === 'MERGED' ? 'merged' : 'closed';
        const outcome = view.state === 'MERGED' ? 'merged'
          : view.state === 'CLOSED' ? 'closed without merge'
          : 'closed — final state unknown (gh pr view failed)';
        message = `PR #${number} ${outcome}${view.title ? ` — "${view.title}"` : ''}`;
      }
      await log({ repo, area: `pr-${number}`, status: 'done', message, agent: WATCH_AGENT });
      transitions.push(`${key} ${label}`);
      if (label === 'merged') {
        // Script-enforced: a merge closes its test-plans (or flags follow-ups).
        transitions.push(...await closeTestPlans({ repo, number: Number(number), plans, log }));
      }
    }
    // Catch-up: PRs that opened and closed between two sweeps were never in
    // `known`, so the loop above can never see them — reconcile them here.
    transitions.push(...await reconcileMissedPRs({ closed, state, query, log, plans }));
    // Re-sweep plans HELD at merge time whose hold has since been released.
    transitions.push(...await resweepReleasedHolds({ closed, plans, log, query }));
  } catch {
    // api.log falls back to an md append itself; reaching here means something
    // deeper broke mid-sweep — report what landed, never throw into the pull.
    return `interrupted after ${transitions.length} transition(s): ${transitions.join(', ') || 'none'}`;
  }
  return transitions.length
    ? `logged ${transitions.length} transition(s): ${transitions.join(', ')}`
    : `no transitions (${open.size} open PR(s) across ${repos.size} repos)`;
}
