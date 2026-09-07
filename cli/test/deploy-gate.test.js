// TP-deploy-gate: the deploy.sh CI gate (backlog 80, ws plan get deploy-ci-gate-hardening).
//
// Two layers, matching what the gate actually is:
//  - the verdict snippet (embedded python3 in deploy.sh) is extracted VERBATIM from the
//    script and run against fixture check-runs JSON — including the real hub c4c93a0
//    incident shape (2026-08-28: `status: in_progress` + `conclusion: success`, a record
//    GitHub finished but never closed);
//  - the stall/deploy wiring runs the REAL deploy.sh under bash in a sandbox $HOME with a
//    stub `cli/ws.js` (records logapi calls), PATH shims for curl/docker, and a git clone
//    whose origin/main is one commit ahead with a controlled committer date.
// Cases skip themselves where python3/bash aren't usable; CI (ubuntu) always runs all.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, chmodSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEPLOY_SH = path.join(HERE, '..', '..', 'setup-scripts', 'deploy', 'deploy.sh');
const DEPLOY_SRC = readFileSync(DEPLOY_SH, 'utf8');

// --- the embedded verdict snippet, verbatim ---------------------------------------
const SNIPPET_MATCH = DEPLOY_SRC.match(/python3 -c '\n([\s\S]*?)\n'\)/);
const SNIPPET = SNIPPET_MATCH ? SNIPPET_MATCH[1] : null;

/** @returns {string} interpreter command, '' when none is available (cases skip) */
function findPython() {
  for (const cand of ['python3', 'python']) {
    try { execFileSync(cand, ['--version'], { stdio: 'pipe' }); return cand; } catch { /* next */ }
  }
  return '';
}
const PY = findPython();

/** @param {string} input @returns {string} */
function verdict(input) {
  return execFileSync(PY, ['-c', String(SNIPPET)], { input, encoding: 'utf8' }).trim();
}

/**
 * @param {string|null} name
 * @param {string} status
 * @param {string|null} conclusion
 */
const run = (name, status, conclusion) => ({ name, status, conclusion });
/** @param {...object} runs */
const payload = (...runs) => JSON.stringify({ total_count: runs.length, check_runs: runs });

test('snippet extraction: deploy.sh still carries exactly one embedded python3 verdict', () => {
  assert.ok(SNIPPET, 'python3 -c snippet not found in deploy.sh — update the test extractor');
});

test('TP-deploy-gate-001 all runs completed+success -> green', { skip: !PY }, () => {
  assert.equal(verdict(payload(run('ci', 'completed', 'success'), run('e2e', 'completed', 'success'))), 'green');
});

test('TP-deploy-gate-002 stuck record (in_progress + conclusion success, c4c93a0 shape) counts as completed -> green', { skip: !PY }, () => {
  assert.equal(verdict(payload(
    run('ci', 'completed', 'success'),
    run('case-id uniqueness', 'in_progress', 'success'),
  )), 'green');
});

test('TP-deploy-gate-003 stuck record with a failure conclusion -> failed, never pending', { skip: !PY }, () => {
  assert.equal(verdict(payload(
    run('ci', 'completed', 'success'),
    run('e2e', 'in_progress', 'failure'),
  )), 'failed');
});

test('TP-deploy-gate-004 conclusion-less runs mean pending, stuck names ride the verdict line', { skip: !PY }, () => {
  const out = verdict(payload(
    run('ci', 'completed', 'success'),
    run('case-id uniqueness', 'in_progress', null),
    run('build', 'queued', null),
  ));
  const [word, ...rest] = out.split(' ');
  assert.equal(word, 'pending');
  assert.equal(rest.join(' '), 'build,case-id uniqueness'); // sorted, comma-joined
  // a nameless run is still reported, not dropped
  const out2 = verdict(payload(run(null, 'queued', null)));
  assert.equal(out2, 'pending unnamed');
});

test('TP-deploy-gate-005 empty check_runs -> none (pre-CI branch intact)', { skip: !PY }, () => {
  assert.equal(verdict(payload()), 'none');
});

