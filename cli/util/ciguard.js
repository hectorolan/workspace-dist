// ci-guard (backlog 58) — the pre-push CI gate for `ws sync` on the workspace repo.
//
// WHY: this repo syncs main-direct (CLAUDE.md sync rule 3), so there is no PR and
// no pre-merge gate — GitHub Actions only reports AFTER a push has landed. On
// 2026-07-28 main was already red (10 pre-existing TS7006 errors in
// cli/util-tools/agent-doctor.js) and nobody noticed, while all three stations
// pulled that red main every 15 minutes. This module runs the fast subset of CI
// against the tree that is about to be pushed and stops the push instead.
//
// SUBSET + TRADEOFF (deliberate, not silent): the encoding guard (util/encoding.js,
// in-process byte scan, sub-ms), typecheck (~1.5 s, the gate that was
// actually red), the server test suite (~3 s) and the cli test suite (~21 s), each
// only when the staged paths can affect it, fail-fast in that order. `npm run
// licenses` and `npm audit` are NOT run here: both need the network and are slow,
// and lockfile churn arrives overwhelmingly through Dependabot PRs, which DO get
// full pre-merge CI. Accepted gap: a hand-added dependency pushed directly can
// still land a red licenses/audit run — CI remains the backstop for that class.
//
// SCOPE CAVEAT: gates run against the WORKING TREE, not an isolated checkout of
// the commit. With `--paths` scoping, unstaged local files are still on disk, so a
// scoped commit can in principle land red because a local file masked the problem.
// Isolating would need a temp worktree per sync — not worth the seconds.
//
// REGRESSION BASELINE (backlog 59): the guard also tallies each test gate it runs
// and compares it against the repo's DB-backed baseline (util/baseline.js), so a
// refusal can say "these failures are NEW since <commit>" instead of leaving the
// "was it always like that?" question open. That comparison is REPORTING ONLY and
// never changes the decision — see runCiGuard's doc block for why.
//
// SAFETY (a broken guard must never lock every station out of `ws sync`): only a
// gate that RAN and exited non-zero blocks. Anything else — missing node_modules,
// missing tsc, spawn failure, timeout — degrades to a printed note and lets the
// push through. `ws sync --no-guard` is the explicit escape hatch, and it is logged
// as loudly as a refusal.
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { isEncodingCandidate, scanFiles, formatViolation } from './encoding.js';
import { tallyFromOutput, compareSuite, commitKnown } from './baseline.js';
import { stripAnsi, plainOutputEnv } from './ansi.js';

/** Default per-gate wall clock. A gate that blows this degrades, never blocks. */
const DEFAULT_TIMEOUT_MS = 300000;

/** @param {string} f @returns {string} repo-relative path, forward slashes */
const norm = (f) => f.replace(/\\/g, '/');

/** @param {string} f */
const isJs = (f) => /\.(m|c)?js$/.test(f);

/**
 * Which CI gates the staged paths can affect. Ordered fast → slow so a fail-fast
 * run spends the least time; each predicate mirrors what the gate actually reads.
 *
 * - encoding: shell scripts / PowerShell files / extensionless (shebang) scripts.
 *   In-process byte scan, sub-millisecond, so it runs first.
 * - typecheck: tsconfig.json `include` is `cli/**\/*.js` (plus the root package.json
 *   that pins @types/node and typescript).
 * - server tests: server/**.
 * - cli tests: cli/** — the suite also exercises util-tools and the CLI surface.
 *   The root lockfile/package.json feed both suites.
 * @param {string[]} staged repo-relative staged paths
 * @returns {string[]} gate names, in run order
 */
export function selectGates(staged) {
  const files = staged.map(norm);
  const rootDeps = files.some((f) => f === 'package.json' || f === 'package-lock.json');
  /** @type {string[]} */
  const gates = [];
  if (files.some(isEncodingCandidate)) gates.push('encoding');
  if (files.some((f) => (f.startsWith('cli/') && isJs(f)) || f === 'tsconfig.json') || rootDeps) {
    gates.push('typecheck');
  }
  if (files.some((f) => f.startsWith('server/') && (isJs(f) || f.endsWith('package.json'))) || rootDeps) {
    gates.push('server-tests');
  }
  if (files.some((f) => f.startsWith('cli/') && isJs(f)) || rootDeps) {
    gates.push('cli-tests');
  }
  return gates;
}

/** @param {string} dir @returns {string[]} absolute *.test.js paths, sorted */
function testFiles(dir) {
  try {
    return readdirSync(dir)
      .filter((f) => f.endsWith('.test.js'))
      .sort()
      .map((f) => path.join(dir, f));
  } catch {
    return [];
  }
}

