// Regression baseline (backlog 59, implementing the item-43 decision).
//
// WHAT IT IS: per repo, per test suite, the last GREEN run — the commit it ran
// at, its pass/fail tally, and the test-plan case IDs that run covered. It is
// what makes "newly failing test" provable instead of a guess: without it a red
// suite is answered with "was it always like that?" (2026-07-28, when main sat
// red with 10 pre-existing TS7006 errors and nobody could tell).
//
// WHERE IT LIVES — the carrier decision (Hector 2026-07-28, backlog 43):
// **the central DB, through `ws plan`. No file, in any repo** — `ops/test-baseline.json`
// must never be created anywhere. A baseline is a per-run regenerated artifact and
// accreted per-instance history, and a fresh clone with an empty DB legitimately has
// NO baseline yet because a new operator has not run the suites. That is DB content
// by the churn test; a git file would have been the exception needing justification.
//
// WHY A PLAN AND NOT A DEDICATED TABLE (the W3 station-registry precedent, weighed
// rather than copied): the station registry deliberately took a table because
// `planSet` snapshots a revision on EVERY write and 3 stations x ~96 ticks/day is
// revision bloat by construction. A baseline is the opposite case — it moves only on
// a green suite run (a few times a day at most), and its revision history is the
// FEATURE: "when did this baseline last move, and to what" is exactly the question
// asked while diagnosing a regression, and `ws plan history test-baseline-<repo>`
// answers it for free. Item 43 also forbids a parallel storage path alongside
// `ws plan`, and nothing here justifies one.
//
// KEYING: one plan per repo, slug `test-baseline-<repo>`, kind `baseline`, the plan
// row's `repo` column set — so `ws plan list --kind baseline` is the whole index and
// the hub Plans page renders each one. Suites are keys INSIDE that plan's body,
// so a repo's baseline is read and written in one call. Kind `baseline` is distinct
// from `test-plan` on purpose: pr-watch sweeps active `test-plan`-kind plans on PR
// merge and would otherwise close a baseline the first time a PR landed.
//
// BODY FORMAT: human-readable markdown carrying ONE fenced ```json block, which is
// the machine-readable record. The page renders, the parser reads the fence.
import { execFileSync } from 'node:child_process';
import { stripAnsi } from './ansi.js';

export const BASELINE_KIND = 'baseline';

/** Days after which a recorded suite baseline is advisory rather than comparable. */
export const DEFAULT_STALE_DAYS = 21;

/** @param {string} repo @returns {string} the plan slug carrying <repo>'s baseline */
export const baselineSlug = (repo) => `test-baseline-${repo}`;

/**
 * @typedef {object} SuiteBaseline
 * @property {string} commit    full or short SHA the green run was measured at
 * @property {number} pass
 * @property {number} fail      always 0 for a recorded baseline (only green runs record)
 * @property {string[]} cases   test-plan case IDs covered by that run, sorted, deduped
 * @property {string} date      local calendar date (cli/util/clock.js), YYYY-MM-DD
 */

/**
 * @typedef {object} Baseline
 * @property {string} repo
 * @property {string} updated   local calendar date of the most recent suite write
 * @property {Record<string, SuiteBaseline>} suites
 */

/**
 * Test-plan case IDs are `TP-<slug>-NNN` (CLAUDE.md / devops agent contract),
 * optionally carrying a duplicate-resolution suffix: `TP-<slug>-NNN_k`.
 * ONE owner for the shape: prwatch/planclose read the same IDs out of plan
 * bodies that this module reads out of test output, and a green run can only be
 * matched against a plan if both sides agree on what an ID looks like.
 *
 * THE SUFFIX (CEO decision 2026-08-02, the ho-nexus duplicate-claim backlog
 * item): when two tests accidentally claim one ID, the SECOND claimant is
 * renamed `<id>_2` (a third `_3`, …) — never renumbered — and the first keeps
 * the bare ID. `TP-x-079` and `TP-x-079_2` are therefore DISTINCT case IDs:
 * a run passing only the bare one never satisfies the suffixed one, and vice
 * versa. Convention: a suffixed ID is written ALONE, never inside an `A/B/C`
 * shorthand run (run tails are always bare 3-digit numbers; a suffixed head
 * still parses, its tails resolving against the bare `TP-…-` prefix, and a
 * suffixed tail is simply invisible — violations degrade to under-coverage,
 * never to a wrong case being satisfied).
 *
 * Callers needing their own matcher build a fresh RegExp from the source (the
 * `g` flag carries `lastIndex` state — never share the object itself).
 */
export const CASE_ID_SOURCE = '\\bTP-[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*-\\d{3}(?:_\\d+)?\\b';
/**
 * One test frequently asserts several cases at once and says so in its name with
 * a slash shorthand — `TP-api3-006/007`, `TP-ssr-012/015/016`. The trailing
 * numbers inherit the leading ID's prefix, so a plain ID scan sees only the
 * first and silently discards real, passing coverage (which then reads as an
 * uncovered case and holds a test-plan open forever). Match the whole run and
 * expand it.
 */