test('TP-deploy-gate-006 non-JSON API body -> api-error (gate waits)', { skip: !PY }, () => {
  assert.equal(verdict('<!DOCTYPE html>oops'), 'api-error');
});

test('TP-deploy-gate-007 completed failure -> failed; skipped/neutral alone -> green', { skip: !PY }, () => {
  assert.equal(verdict(payload(run('ci', 'completed', 'failure'))), 'failed');
  assert.equal(verdict(payload(run('lint', 'completed', 'skipped'), run('opt', 'completed', 'neutral'))), 'green');
});

// --- full-script sandbox ----------------------------------------------------------
/** @returns {string} bash command usable for the sandbox, '' when none (cases skip) */
function findBash() {
  // NOT Git's bin\bash.exe wrapper: it re-prepends Git's own dirs to PATH, which
  // defeats the sandbox's curl/docker shims (verified 2026-08-27).
  const cands = process.platform === 'win32'
    ? ['bash', 'C:\\Program Files\\Git\\usr\\bin\\bash.exe']
    : ['bash'];
  for (const cand of cands) {
    try {
      const ostype = execFileSync(cand, ['-c', 'echo $OSTYPE'], { stdio: 'pipe', encoding: 'utf8' }).trim();
      // On Windows only git-bash (msys/cygwin) shares the host filesystem view; WSL bash does not.
      if (process.platform !== 'win32' || /^(msys|cygwin)/.test(ostype)) return cand;
    } catch { /* next */ }
  }
  return '';
}
const BASH = findBash();
const SANDBOX_OK = Boolean(BASH && PY);

/**
 * @param {string} cwd
 * @param {Record<string, string|undefined>} env
 * @param {string} cmd
 * @param {string[]} args
 */
function sh(cwd, env, cmd, args) { execFileSync(cmd, args, { cwd, env, stdio: 'pipe' }); }

/**
 * Real deploy.sh needs: $HOME/agent/workspace/{.env,cli/ws.js} and $HOME/agent/hub/repo
 * one commit behind origin/main. curl/docker come from a PATH shim dir.
 * @param {{ageSec: number, fixture: string}} opts commit age of origin/main + check-runs JSON
 */
