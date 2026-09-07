#!/usr/bin/env node
// test-baseline — the devops read/update flow for the DB-backed regression baseline
// (backlog 59, implementing the item-43 decision).
//
// The baseline lives in the central DB as a plan (slug `test-baseline-<repo>`, kind
// `baseline`) — NOT as `ops/test-baseline.json`, which must not exist in any repo.
// Shape, keying and the four states are documented once in `cli/util/baseline.js`;
// this tool is only the CLI over it.
//
//   node cli/util-tools/test-baseline.js show   [--repo <r>]                  read only, no suites run
//   node cli/util-tools/test-baseline.js check  [--repo <r>] [--suite a,b]    run + compare, exit 1 on a regression
//   node cli/util-tools/test-baseline.js record [--repo <r>] [--suite a,b] [--dry-run]
//                                                                            run + write the green suites back
//
// Exit codes: 0 ok (incl. ABSENT — a repo with no baseline yet is normal, not a
// failure), 1 a regression was proven, 2 the tool itself could not do its job
// (API unreachable, bad usage). `record` NEVER writes a red suite: recording a red
// run would define the regression away, which is the one thing a baseline prevents.
import { execFileSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import { workspaceDir, planGet, planSet, today } from '../util/index.js';
import {
  BASELINE_KIND, baselineSlug, parseBaseline, renderBaseline, tallyFromOutput,
  compareSuite, commitKnown, foldGreenRuns, summarizeVerdicts, DEFAULT_STALE_DAYS,
} from '../util/baseline.js';
import { SUITE_GATE, runGate } from '../util/ciguard.js';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    repo: { type: 'string' },
    suite: { type: 'string' },
    'dry-run': { type: 'boolean' },
    json: { type: 'boolean' },
  },
});
const cmd = positionals[0] || '';
const repo = values.repo || 'workspace';
const root = workspaceDir();
const suites = (values.suite ? values.suite.split(',') : Object.keys(SUITE_GATE))
  .map((s) => s.trim())
  .filter(Boolean);

/** @param {string} m @param {number} code */
const die = (m, code) => { console.error(m); process.exit(code); };

/** The baseline currently in the DB, or null. Throws only when the API is unreachable. */
async function readBaseline() {
  try {
    return parseBaseline(await planGet(baselineSlug(repo)));
  } catch (e) {
    // A slug that does not exist is the ABSENT state, not an error: a fresh clone
    // with an empty DB has no baseline and must not look broken.
    if (e instanceof Error && /not found/i.test(e.message)) return null;
    throw e;
  }
}

/** @returns {string} short HEAD sha of the workspace repo */
const headCommit = () => execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();

/**
 * Run the requested suites through the ci-guard gate runner (one owner for "how a
 * suite is run") and tally each. A suite that cannot run here is reported, not failed.
 * @returns {{runs: Record<string, {pass: number, fail: number, cases: string[]}>, notes: string[]}}
 */
function runSuites() {
  /** @type {Record<string, {pass: number, fail: number, cases: string[]}>} */
  const runs = {};
  /** @type {string[]} */
  const notes = [];
  for (const suite of suites) {
    const gate = SUITE_GATE[suite];
    if (!gate) { notes.push(`${suite}: unknown suite (known: ${Object.keys(SUITE_GATE).join(', ')})`); continue; }
    const r = runGate(root, gate, {});
    if (!r.runnable || r.problem) { notes.push(`${suite}: ${r.problem} — not measured`); continue; }
    const tally = tallyFromOutput(r.output);
    if (tally.pass < 0) { notes.push(`${suite}: no test tally in the output — not measured`); continue; }
    runs[suite] = tally;
  }
  return { runs, notes };
}

/**
 * Compare a set of runs against the baseline.
 * @param {import('../util/baseline.js').Baseline|null} base
 * @param {Record<string, {pass: number, fail: number, cases: string[]}>} runs
 */
function compareAll(base, runs) {
  const t = today();
  return Object.entries(runs).map(([suite, tally]) => {
    const b = base && base.suites ? base.suites[suite] : null;
    return compareSuite(b, tally, { suite, today: t, commitKnown: b ? commitKnown(root, b.commit) : true });
  });
}