/**
 * Which gate measures which regression-baseline suite (util/baseline.js). Only
 * test gates produce a pass/fail tally, so only these two feed a baseline.
 * @type {Record<string, string>}
 */
export const GATE_SUITE = { 'cli-tests': 'cli', 'server-tests': 'server' };

/** The reverse map, for callers that speak in suite names. @type {Record<string, string>} */
export const SUITE_GATE = { cli: 'cli-tests', server: 'server-tests' };

/**
 * Build the argv/cwd for a gate, or null when this station cannot run it (no
 * node_modules, no test files) — a null is a DEGRADE, never a failure.
 * @param {string} root
 * @param {string} gate
 * @returns {{argv: string[], cwd: string}|null}
 */
export function gateCommand(root, gate) {
  if (gate === 'typecheck') {
    // Invoke tsc's own JS entry directly: no npm/npx shell shim, so it behaves
    // identically on Windows and Linux and in a non-interactive scheduled shell.
    const tsc = path.join(root, 'node_modules', 'typescript', 'bin', 'tsc');
    return existsSync(tsc) ? { argv: [tsc], cwd: root } : null;
  }
  if (gate === 'cli-tests') {
    const files = testFiles(path.join(root, 'cli', 'test'));
    // Files are enumerated rather than glob-passed so the gate never depends on
    // the runner's glob support or on a shell being involved at all.
    return files.length ? { argv: ['--test', ...files], cwd: root } : null;
  }
  if (gate === 'server-tests') {
    const files = testFiles(path.join(root, 'server', 'test'));
    return files.length ? { argv: ['--test', ...files], cwd: path.join(root, 'server') } : null;
  }
  return null;
}

/**
 * @typedef {object} GateRun
 * @property {boolean} runnable false when this station cannot run the gate at all
 * @property {number|null} status exit code, or null when the process never reported one
 * @property {string} output combined stdout+stderr
 * @property {string} problem non-empty when the gate MALFUNCTIONED (never a red repo)
 */

/**
 * Run one gate as a child process and DESCRIBE what happened — it returns no
 * verdict, so the same execution path serves the push gate and the baseline
 * recorder (`cli/util-tools/test-baseline.js`). One owner for "how a suite is run".
 *
 * A gate must judge the repo, not the shell it was launched from: NODE_OPTIONS can
 * inject loaders/flags, NODE_TEST_CONTEXT makes a spawned `node --test` report
 * to a parent runner instead of exiting non-zero (observed: the guard's own test
 * suite saw a failing fixture suite as a pass), and FORCE_COLOR makes the child
 * wrap every line in ESC sequences that this module's anchored parsers cannot
 * match — a red suite then reads as "no recognisable diagnostics", i.e. a skipped
 * gate (windows-pc, 2026-08-18; see util/ansi.js for the full write-up).
 * @param {string} root
 * @param {string} gate
 * @param {{timeoutMs?: number}} [opts]
 * @returns {GateRun}
 */
export function runGate(root, gate, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const cmd = gateCommand(root, gate);
  if (!cmd) {
    return { runnable: false, status: null, output: '', problem: 'not runnable here (deps or test files missing)' };
  }
  const childEnv = { ...process.env, ...plainOutputEnv() };
  delete childEnv.NODE_OPTIONS;
  delete childEnv.NODE_TEST_CONTEXT;
  delete childEnv.COLORTERM;
  try {
    const out = execFileSync(process.execPath, cmd.argv, {
      cwd: cmd.cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: timeoutMs,
      maxBuffer: 16 * 1024 * 1024,
      env: childEnv,
    });
    return { runnable: true, status: 0, output: String(out || ''), problem: '' };
  } catch (e) {
    const err = /** @type {{status?: number, signal?: string, killed?: boolean, code?: string, stdout?: string, stderr?: string, message?: string}} */ (e);
    const output = `${err.stdout || ''}\n${err.stderr || ''}`;
    // Timeouts, spawn errors and buffer overruns are guard malfunctions, not a red
    // repo: they come back as a `problem`, and the caller degrades rather than blocks.
    if (err.killed || err.signal || typeof err.status !== 'number') {
      return { runnable: true, status: null, output, problem: `could not complete (${err.signal || err.code || err.message || 'unknown'})` };
    }
    return { runnable: true, status: err.status, output, problem: '' };
  }
}

