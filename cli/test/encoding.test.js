// TP-encoding-guard: the script-encoding guard (plan `environment-setup-streamlining`
// W2, ws plan get test-plan-encoding-guard).
//
// The two directions under test are opposites, and getting them backwards is the whole
// hazard, so every case names which direction it covers:
//   direction 1 - a BOM in a shell script (leaked a token on 2026-07-28);
//   direction 2 - a non-ASCII byte in a .ps1 read as ANSI by PowerShell 5.1.
//
// Fixtures are built as raw byte buffers with \u escapes so this test file itself
// stays pure ASCII and BOM-free, exactly as the guard requires of the files it checks.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  scanBuffer,
  scanFiles,
  isEncodingCandidate,
  isShellScript,
  isPowerShellFile,
  formatViolation,
} from '../util/encoding.js';
import { selectGates, runCiGuard, failureHits } from '../util/ciguard.js';

const BOM = Buffer.from([0xef, 0xbb, 0xbf]);
/** @param {string} s @returns {Buffer} */
const utf8 = (s) => Buffer.from(s, 'utf8');
/** @param {...(Buffer|string)} parts */
const bytes = (...parts) => Buffer.concat(parts.map((p) => (typeof p === 'string' ? utf8(p) : p)));

/** A line that looks like the one the 2026-07-28 incident echoed. Built by
 * concatenation so this file itself never carries a token-shaped literal on one
 * line (the distribution secret scan covers shipped test files — Phase 3 scrub). */
const SECRETISH_LINE = 'GITHUB_TOKEN=' + ['ghp', 'examplenotarealtoken0000000000'].join('_') + '\n';

/** @param {Record<string, Buffer>} files @returns {string} fixture root */
function makeRepo(files) {
  const root = mkdtempSync(path.join(tmpdir(), 'ws-encoding-'));
  for (const [rel, buf] of Object.entries(files)) {
    const abs = path.join(root, rel);
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, buf);
  }
  return root;
}

test('TP-encoding-guard-001: direction 1 - a UTF-8 BOM in a .sh is a violation at byte 0', () => {
  const v = scanBuffer('setup-scripts/deploy/deploy.sh', bytes(BOM, '#!/bin/bash\n', SECRETISH_LINE));
  assert.equal(v.length, 1);
  assert.equal(v[0].rule, 'bom-in-shell-script');
  assert.equal(v[0].offset, 0);
  assert.equal(v[0].line, 1);
  assert.equal(v[0].file, 'setup-scripts/deploy/deploy.sh');
});

test('TP-encoding-guard-002: direction 1 does NOT fire on a clean shell script, even a UTF-8 one', () => {
  // bash handles UTF-8 content fine - only the mark is fatal. Applying the .ps1
  // ASCII rule here would be the exact inversion this guard must never make.
  assert.deepEqual(scanBuffer('server/start.sh', utf8('#!/bin/sh\necho "caf\u00e9 \u2014 ok"\n')), []);
  assert.deepEqual(scanBuffer('setup-scripts/vm-setup.sh', utf8('#!/bin/bash\nset -euo pipefail\n')), []);
});

test('TP-encoding-guard-003: direction 1 covers extensionless shebang scripts, and only those', () => {
  const shebang = bytes(BOM, '#!/usr/bin/env bash\necho hi\n');
  assert.equal(isShellScript('hooks/pre-commit', shebang), true);
  assert.equal(scanBuffer('hooks/pre-commit', shebang)[0].rule, 'bom-in-shell-script');
  // An extensionless file that is not a shell script is read and cleared, not flagged.
  assert.deepEqual(scanBuffer('Dockerfile', bytes(BOM, 'FROM node:24\n')), []);
});

test('TP-encoding-guard-004: direction 1 also catches a UTF-16 mark (worse, same failure)', () => {
  const v = scanBuffer('x.sh', Buffer.concat([Buffer.from([0xff, 0xfe]), utf8('#!/bin/sh\n')]));
  assert.equal(v.length, 1);
  assert.equal(v[0].rule, 'bom-in-shell-script');
});

test('TP-encoding-guard-005: direction 2 - a non-ASCII byte in a .ps1 is a violation with offset, line and count', () => {
  // An em dash inside a string: PowerShell 5.1 decodes it as cp1252 smart quotes and
  // stops parsing (register-pull-task.ps1, 2026-07-28).
  const buf = utf8('param()\nWrite-Host "registered \u2014 ok"\n');
  const v = scanBuffer('setup-scripts/windows/register-pull-task.ps1', buf);
  assert.equal(v.length, 1);
  assert.equal(v[0].rule, 'non-ascii-in-powershell');
  assert.equal(v[0].line, 2);
  assert.equal(v[0].count, 3); // one em dash = 3 UTF-8 bytes
  assert.equal(buf[v[0].offset] > 0x7f, true); // the offset points at the first bad byte
  // Same rule for the module/manifest extensions.
  assert.equal(scanBuffer('a.psm1', utf8('\u00e9')).length, 1);
  assert.equal(scanBuffer('a.psd1', utf8('\u00e9')).length, 1);
});

