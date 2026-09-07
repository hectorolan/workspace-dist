// TP-baseline: the DB-backed regression baseline (backlog 59, implementing the
// item-43 decision; plan `ws plan get test-plan-regression-baseline`).
//
// Scope: the pure logic this module owns — tally extraction, the plan-body
// round trip, the FOUR states (absent / matched / regressed / stale) and the
// green-only fold. The DB round trip itself is `ws plan`'s, already covered by
// the plans suite; the guard integration is asserted in ciguard.test.js.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  baselineSlug, parseBaseline, renderBaseline, tallyFromOutput, compareSuite,
  foldGreenRuns, summarizeVerdicts, commitKnown, BASELINE_KIND,
  CASE_ID_SOURCE, expandCaseIds,
} from '../util/baseline.js';

/** @param {number} pass @param {number} fail @param {string[]} [cases] */
const specOutput = (pass, fail, cases = []) => [
  ...cases.map((c, i) => `✔ ${c}: something (${i}ms)`),
  `ℹ tests ${pass + fail}`,
  `ℹ pass ${pass}`,
  `ℹ fail ${fail}`,
].join('\n');

test('TP-baseline-001: the carrier is a `ws plan` slug per repo, kind baseline (no file, no parallel store)', () => {
  assert.equal(baselineSlug('workspace'), 'test-baseline-workspace');
  assert.equal(baselineSlug('ho-nexus'), 'test-baseline-ho-nexus');
  assert.equal(BASELINE_KIND, 'baseline');
});

test('TP-baseline-002: a green spec-reporter run yields pass/fail counts and the covered case IDs', () => {
  const t = tallyFromOutput(specOutput(3, 0, ['TP-ci-guard-001', 'TP-encoding-guard-004']));
  assert.deepEqual(t, { pass: 3, fail: 0, cases: ['TP-ci-guard-001', 'TP-encoding-guard-004'] });
});

test('TP-baseline-003: only PASSING cases count as covered — a failing case is not in the baseline', () => {
  const out = [
    '✔ TP-x-001: ok',
    '✖ TP-x-002: broken',
    'ℹ pass 1',
    'ℹ fail 1',
  ].join('\n');
  const t = tallyFromOutput(out);
  assert.deepEqual(t.cases, ['TP-x-001']);
  assert.equal(t.fail, 1);
});

test('TP-baseline-004: TAP reporter output tallies the same way (reporter choice is not a semantic)', () => {
  const t = tallyFromOutput(['ok 1 - TP-tap-001 works', 'not ok 2 - TP-tap-002 broke', '# pass 1', '# fail 1'].join('\n'));
  assert.equal(t.pass, 1);
  assert.equal(t.fail, 1);
  assert.deepEqual(t.cases, ['TP-tap-001']);
});

test('TP-baseline-005: output with no tally reads as -1 (not measured), never as zero passes', () => {
  assert.equal(tallyFromOutput('some unrelated noise').pass, -1);
});

test('TP-baseline-022: a COLOURISED run tallies identically — colour is display, never data', () => {
  // windows-pc, 2026-08-18: a shell with FORCE_COLOR set made every tally line arrive
  // wrapped in ESC sequences, so this returned -1 and the baseline went silently blind.
  const esc = String.fromCharCode(27);
  const colour = (/** @type {string} */ s) => `${esc}[34m${s}${esc}[39m`;
  const out = [
    colour('✔ TP-colour-001: ok (1ms)'),
    colour('ℹ tests 2'),
    colour('ℹ pass 1'),
    colour('ℹ fail 1'),
  ].join('\n');
  assert.deepEqual(tallyFromOutput(out), { pass: 1, fail: 1, cases: ['TP-colour-001'] });
});