/**
 * The lines in a gate's output that are RECOGNISABLE failures. Empty means the
 * gate exited non-zero without telling us about the code — a crashed toolchain,
 * not a red repo (proved live: a `typescript` package missing its platform binary
 * exits 1 with a Node stack trace and would otherwise have blocked every push).
 * That distinction is what keeps a malfunctioning gate from locking out a station.
 * @param {string} gate
 * @param {string} output
 * @returns {string[]}
 */
export function failureHits(gate, output) {
  // Colour first, anchors second: an ESC sequence in front of a line defeats every
  // pattern below, and a defeated pattern reads as "gate malfunctioned, push allowed".
  const lines = stripAnsi(output).split(/\r?\n/);
  // The encoding gate produces its own diagnostics (never file content), so a
  // recognisable hit is exactly the line shape util/encoding.js emits.
  if (gate === 'encoding') return lines.filter((l) => /^encoding violation: /.test(l.trim()));
  if (gate === 'typecheck') return lines.filter((l) => /error TS\d+/.test(l));
  // node --test prints failures as TAP (`not ok 3 - name`) or spec (`✖ name`)
  // depending on the reporter it picks, and both end with a `fail N` tally.
  const cases = lines.filter((l) => /^(not ok \d+|✖ )/.test(l.trim()));
  if (cases.length) return cases;
  return lines.filter((l) => /^[ℹ#]\s*fail [1-9]/.test(l.trim()));
}

/**
 * Condense a failed gate's output into the few lines worth carrying into a log
 * line: compiler errors / failing test names, capped.
 * @param {string} gate
 * @param {string} output
 * @returns {string}
 */
export function summarize(gate, output) {
  const hits = failureHits(gate, output);
  if (hits.length === 0) {
    const tail = stripAnsi(output).split(/\r?\n/).filter((l) => l.trim()).slice(-2).join(' | ');
    return tail || 'no diagnostic output';
  }
  const shown = hits.slice(0, 5).map((l) => l.trim());
  return `${hits.length} failure(s): ${shown.join(' | ')}${hits.length > 5 ? ` | +${hits.length - 5} more` : ''}`;
}

/**
 * @typedef {object} GuardResult
 * @property {'skip'|'pass'|'refuse'|'warn'} decision
 * @property {string[]} gates gates selected from the staged paths
 * @property {string[]} ran gates that actually executed
 * @property {{gate: string, summary: string}[]} failures
 * @property {string[]} notes degrade reasons (gate could not run — push allowed)
 * @property {number} ms wall clock spent in the guard
 * @property {string} logMessage the audit line for this outcome ('' when nothing to say)
 * @property {import('./baseline.js').SuiteVerdict[]} baselineVerdicts per-suite regression
 *   findings vs the DB baseline — REPORTING ONLY, they never change `decision`
 * @property {Record<string, {pass: number, fail: number, cases: string[]}>} suiteRuns
 *   tallies of the test gates that ran, keyed by baseline suite name (green ones are
 *   what the caller folds back into the baseline after a successful push)
 */

/**
 * Run the selected gates against the working tree. Synchronous on purpose: it is
 * called from `syncWorkspace`'s preflight hook, which owns pure-git mechanics and
 * must stay sync. The CALLER writes the audit line (ws.js) — this module decides.
 *
 * REGRESSION BASELINE (backlog 59): when the caller hands in the repo's baseline
 * (fetched from the DB via `ws plan` — see util/baseline.js), every test gate that
 * ran is compared against it and the findings come back in `baselineVerdicts`.
 * **They are reporting, never a gate.** A red suite is already blocked by the gate
 * itself; what the baseline adds is provenance — "this failure is NEW since
 * <commit>" instead of "was it always like that?". Conversely a pass-count drop
 * with zero failures is ambiguous (a test can be deliberately deleted), so it is
 * surfaced and never blocks. A missing/unfetchable baseline is the ABSENT state and
 * costs nothing, which is what keeps ci-guard's degradation rule intact: a check
 * that cannot run must never wedge a station's sync.
 *
 * @param {{root: string, staged: string[], mode?: 'refuse'|'warn', commitMessage?: string, timeoutMs?: number, baseline?: import('./baseline.js').Baseline|null, today?: string}} opts
 * @returns {GuardResult}
 */
export function runCiGuard({ root, staged, mode = 'refuse', commitMessage = '', timeoutMs = DEFAULT_TIMEOUT_MS, baseline = null, today = '' }) {
  const started = Date.now();
  const gates = selectGates(staged);
  /** @type {string[]} */
  const ran = [];
  /** @type {{gate: string, summary: string}[]} */
  const failures = [];
  /** @type {string[]} */
  const notes = [];

  /** @type {Record<string, {pass: number, fail: number, cases: string[]}>} */
  const suiteRuns = {};
  /** @type {import('./baseline.js').SuiteVerdict[]} */
  const baselineVerdicts = [];

  for (const gate of gates) {
    if (gate === 'encoding') {
      // In-process, no subprocess: a byte scan is orders of magnitude cheaper than a
      // spawn, and the whole point of this gate is that it costs nothing. Same
      // degradation contract as the spawned gates: only a definite, recognisable
      // violation blocks; anything that stops the scan from running is a note.
      try {
        const { violations, notes: scanNotes } = scanFiles(root, staged);
        for (const n of scanNotes) notes.push(`encoding: ${n}`);
        ran.push(gate);
        if (violations.length) {
          const out = violations.map(formatViolation).join('\n');
          failures.push({ gate, summary: summarize(gate, out) });
          break;
        }
      } catch (e) {
        notes.push(`encoding: could not complete (${e instanceof Error ? e.message : 'unknown'}) — gate skipped, push allowed`);
      }
      continue;
    }
    const r = runGate(root, gate, { timeoutMs });
    if (!r.runnable) {
      notes.push(`${gate}: ${r.problem} — gate skipped, push allowed`);
      continue;
    }
    // Only a gate that RAN and exited non-zero may block. Timeouts, spawn
    // errors and buffer overruns are guard malfunctions: degrade, never block.
    if (r.problem) {
      notes.push(`${gate}: ${r.problem} — gate skipped, push allowed`);
      continue;
    }
    if (r.status !== 0 && failureHits(gate, r.output).length === 0) {
      // Non-zero but nothing recognisable: the toolchain broke, the repo did not.
      notes.push(`${gate}: exited ${r.status} with no recognisable diagnostics (toolchain problem, not a red repo) — gate skipped, push allowed: ${summarize(gate, r.output)}`);
      continue;
    }
    ran.push(gate);
    // Baseline bookkeeping happens for a red gate too: that is precisely the run
    // whose failures we want to prove are NEW (or not) against the last green one.
    const suite = GATE_SUITE[gate];
    if (suite) {
      const tally = tallyFromOutput(r.output);
      if (tally.pass >= 0) {
        suiteRuns[suite] = tally;
        baselineVerdicts.push(compareSuite(baseline && baseline.suites ? baseline.suites[suite] : null, tally, {
          suite,
          today,
          commitKnown: baseline && baseline.suites && baseline.suites[suite]
            ? commitKnown(root, baseline.suites[suite].commit)
            : true,
        }));
      }
    }
    if (r.status !== 0) {
      failures.push({ gate, summary: summarize(gate, r.output) });
      break; // fail fast — the first red gate is enough to decide
    }
  }

  const ms = Date.now() - started;
  /** @type {'skip'|'pass'|'refuse'|'warn'} */
  const decision = gates.length === 0
    ? 'skip'
    : failures.length === 0 ? 'pass' : mode === 'warn' ? 'warn' : 'refuse';
  const regressions = baselineVerdicts.filter((v) => v.state === 'regressed');
  return {
    decision,
    gates,
    ran,
    failures,
    notes,
    ms,
    baselineVerdicts,
    suiteRuns,
    logMessage: guardLogMessage(decision, failures, commitMessage, regressions),
  };
}

/**
 * The one-line audit message for a guard outcome (loud, never silent — the
 * `self-restart` precedent in cli/util/selfrestart.js).
 * @param {string} decision
 * @param {{gate: string, summary: string}[]} failures
 * @param {string} commitMessage
 * @param {import('./baseline.js').SuiteVerdict[]} [regressions] proven-new failures
 * @returns {string}
 */
export function guardLogMessage(decision, failures, commitMessage, regressions = []) {
  if (decision !== 'refuse' && decision !== 'warn') return '';
  const detail = failures.map((f) => `${f.gate}: ${f.summary}`).join(' ;; ');
  // The baseline turns "the suite is red" into "these failures are NEW since
  // <commit>" — carry that into the audit line, it is the whole point of it.
  const prov = regressions.length ? ` [regression vs baseline: ${regressions.map((v) => v.detail).join(' ;; ')}]` : '';
  if (decision === 'refuse') {
    return `ws sync REFUSED — pre-push CI gate failed, nothing pushed (main stays green): ${detail}${prov} [commit withheld: ${commitMessage}]`;
  }
  return `ws sync LANDED RED — pre-push CI gate failed but warn mode let the push through, main is now red and needs a fix commit: ${detail}${prov} [commit: ${commitMessage}]`;
}