test('TP-encoding-guard-006: direction 2 - pure-ASCII .ps1 passes, and the BOM rule is never applied to it', () => {
  assert.deepEqual(scanBuffer('ok.ps1', utf8('param([string]$Path)\nWrite-Host "done - ok"\n')), []);
  // A BOM in a .ps1 is reported under the PowerShell rule (the documented manual
  // standard is "zero bytes > 127"), never as a shell-script BOM.
  const v = scanBuffer('bom.ps1', bytes(BOM, 'param()\n'));
  assert.equal(v.length, 1);
  assert.equal(v[0].rule, 'non-ascii-in-powershell');
  assert.equal(v[0].offset, 0);
});

test('TP-encoding-guard-007: candidate selection is extension-scoped, so a doc-only sync scans nothing', () => {
  assert.equal(isEncodingCandidate('setup-scripts/deploy/deploy.sh'), true);
  assert.equal(isEncodingCandidate('setup-scripts/windows/register-pull-task.ps1'), true);
  assert.equal(isEncodingCandidate('Dockerfile'), true);
  assert.equal(isEncodingCandidate('SYSTEM.md'), false);
  assert.equal(isEncodingCandidate('cli/util/encoding.js'), false);
  assert.equal(isEncodingCandidate('package-lock.json'), false);
  assert.equal(isEncodingCandidate('.gitignore'), false);
  // Windows-style separators from git porcelain resolve identically.
  assert.equal(isEncodingCandidate('setup-scripts\\windows\\x.ps1'), true);
  assert.equal(isPowerShellFile('X.PS1'), true);
});

test('TP-encoding-guard-008: a finding NEVER carries the offending line - only path, offset, line, rule', () => {
  // The original incident was a credential printed by an error message that echoed
  // the expanded line. This is the case that must never regress.
  const root = makeRepo({ 'bad.sh': bytes(BOM, SECRETISH_LINE) });
  try {
    const { violations } = scanFiles(root, ['bad.sh']);
    const rendered = violations.map(formatViolation).join('\n');
    assert.equal(rendered.includes('ghp_'), false);
    assert.equal(rendered.includes('GITHUB_TOKEN'), false);
    assert.match(rendered, /^encoding violation: bad\.sh - bom-in-shell-script at byte 0 \(line 1, 3 offending byte\(s\)\)/);
    // The whole JSON payload the tool can emit is equally content-free.
    assert.equal(JSON.stringify(violations).includes('ghp_'), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('TP-encoding-guard-009: ci-guard selects `encoding` first and REFUSES both directions', () => {
  assert.deepEqual(selectGates(['setup-scripts/deploy/deploy.sh']), ['encoding']);
  assert.deepEqual(selectGates(['SYSTEM.md']), []);
  // encoding runs before typecheck/cli-tests: cheapest gate first.
  assert.deepEqual(selectGates(['x.ps1', 'cli/util/encoding.js']), ['encoding', 'typecheck', 'cli-tests']);

  for (const [rel, buf, rule] of /** @type {[string, Buffer, string][]} */ ([
    ['deploy.sh', bytes(BOM, '#!/bin/bash\n', SECRETISH_LINE), 'bom-in-shell-script'],
    ['reg.ps1', utf8('Write-Host "a \u2014 b"\n'), 'non-ascii-in-powershell'],
  ])) {
    const root = makeRepo({ [rel]: buf });
    try {
      const r = runCiGuard({ root, staged: [rel], commitMessage: 'feat: x' });
      assert.equal(r.decision, 'refuse');
      assert.deepEqual(r.ran, ['encoding']);
      assert.equal(r.failures.length, 1);
      assert.equal(r.failures[0].gate, 'encoding');
      assert.match(r.failures[0].summary, new RegExp(rule));
      assert.equal(r.failures[0].summary.includes('ghp_'), false);
      assert.match(r.logMessage, /REFUSED/);
      assert.equal(failureHits('encoding', formatViolation(scanBuffer(rel, buf)[0])).length, 1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test('TP-encoding-guard-010: a guard that cannot judge a file DEGRADES - it never blocks the push', () => {
  const root = makeRepo({ 'ok.sh': utf8('#!/bin/sh\ntrue\n') });
  try {
    // A staged DELETION (path no longer on disk) is unjudgeable, not a violation.
    const r = runCiGuard({ root, staged: ['ok.sh', 'gone.sh', 'gone.ps1'] });
    assert.equal(r.decision, 'pass');
    assert.deepEqual(r.ran, ['encoding']);
    assert.deepEqual(r.failures, []);
    assert.equal(r.logMessage, '');
    // A directory that happens to match a candidate name is skipped, not read.
    mkdirSync(path.join(root, 'weird.ps1'));
    assert.deepEqual(scanFiles(root, ['weird.ps1']).violations, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('TP-encoding-guard-011: nothing outside the two rules is ever a violation', () => {
  const root = makeRepo({
    'README.md': utf8('# title \u2014 dash\n'),
    'cli/x.js': utf8('// \u2014 dash\n'),
    'run.cmd': utf8('@echo off\n'),
  });
  try {
    const { violations, scanned } = scanFiles(root, ['README.md', 'cli/x.js', 'run.cmd']);
    assert.deepEqual(violations, []);
    assert.equal(scanned, 0); // none of them is even a candidate to read
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
