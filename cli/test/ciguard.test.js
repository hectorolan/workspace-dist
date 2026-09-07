// TP-ci-guard: the pre-push CI gate for `ws sync` (backlog 58, ws plan get test-plan-ci-guard).
//
// Fixture strategy: the guard's job is plumbing — pick the right gates for the
// staged paths, run them, and decide. So the fixture root ships a TINY fake
// `node_modules/typescript/bin/tsc` (real tsc is exercised by CI itself) and a real
// `cli/test/*.test.js` run through the real `node --test`. That keeps every case
// under a second while covering the code this module actually owns.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { selectGates, summarize, runCiGuard, guardLogMessage, failureHits, gateCommand } from '../util/ciguard.js';

/**
 * @param {{tsc?: 'green'|'red'|'missing', cliTest?: 'green'|'red'|'none'}} opts
 * @returns {string} fixture root
 */
function makeFixture({ tsc = 'green', cliTest = 'none' } = {}) {
  const root = mkdtempSync(path.join(tmpdir(), 'ws-ciguard-'));
  if (tsc !== 'missing') {
    const binDir = path.join(root, 'node_modules', 'typescript', 'bin');
    mkdirSync(binDir, { recursive: true });
    writeFileSync(path.join(binDir, 'tsc'), tsc === 'green'
      ? 'process.exit(0);\n'
      : [
        "console.log('cli/util-tools/agent-doctor.js(31,24): error TS7006: Parameter \\'a\\' implicitly has an \\'any\\' type.');",
        "console.log('cli/util-tools/agent-doctor.js(32,24): error TS7006: Parameter \\'b\\' implicitly has an \\'any\\' type.');",
        'process.exit(2);',
      ].join('\n'));
  }
  if (cliTest !== 'none') {
    const testDir = path.join(root, 'cli', 'test');
    mkdirSync(testDir, { recursive: true });
    writeFileSync(path.join(testDir, 'fixture.test.js'), [
      "import { test } from 'node:test';",
      "import assert from 'node:assert/strict';",
      `test('fixture case', () => { assert.equal(1, ${cliTest === 'green' ? '1' : '2'}); });`,
    ].join('\n'));
    writeFileSync(path.join(testDir, '..', 'package.json'), '{"type":"module"}');
  }
  return root;
}

test('TP-ci-guard-001: doc-only staged paths select no gates — the guard is a zero-cost no-op', () => {
  assert.deepEqual(selectGates(['SYSTEM.md', '.claude/CLAUDE.md', 'docs/architecture.md']), []);
  const r = runCiGuard({ root: makeFixture(), staged: ['SYSTEM.md'] });
  assert.equal(r.decision, 'skip');
  assert.deepEqual(r.ran, []);
  assert.equal(r.logMessage, '');
});

test('TP-ci-guard-002: gate selection follows the staged paths, fast gate first', () => {
  assert.deepEqual(selectGates(['cli/util/ciguard.js']), ['typecheck', 'cli-tests']);
  assert.deepEqual(selectGates(['server/server.js']), ['server-tests']);
  assert.deepEqual(selectGates(['tsconfig.json']), ['typecheck']);
  // Windows-style separators from git porcelain must resolve the same way.
  assert.deepEqual(selectGates(['cli\\util-tools\\agent-doctor.js']), ['typecheck', 'cli-tests']);
  // A lockfile/package.json change can break every suite — run them all.
  assert.deepEqual(selectGates(['package-lock.json']), ['typecheck', 'server-tests', 'cli-tests']);
  // Non-JS files under cli/ (e.g. the README) do not select a gate on their own.
  assert.deepEqual(selectGates(['cli/README.md']), []);
});