function makeSandbox({ ageSec, fixture }) {
  const root = mkdtempSync(path.join(tmpdir(), 'ws-deploygate-'));
  const ws = path.join(root, 'agent', 'workspace');
  mkdirSync(path.join(ws, 'cli'), { recursive: true });
  writeFileSync(path.join(ws, '.env'), 'GITHUB_TOKEN=test-token\nLOG_API_KEY=test-key\n');
  // logapi stub: append argv to $HOME/logapi.calls (CJS — sandbox has no package.json)
  writeFileSync(path.join(ws, 'cli', 'ws.js'), [
    "const fs = require('fs'), path = require('path');",
    "const home = path.resolve(__dirname, '..', '..', '..');",
    "fs.appendFileSync(path.join(home, 'logapi.calls'), JSON.stringify(process.argv.slice(2)) + '\\n');",
  ].join('\n'));
  const bin = path.join(root, 'bin');
  mkdirSync(bin);
  const fixtureFile = path.join(root, 'checks.json');
  writeFileSync(fixtureFile, fixture);
  writeFileSync(path.join(bin, 'curl'), '#!/bin/sh\ncat "$CHECKS_FIXTURE"\n');
  writeFileSync(path.join(bin, 'docker'), '#!/bin/sh\necho "$@" >> "$HOME/docker.calls"\nexit 0\n');
  chmodSync(path.join(bin, 'curl'), 0o755);
  chmodSync(path.join(bin, 'docker'), 0o755);

  const env = {
    ...process.env,
    HOME: root,
    PATH: bin + path.delimiter + process.env.PATH,
    CHECKS_FIXTURE: fixtureFile,
    LOG_API_URL: 'http://127.0.0.1:1',
    LOG_API_KEY: 'test-key',
    GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t',
  };

  // origin one commit ahead of the deploy clone; origin/main's committer date sets the age
  const origin = path.join(root, 'origin.git');
  const seed = path.join(root, 'seed');
  mkdirSync(seed);
  sh(root, env, 'git', ['init', '--bare', '-b', 'main', origin]);
  sh(seed, env, 'git', ['init', '-b', 'main']);
  writeFileSync(path.join(seed, 'f.txt'), 'v1\n');
  sh(seed, env, 'git', ['add', '.']);
  sh(seed, env, 'git', ['commit', '-m', 'c1']);
  writeFileSync(path.join(seed, 'f.txt'), 'v2\n');
  sh(seed, env, 'git', ['add', '.']);
  const when = new Date(Date.now() - ageSec * 1000).toISOString();
  sh(seed, { ...env, GIT_AUTHOR_DATE: when, GIT_COMMITTER_DATE: when }, 'git', ['commit', '-m', 'c2']);
  sh(seed, env, 'git', ['push', origin, 'main']);
  const repoDir = path.join(root, 'agent', 'hub', 'repo');
  mkdirSync(path.dirname(repoDir), { recursive: true });
  sh(root, env, 'git', ['clone', origin, repoDir]);
  sh(repoDir, env, 'git', ['reset', '--hard', 'HEAD~1']);
  const newSha = execFileSync('git', ['rev-parse', '--short', 'origin/main'], { cwd: repoDir, env, encoding: 'utf8' }).trim();

  return {
    root, env, newSha,
    run() {
      return execFileSync(BASH, [DEPLOY_SH, 'hub'], { env, encoding: 'utf8' });
    },
    logapiCalls() {
      const f = path.join(root, 'logapi.calls');
      if (!existsSync(f)) return [];
      return readFileSync(f, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    },
    dockerCalled() { return existsSync(path.join(root, 'docker.calls')); },
  };
}

const STUCK_GREEN = payload(run('ci', 'completed', 'success'), run('case-id uniqueness', 'in_progress', 'success'));
const CONCLUSIONLESS = payload(run('ci', 'completed', 'success'), run('case-id uniqueness', 'in_progress', null));

test('TP-deploy-gate-008 e2e: stuck-success record deploys (the c4c93a0 stall class, fixed)', { skip: !SANDBOX_OK }, () => {
  const sb = makeSandbox({ ageSec: 40 * 60, fixture: STUCK_GREEN });
  sb.run();
  assert.ok(sb.dockerCalled(), 'expected the pipeline to reach docker compose');
  const done = sb.logapiCalls().filter((c) => c.includes('done'));
  assert.equal(done.length, 1);
  assert.ok(done[0].join(' ').includes(sb.newSha));
});

test('TP-deploy-gate-009 e2e: pending past 30 min logs ONE blocked stall line (deduped), keeps waiting, never deploys', { skip: !SANDBOX_OK }, () => {
  const sb = makeSandbox({ ageSec: 40 * 60, fixture: CONCLUSIONLESS });
  sb.run(); // exit 0 or execFileSync throws
  sb.run(); // same commit again: dedupe via deploy.state
  const calls = sb.logapiCalls();
  assert.equal(calls.length, 1, `expected exactly one logapi line, got ${JSON.stringify(calls)}`);
  const msg = calls[0].join(' ');
  assert.ok(calls[0].includes('blocked'), `expected a blocked line, got ${msg}`);
  assert.ok(msg.includes(sb.newSha), 'stall line must name the commit');
  assert.ok(msg.includes('case-id uniqueness'), 'stall line must name the stuck check');
  assert.ok(!sb.dockerCalled(), 'a stall must never auto-deploy');
});

test('TP-deploy-gate-010 e2e: pending inside the 30-min window stays a quiet wait', { skip: !SANDBOX_OK }, () => {
  const sb = makeSandbox({ ageSec: 2 * 60, fixture: CONCLUSIONLESS });
  sb.run();
  assert.equal(sb.logapiCalls().length, 0);
  assert.ok(!sb.dockerCalled());
});