const CASE_ID_RUN = new RegExp(`${CASE_ID_SOURCE.replace(/\\b$/, '')}(?:/\\d{3})*\\b`, 'g');

/**
 * Expand `TP-x-006/007` into `['TP-x-006', 'TP-x-007']`; a lone ID passes through.
 * @param {string} token
 * @returns {string[]}
 */
export function expandCaseIds(token) {
  const [head, ...rest] = token.split('/');
  const prefix = head.slice(0, head.lastIndexOf('-') + 1);
  return [head, ...rest.map((n) => `${prefix}${n}`)];
}

/**
 * Pass/fail tally + covered test-plan case IDs from one `node --test` run's output.
 * Reads the `# pass N` / `# fail N` tallies (present in both the TAP and spec
 * reporters) and harvests case IDs from PASSING case lines only — a case that
 * failed is not "covered" by a green baseline.
 * @param {string} output combined stdout+stderr of the suite
 * @returns {{pass: number, fail: number, cases: string[]}}
 */
export function tallyFromOutput(output) {
  // Strip colour before matching: a colourised reporter wraps every tally and case
  // line in ESC sequences, and the anchors below would then return -1 (= "no tally"),
  // which silently empties the baseline and starves plan-close of covered case IDs.
  const lines = stripAnsi(output).split(/\r?\n/);
  /** @param {string} key */
  const tally = (key) => {
    for (const l of lines) {
      const m = l.trim().match(new RegExp(`^[\\u2139#]?\\s*${key}\\s+(\\d+)$`));
      if (m) return Number(m[1]);
    }
    return -1;
  };
  /** @type {Set<string>} */
  const cases = new Set();
  for (const l of lines) {
    const t = l.trim();
    // Spec reporter marks a passing case with U+2714, TAP with `ok N - name`.
    if (!/^(✔|ok \d+)/.test(t)) continue;
    for (const token of t.match(CASE_ID_RUN) || []) {
      for (const id of expandCaseIds(token)) cases.add(id);
    }
  }
  return { pass: tally('pass'), fail: tally('fail'), cases: [...cases].sort() };
}

/**
 * Extract the baseline record from a plan body (or a full `ws plan get` payload).
 * Tolerant by design: anything unparseable reads as "no baseline", which is the
 * ABSENT state — never an error, never a block.
 * @param {string} text
 * @returns {Baseline|null}
 */
export function parseBaseline(text) {
  const m = String(text || '').match(/```json\s*\n([\s\S]*?)\n```/);
  if (!m) return null;
  try {
    const data = JSON.parse(m[1]);
    if (!data || typeof data !== 'object' || typeof data.suites !== 'object' || !data.suites) return null;
    return /** @type {Baseline} */ (data);
  } catch {
    return null;
  }
}

/**
 * Render a baseline as the plan body: a short human header plus the JSON fence.
 * @param {Baseline} data
 * @returns {string}
 */
export function renderBaseline(data) {
  const rows = Object.entries(data.suites)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, s]) => `| ${name} | ${s.pass} | ${s.commit} | ${s.date} | ${s.cases.length} |`);
  return [
    `Regression baseline for **${data.repo}** — last green run per suite.`,
    '',
    'Machine-written by `node cli/util-tools/test-baseline.js record` and read by ci-guard;',
    'never hand-edit the JSON fence. Revision history (`ws plan history ' + baselineSlug(data.repo) + '`)',
    'is the record of when each suite last moved.',
    '',
    '| suite | pass | last green commit | date | covered cases |',
    '|---|---|---|---|---|',
    ...rows,
    '',
    '```json',
    JSON.stringify(data, null, 2),
    '```',
    '',
  ].join('\n');
}

/**
 * Is <commit> an object this repo still knows about? A baseline pointing at a
 * commit that no longer exists (rewritten history, wrong clone) cannot be
 * compared against honestly — it reads STALE, not regressed.
 * @param {string} root
 * @param {string} commit
 * @returns {boolean}
 */