test('TP-ci-guard-003: a red typecheck REFUSES the push and names the failing errors', () => {
  const root = makeFixture({ tsc: 'red' });
  try {
    const r = runCiGuard({ root, staged: ['cli/util-tools/agent-doctor.js'], commitMessage: 'feat: x' });
    assert.equal(r.decision, 'refuse');
    assert.equal(r.failures.length, 1);
    assert.equal(r.failures[0].gate, 'typecheck');
    assert.match(r.failures[0].summary, /TS7006/);
    assert.match(r.logMessage, /REFUSED/);
    assert.match(r.logMessage, /commit withheld: feat: x/);
    // Fail-fast: the slow cli-tests gate is never reached once typecheck is red.
    assert.deepEqual(r.ran, ['typecheck']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('TP-ci-guard-004: warn mode LANDS the push and still records that main went red', () => {
  const root = makeFixture({ tsc: 'red' });
  try {
    const r = runCiGuard({ root, staged: ['cli/x.js'], mode: 'warn', commitMessage: 'chore: y' });
    assert.equal(r.decision, 'warn'); // ws.js commits+pushes on anything except 'refuse'
    assert.match(r.logMessage, /LANDED RED/);
    assert.match(r.logMessage, /TS7006/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('TP-ci-guard-005: an all-green tree passes and reports which gates ran', () => {
  const root = makeFixture({ tsc: 'green', cliTest: 'green' });
  try {
    const r = runCiGuard({ root, staged: ['cli/util/ciguard.js'] });
    assert.equal(r.decision, 'pass');
    assert.deepEqual(r.ran, ['typecheck', 'cli-tests']);
    assert.deepEqual(r.failures, []);
    assert.deepEqual(r.notes, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('TP-ci-guard-006: a gate that cannot run DEGRADES and still allows the push (no station lockout)', () => {
  const root = makeFixture({ tsc: 'missing' });
  try {
    const r = runCiGuard({ root, staged: ['cli/util/ciguard.js'] });
    assert.equal(r.decision, 'pass');
    assert.equal(r.ran.length, 0);
    assert.equal(r.notes.length, 2); // typecheck + cli-tests both unavailable here
    for (const n of r.notes) assert.match(n, /push allowed/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('TP-ci-guard-007: a failing test suite refuses and names the failing case', () => {
  const root = makeFixture({ tsc: 'green', cliTest: 'red' });
  try {
    const r = runCiGuard({ root, staged: ['cli/util/ciguard.js'] });
    assert.equal(r.decision, 'refuse');
    assert.equal(r.failures[0].gate, 'cli-tests');
    assert.match(r.failures[0].summary, /fixture case/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('TP-ci-guard-014: a gate that exits non-zero with NO recognisable diagnostics degrades, never blocks', () => {
  // The live case that forced this rule (proof run, 2026-07-28): the `typescript`
  // package present but its platform binary missing — tsc exits 1 with a Node
  // stack trace. Blocking on that would lock every station out of `ws sync`.
  const root = mkdtempSync(path.join(tmpdir(), 'ws-ciguard-'));
  try {
    const binDir = path.join(root, 'node_modules', 'typescript', 'bin');
    mkdirSync(binDir, { recursive: true });
    writeFileSync(path.join(binDir, 'tsc'),
      "console.error('Error: Unable to resolve @typescript/typescript-win32-x64');\nprocess.exit(1);\n");
    const r = runCiGuard({ root, staged: ['cli/x.js'] });
    assert.equal(r.decision, 'pass');
    assert.deepEqual(r.failures, []);
    assert.match(r.notes.join(' '), /toolchain problem, not a red repo/);
    assert.match(r.notes.join(' '), /push allowed/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// The windows-pc defect, 2026-08-17/18: the station shell exported FORCE_COLOR=3
// (Claude Code sets it), the spawned `node --test` colourised its output, and every
// anchored parser in the guard missed — so a RED suite came back as "no recognisable
// diagnostics (toolchain problem), push allowed". The guard silently stopped gating on
// the very station that syncs main directly. Both layers of the fix are pinned here.
test('TP-ci-guard-015: a colourised gate is still parsed — a red suite refuses even when the shell forces colour', () => {
  const root = makeFixture({ tsc: 'green', cliTest: 'red' });
  const prev = process.env.FORCE_COLOR;
  process.env.FORCE_COLOR = '3';
  try {
    const r = runCiGuard({ root, staged: ['cli/util/ciguard.js'] });
    assert.equal(r.decision, 'refuse');
    assert.equal(r.failures[0].gate, 'cli-tests');
    assert.match(r.failures[0].summary, /fixture case/);
    // The tally must survive too: a colour-blinded tally reads -1 and empties the
    // baseline, which is how plan-close quietly stops closing anything.
    assert.equal(r.suiteRuns.cli.fail, 1);
    assert.equal(r.notes.join(' '), '');
  } finally {
    if (prev === undefined) delete process.env.FORCE_COLOR; else process.env.FORCE_COLOR = prev;
    rmSync(root, { recursive: true, force: true });
  }
});

test('TP-ci-guard-016: failure parsing is colour-blind for every gate', () => {
  const esc = String.fromCharCode(27);
  const red = (/** @type {string} */ s) => `${esc}[31m${s}${esc}[39m`;
  assert.equal(failureHits('cli-tests', red('✖ fixture case (0.7ms)')).length, 1);
  assert.equal(failureHits('cli-tests', red('ℹ fail 3')).length, 1);
  assert.equal(failureHits('typecheck', red("a.js(1,2): error TS7006: implicitly any")).length, 1);
  assert.equal(failureHits('encoding', red('encoding violation: a.sh line 3')).length, 1);
  // Colour must not leak into the audit line either.
  assert.ok(!summarize('cli-tests', red('✖ fixture case')).includes(esc));
});

test('TP-ci-guard-017: gateCommand answers "can this station run this gate at all" — the env-doctor check reads it', () => {
  // env-doctor reports an ungated station as ungated (`ci-guard-gates`) by asking
  // exactly this, so the answer must be a plain runnable/not-runnable per gate.
  const armed = makeFixture({ tsc: 'green', cliTest: 'green' });
  const bare = makeFixture({ tsc: 'missing' });
  try {
    for (const g of ['typecheck', 'cli-tests']) assert.ok(gateCommand(armed, g), `${g} should be runnable`);
    for (const g of ['typecheck', 'cli-tests', 'server-tests']) assert.equal(gateCommand(bare, g), null);
  } finally {
    rmSync(armed, { recursive: true, force: true });
    rmSync(bare, { recursive: true, force: true });
  }
});

test('TP-ci-guard-008: summaries stay log-line sized (first 5 + a total)', () => {
  const many = Array.from({ length: 9 }, (_, i) => `f.js(${i},1): error TS7006: implicitly any`).join('\n');
  const s = summarize('typecheck', many);
  assert.match(s, /^9 failure\(s\):/);
  assert.match(s, /\+4 more$/);
  // Unrecognised output still says something rather than going silent.
  assert.match(summarize('typecheck', 'boom\nsegfault'), /segfault/);
  assert.equal(summarize('typecheck', ''), 'no diagnostic output');
});

test('TP-ci-guard-009: guardLogMessage is empty for non-events, loud for both failure modes', () => {
  assert.equal(guardLogMessage('pass', [], 'm'), '');
  assert.equal(guardLogMessage('skip', [], 'm'), '');
  assert.match(guardLogMessage('refuse', [{ gate: 'typecheck', summary: 's' }], 'm'), /nothing pushed/);
  assert.match(guardLogMessage('warn', [{ gate: 'typecheck', summary: 's' }], 'm'), /needs a fix commit/);
});

// ---- regression baseline integration (backlog 59) ------------------------------
// The guard reports against the DB-backed baseline (cli/util/baseline.js) but
// never gates on it. These cases pin exactly that: findings appear, decisions do not
// change, and a station with no baseline behaves as if the feature were not there.

/**
 * Make the fixture a real repo so a baseline commit can be genuinely known.
 * @param {string} root @returns {string} short HEAD sha
 */
function gitInit(root) {
  const run = (/** @type {string[]} */ a) => execFileSync('git', a, { cwd: root, stdio: 'ignore' });
  run(['init', '-q']);
  run(['config', 'user.email', 'a@b.c']);
  run(['config', 'user.name', 'test']);
  run(['commit', '-q', '--allow-empty', '-m', 'seed']);
  return execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
}

test('TP-baseline-019: with NO baseline the guard still passes and reports the ABSENT state', () => {
  const root = makeFixture({ cliTest: 'green' });
  try {
    const r = runCiGuard({ root, staged: ['cli/x.js'], baseline: null, today: '2026-07-28' });
    assert.equal(r.decision, 'pass');
    assert.equal(r.baselineVerdicts.length, 1);
    assert.equal(r.baselineVerdicts[0].state, 'absent');
    assert.equal(r.suiteRuns.cli.fail, 0);
    assert.ok(r.suiteRuns.cli.pass > 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('TP-baseline-020: a red suite is reported as a PROVEN regression against the last green commit', () => {
  const root = makeFixture({ cliTest: 'red' });
  try {
    const head = gitInit(root);
    const baseline = {
      repo: 'workspace',
      updated: '2026-07-28',
      suites: { cli: { commit: head, pass: 1, fail: 0, cases: [], date: '2026-07-28' } },
    };
    const r = runCiGuard({ root, staged: ['cli/x.js'], baseline, today: '2026-07-28', commitMessage: 'feat: x' });
    assert.equal(r.decision, 'refuse');
    assert.equal(r.baselineVerdicts[0].state, 'regressed');
    // The audit line carries the provenance — that is the whole point of the baseline.
    assert.match(r.logMessage, /regression vs baseline/);
    assert.match(r.logMessage, new RegExp(head));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('TP-baseline-021: a baseline finding NEVER blocks — a stale/dropped-count baseline still passes', () => {
  const root = makeFixture({ cliTest: 'green' });
  try {
    // Baseline claims far more passes than the fixture suite has, and is months old:
    // the commit is REAL, so the only reason it reads stale is its age.
    const head = gitInit(root);
    const baseline = {
      repo: 'workspace',
      updated: '2026-01-01',
      suites: { cli: { commit: head, pass: 9999, fail: 0, cases: ['TP-gone-001'], date: '2026-01-01' } },
    };
    const r = runCiGuard({ root, staged: ['cli/x.js'], baseline, today: '2026-07-28' });
    assert.equal(r.decision, 'pass'); // reporting only: the push is allowed
    assert.equal(r.baselineVerdicts[0].state, 'stale');
    assert.equal(r.baselineVerdicts[0].advisory, true);
    assert.equal(r.logMessage, '');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