async function main() {
  if (!['show', 'check', 'record'].includes(cmd)) {
    die('usage: test-baseline.js show|check|record [--repo <r>] [--suite <a,b>] [--dry-run] [--json]', 2);
  }
  /** @type {import('../util/baseline.js').Baseline|null} */
  let base;
  try {
    base = await readBaseline();
  } catch (e) {
    die(`test-baseline: cannot reach the log API (${e instanceof Error ? e.message : e}) — the baseline lives in the DB, nothing to read`, 2);
    return;
  }

  if (cmd === 'show') {
    // Read-only: state per RECORDED suite, without spending 20s running anything.
    if (!base) {
      const out = { repo, state: 'absent', suites: {} };
      if (values.json) console.log(JSON.stringify(out, null, 2));
      else console.log(`test-baseline ${repo}: ABSENT — no baseline recorded yet. Normal for a new repo or a fresh DB; record one with \`record\`.`);
      return 0;
    }
    const t = today();
    const rows = Object.entries(base.suites).map(([suite, s]) => {
      const known = commitKnown(root, s.commit);
      const age = Math.round((Date.parse(t) - Date.parse(s.date)) / 86400000);
      const stale = !known || age > DEFAULT_STALE_DAYS;
      return { suite, ...s, ageDays: age, commitKnown: known, state: stale ? 'stale' : 'current' };
    });
    if (values.json) { console.log(JSON.stringify({ repo, state: 'present', updated: base.updated, suites: rows }, null, 2)); return 0; }
    console.log(`test-baseline ${repo} (plan ${baselineSlug(repo)}, updated ${base.updated}):`);
    for (const r of rows) {
      console.log(`  ${r.suite}: ${r.state.toUpperCase()} — ${r.pass} pass at ${r.commit} (${r.date}, ${r.ageDays}d ago), ${r.cases.length} covered case(s)`
        + (r.commitKnown ? '' : ' [commit unknown to this repo]'));
    }
    for (const suite of suites) if (!base.suites[suite]) console.log(`  ${suite}: ABSENT — never recorded (normal, not a failure)`);
    return 0;
  }

  const { runs, notes } = runSuites();
  for (const n of notes) console.log(`test-baseline: ${n}`);
  const verdicts = compareAll(base, runs);
  for (const v of verdicts) console.log(`test-baseline: ${v.detail}`);

  if (cmd === 'check') {
    if (values.json) console.log(JSON.stringify({ repo, runs, verdicts }, null, 2));
    const regressed = verdicts.filter((v) => v.state === 'regressed');
    console.log(`test-baseline check ${repo}: ${summarizeVerdicts(verdicts)}`);
    return regressed.length ? 1 : 0;
  }

  // record
  const commit = headCommit();
  const withCommit = Object.fromEntries(Object.entries(runs).map(([s, r]) => [s, { ...r, commit }]));
  const { baseline, recorded, skipped } = foldGreenRuns(base, repo, withCommit, today());
  if (skipped.length) console.log(`test-baseline: NOT recorded (run not green): ${skipped.join(', ')} — a red run must never become the baseline`);
  if (!recorded.length) { console.log('test-baseline: nothing green to record'); return skipped.length ? 1 : 0; }
  if (values['dry-run']) {
    console.log(`test-baseline: --dry-run, would record ${recorded.join(', ')} at ${commit}`);
    console.log(renderBaseline(baseline));
    return 0;
  }
  try {
    const { line, created } = await planSet(baselineSlug(repo), {
      title: `Regression baseline - ${repo}`,
      body: renderBaseline(baseline),
      kind: BASELINE_KIND,
      status: 'active',
      repo,
      agent: 'devops',
    });
    console.log(`test-baseline: ${created ? 'created' : 'updated'} ${line}`);
    console.log(`test-baseline: recorded ${recorded.map((s) => `${s}=${baseline.suites[s].pass} pass/${baseline.suites[s].cases.length} cases`).join(', ')} at ${commit}`);
  } catch (e) {
    // Returned, not `die`d: a hard process.exit() here would race the just-closed
    // POST socket (see the exit note at the bottom of this file).
    console.error(`test-baseline: write FAILED (${e instanceof Error ? e.message : e}) — nothing was saved`);
    return 2;
  }
  return 0;
}

// Set `process.exitCode` and let the loop drain rather than calling process.exit():
// on Windows, exiting hard right after a POST that followed a long execFileSync run
// trips libuv's `Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)` and turns a
// successful `record` into exit 127 (reproduced 3/3 on 2026-07-28). This tool's exit
// code IS its contract (`check` exits 1 on a proven regression), so it must be real.
main().then((c) => { process.exitCode = c || 0; }).catch((e) => {
  console.error(`test-baseline: ${e instanceof Error ? e.message : e}`);
  process.exitCode = 2;
});