test('TP-baseline-006: render -> parse round trip preserves the record exactly', () => {
  const data = {
    repo: 'workspace',
    updated: '2026-07-28',
    suites: { cli: { commit: 'abc1234', pass: 308, fail: 0, cases: ['TP-a-001'], date: '2026-07-28' } },
  };
  const body = renderBaseline(data);
  assert.match(body, /```json/);
  assert.deepEqual(parseBaseline(body), data);
});

test('TP-baseline-007: an unparseable or fenceless body reads as ABSENT, never as an error', () => {
  assert.equal(parseBaseline('just prose'), null);
  assert.equal(parseBaseline('```json\n{ not json\n```'), null);
  assert.equal(parseBaseline(''), null);
  assert.equal(parseBaseline('```json\n{"repo":"x"}\n```'), null); // no suites key
});

test('TP-baseline-008: STATE ABSENT — no baseline is a normal state, not a failure', () => {
  const v = compareSuite(null, { pass: 10, fail: 0, cases: [] }, { suite: 'cli', today: '2026-07-28' });
  assert.equal(v.state, 'absent');
  assert.equal(v.advisory, false);
  assert.match(v.detail, /normal for a new repo/);
  assert.doesNotMatch(v.detail, /REGRESSED|STALE|FAILED/); // absence never reads as a verdict against the run
});

test('TP-baseline-009: STATE MATCHED — a green run holding every covered case confirms the baseline', () => {
  const base = { commit: 'abc1234', pass: 308, fail: 0, cases: ['TP-a-001'], date: '2026-07-28' };
  const v = compareSuite(base, { pass: 308, fail: 0, cases: ['TP-a-001'] }, { suite: 'cli', today: '2026-07-28' });
  assert.equal(v.state, 'matched');
  assert.equal(v.passDelta, 0);
});

test('TP-baseline-010: STATE MATCHED — added tests advance the count without being a regression', () => {
  const base = { commit: 'abc1234', pass: 308, fail: 0, cases: ['TP-a-001'], date: '2026-07-28' };
  const v = compareSuite(base, { pass: 312, fail: 0, cases: ['TP-a-001', 'TP-a-002'] }, { suite: 'cli', today: '2026-07-28' });
  assert.equal(v.state, 'matched');
  assert.equal(v.passDelta, 4);
});

test('TP-baseline-011: STATE REGRESSED — a failing run names the last green commit it regressed against', () => {
  const base = { commit: 'abc1234', pass: 308, fail: 0, cases: ['TP-a-001'], date: '2026-07-28' };
  const v = compareSuite(base, { pass: 307, fail: 1, cases: [] }, { suite: 'cli', today: '2026-07-28' });
  assert.equal(v.state, 'regressed');
  assert.match(v.detail, /abc1234/);
  assert.deepEqual(v.missingCases, ['TP-a-001']);
});

test('TP-baseline-012: STATE REGRESSED — a covered case that silently vanished is caught even with 0 failures', () => {
  const base = { commit: 'abc1234', pass: 2, fail: 0, cases: ['TP-a-001', 'TP-a-002'], date: '2026-07-28' };
  const v = compareSuite(base, { pass: 2, fail: 0, cases: ['TP-a-001', 'TP-a-003'] }, { suite: 'cli', today: '2026-07-28' });
  assert.equal(v.state, 'regressed');
  assert.deepEqual(v.missingCases, ['TP-a-002']);
});

test('TP-baseline-013: STATE STALE — an aged baseline is advisory, and reads differently from regressed', () => {
  const base = { commit: 'abc1234', pass: 308, fail: 0, cases: [], date: '2026-06-01' };
  const v = compareSuite(base, { pass: 300, fail: 1, cases: [] }, { suite: 'cli', today: '2026-07-28' });
  assert.equal(v.state, 'stale');
  assert.equal(v.advisory, true);
  assert.match(v.detail, /STALE/);
});

test('TP-baseline-014: STATE STALE — a baseline commit this repo does not know cannot be compared honestly', () => {
  const base = { commit: 'deadbee', pass: 308, fail: 0, cases: [], date: '2026-07-28' };
  const v = compareSuite(base, { pass: 308, fail: 0, cases: [] }, { suite: 'cli', today: '2026-07-28', commitKnown: false });
  assert.equal(v.state, 'stale');
  assert.equal(v.advisory, true);
  assert.match(v.detail, /unknown to this repo/);
});

test('TP-baseline-015: commitKnown answers against a real repo (HEAD yes, a fabricated sha no)', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'ws-baseline-'));
  try {
    const git = (/** @type {string[]} */ a) => execFileSync('git', a, { cwd: root, stdio: 'ignore' });
    git(['init', '-q']);
    git(['config', 'user.email', 'a@b.c']);
    git(['config', 'user.name', 'test']);
    git(['commit', '-q', '--allow-empty', '-m', 'seed']);
    const head = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
    assert.equal(commitKnown(root, head), true);
    assert.equal(commitKnown(root, '0000000000000000000000000000000000000000'), false);
    assert.equal(commitKnown(root, ''), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('TP-baseline-016: a RED run is never recorded — a baseline must not define its own regression away', () => {
  const { baseline, recorded, skipped } = foldGreenRuns(null, 'workspace', {
    cli: { pass: 300, fail: 8, cases: [], commit: 'abc1234' },
  }, '2026-07-28');
  assert.deepEqual(recorded, []);
  assert.deepEqual(skipped, ['cli']);
  assert.deepEqual(baseline.suites, {});
});

test('TP-baseline-017: a green run folds in per suite, leaving other suites untouched', () => {
  const current = {
    repo: 'workspace',
    updated: '2026-07-01',
    suites: { server: { commit: 'old1111', pass: 76, fail: 0, cases: [], date: '2026-07-01' } },
  };
  const { baseline, recorded } = foldGreenRuns(current, 'workspace', {
    cli: { pass: 308, fail: 0, cases: ['TP-a-002', 'TP-a-001'], commit: 'new2222' },
  }, '2026-07-28');
  assert.deepEqual(recorded, ['cli']);
  assert.equal(baseline.suites.server.commit, 'old1111');
  assert.equal(baseline.suites.cli.commit, 'new2222');
  assert.deepEqual(baseline.suites.cli.cases, ['TP-a-001', 'TP-a-002']); // sorted, stable
  assert.equal(baseline.updated, '2026-07-28');
});

test('TP-baseline-018: the summary hides matched suites and surfaces everything else', () => {
  const matched = compareSuite({ commit: 'a', pass: 1, fail: 0, cases: [], date: '2026-07-28' },
    { pass: 1, fail: 0, cases: [] }, { suite: 'cli', today: '2026-07-28' });
  const absent = compareSuite(null, { pass: 1, fail: 0, cases: [] }, { suite: 'server', today: '2026-07-28' });
  const s = summarizeVerdicts([matched, absent]);
  assert.match(s, /1 matched/);
  assert.match(s, /1 absent/);
  assert.match(s, /no baseline recorded yet/);
  assert.equal(summarizeVerdicts([matched]), '1 matched');
  assert.equal(summarizeVerdicts([]), 'no suites compared');
});

// --- case-ID suffix grammar (duplicate resolution, plan test-plan-case-id-suffix) ---

test('TP-caseid-001: CASE_ID_SOURCE matches bare and suffixed IDs as whole tokens only', () => {
  const re = () => new RegExp(CASE_ID_SOURCE, 'g');
  assert.deepEqual('TP-x-001'.match(re()), ['TP-x-001']);
  assert.deepEqual('TP-x-001_2'.match(re()), ['TP-x-001_2']);
  assert.deepEqual('TP-x-001_10'.match(re()), ['TP-x-001_10']);
  // Never a half-match of the bare ID inside a suffixed one — that would let a
  // run passing 001_2 read as covering 001.
  assert.deepEqual('see TP-x-001_2 here'.match(re()), ['TP-x-001_2']);
  assert.equal('TP-x-001_2x'.match(re()), null);
});

test('TP-caseid-002: suffixed IDs harvest from passing lines and stay distinct from bare ones', () => {
  const out = specOutput(3, 0, ['TP-x-079', 'TP-x-079_2', 'TP-y-001_3']);
  assert.deepEqual(tallyFromOutput(out).cases, ['TP-x-079', 'TP-x-079_2', 'TP-y-001_3']);
  const tap = ['ok 1 - TP-x-079 bare', 'ok 2 - TP-x-079_2 suffixed', '# pass 2', '# fail 0'].join('\n');
  assert.deepEqual(tallyFromOutput(tap).cases, ['TP-x-079', 'TP-x-079_2']);
});

test('TP-caseid-003: run grammar — suffixed head parses, suffixed tail is invisible (under-coverage, never mis-coverage)', () => {
  const out = specOutput(3, 0, ['TP-x-001/002', 'TP-a-001_2/002', 'TP-b-001/002_2']);
  assert.deepEqual(tallyFromOutput(out).cases,
    ['TP-a-001_2', 'TP-a-002', 'TP-b-001', 'TP-x-001', 'TP-x-002']);
});

test('TP-caseid-004: expandCaseIds — a suffixed head keeps its suffix, tails resolve against the bare prefix', () => {
  assert.deepEqual(expandCaseIds('TP-x-001_2/002'), ['TP-x-001_2', 'TP-x-002']);
  assert.deepEqual(expandCaseIds('TP-x-001_2'), ['TP-x-001_2']);
});

test('TP-caseid-012: bare grammar unchanged — pre-suffix shapes parse exactly as before', () => {
  const out = specOutput(2, 0, ['TP-api3-006/007', 'TP-ssr-012']);
  assert.deepEqual(tallyFromOutput(out).cases, ['TP-api3-006', 'TP-api3-007', 'TP-ssr-012']);
});