export function commitKnown(root, commit) {
  if (!commit) return false;
  try {
    execFileSync('git', ['cat-file', '-e', `${commit}^{commit}`], { cwd: root, stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/**
 * @typedef {object} SuiteVerdict
 * @property {string} suite
 * @property {'absent'|'matched'|'regressed'|'stale'} state
 * @property {string} detail one line, safe to print or log
 * @property {string[]} missingCases baseline case IDs the run did not pass
 * @property {number} passDelta run.pass - baseline.pass (0 when absent)
 * @property {boolean} advisory true when the comparison itself cannot be trusted
 */

/**
 * Compare one suite run against its recorded baseline.
 *
 * THE FOUR STATES (backlog 43 requirement (c) — absence must not read as failure):
 *  - `absent`    no baseline recorded for this suite. **A NORMAL state**: a new repo,
 *                a fresh clone, an empty DB, a suite nobody has recorded yet. Never a
 *                failure, never blocks anything; the fix is to record one.
 *  - `matched`   the run is green and holds every case the baseline covered. The
 *                baseline is confirmed and may be advanced to this commit.
 *  - `regressed` the run lost ground against the baseline: it has failures, or its
 *                pass count dropped, or a case ID the baseline covered no longer
 *                passes. This is the "provably NEW failure" answer.
 *  - `stale`     a baseline exists but cannot be trusted as a comparison: its commit
 *                is unknown to this repo, or it is older than `staleDays`. Reported
 *                with the comparison it WOULD have made, flagged `advisory` — the
 *                caller must not treat it as a definite violation.
 *
 * @param {SuiteBaseline|null|undefined} base
 * @param {{pass: number, fail: number, cases: string[]}} run
 * @param {{suite: string, today?: string, commitKnown?: boolean, staleDays?: number}} opts
 * @returns {SuiteVerdict}
 */
export function compareSuite(base, run, { suite, today, commitKnown: known = true, staleDays = DEFAULT_STALE_DAYS }) {
  if (!base) {
    return {
      suite,
      state: 'absent',
      detail: `${suite}: no baseline recorded yet (normal for a new repo/suite) — run passed ${run.pass}, failed ${run.fail}`,
      missingCases: [],
      passDelta: 0,
      advisory: false,
    };
  }
  const ranCases = new Set(run.cases);
  const missingCases = (base.cases || []).filter((c) => !ranCases.has(c));
  const passDelta = run.pass - base.pass;
  const ageDays = base.date && today ? Math.round((Date.parse(today) - Date.parse(base.date)) / 86400000) : 0;
  const staleReason = !known
    ? `baseline commit ${base.commit} is unknown to this repo`
    : ageDays > staleDays
      ? `baseline is ${ageDays}d old (> ${staleDays}d)`
      : '';
  const lost = run.fail > 0 || passDelta < 0 || missingCases.length > 0;
  const why = [
    run.fail > 0 ? `${run.fail} failing` : '',
    passDelta < 0 ? `pass count ${base.pass} -> ${run.pass}` : '',
    missingCases.length ? `${missingCases.length} covered case(s) no longer passing: ${missingCases.slice(0, 5).join(', ')}` : '',
  ].filter(Boolean).join('; ');

  if (staleReason) {
    return {
      suite,
      state: 'stale',
      detail: `${suite}: STALE baseline (${staleReason}) — comparison is advisory${lost ? `: ${why}` : '; run looks green against it'}`,
      missingCases,
      passDelta,
      advisory: true,
    };
  }
  if (lost) {
    return {
      suite,
      state: 'regressed',
      detail: `${suite}: REGRESSED vs baseline ${base.commit} (${base.date}, ${base.pass} pass) — ${why}`,
      missingCases,
      passDelta,
      advisory: false,
    };
  }
  return {
    suite,
    state: 'matched',
    detail: `${suite}: matches baseline ${base.commit} (${base.pass} pass)${passDelta > 0 ? ` +${passDelta} new` : ''}`,
    missingCases,
    passDelta,
    advisory: false,
  };
}

/**
 * Fold a green run into a baseline record (pure — the caller persists it).
 * Only green runs are recordable: recording a red run would define the regression
 * away, which is the one thing a baseline exists to prevent.
 * @param {Baseline|null} current
 * @param {string} repo
 * @param {Record<string, {pass: number, fail: number, cases: string[], commit: string}>} runs
 * @param {string} date local calendar date (cli/util/clock.js `today()`)
 * @returns {{baseline: Baseline, recorded: string[], skipped: string[]}}
 */
export function foldGreenRuns(current, repo, runs, date) {
  /** @type {Baseline} */
  const next = { repo, updated: date, suites: { ...((current && current.suites) || {}) } };
  /** @type {string[]} */
  const recorded = [];
  /** @type {string[]} */
  const skipped = [];
  for (const [suite, r] of Object.entries(runs)) {
    if (r.fail !== 0 || r.pass <= 0) {
      skipped.push(suite);
      continue;
    }
    next.suites[suite] = { commit: r.commit, pass: r.pass, fail: 0, cases: [...r.cases].sort(), date };
    recorded.push(suite);
  }
  if (!recorded.length && current) next.updated = current.updated;
  return { baseline: next, recorded, skipped };
}

/**
 * One-line summary of a set of verdicts, for a report or a log line.
 * @param {SuiteVerdict[]} verdicts
 * @returns {string}
 */
export function summarizeVerdicts(verdicts) {
  if (!verdicts.length) return 'no suites compared';
  const counts = verdicts.reduce((/** @type {Record<string, number>} */ acc, v) => {
    acc[v.state] = (acc[v.state] || 0) + 1;
    return acc;
  }, {});
  const head = Object.entries(counts).map(([k, n]) => `${n} ${k}`).join(', ');
  const detail = verdicts.filter((v) => v.state !== 'matched').map((v) => v.detail);
  return detail.length ? `${head} — ${detail.join(' ;; ')}` : head;
}
