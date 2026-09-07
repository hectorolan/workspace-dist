// TP-caseid (tool half): case-id-check duplicate detection under the suffix
// grammar and the test-title claim rule (plan `ws plan get test-plan-case-id-suffix`).
//
// The tool is a script, so every case spawns it against a throwaway fixture
// tree (and, for --refs, a throwaway git repo) and asserts on exit code +
// output — the same contract CI consumes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const TOOL = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'util-tools', 'case-id-check.js');

/** @param {Record<string, string>} files @returns {string} repo root */
function fixture(files) {
  const root = mkdtempSync(path.join(tmpdir(), 'ws-caseid-'));
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(root, rel);
    mkdirSync(path.dirname(full), { recursive: true });
    writeFileSync(full, content);
  }
  return root;
}

/** @param {string[]} args @returns {{code: number, out: string}} */
function run(args) {
  try {
    return { code: 0, out: execFileSync(process.execPath, [TOOL, ...args], { encoding: 'utf8' }) };
  } catch (/** @type {any} */ e) {
    return { code: e.status ?? 1, out: `${e.stdout || ''}${e.stderr || ''}` };
  }
}

test('TP-caseid-009: bare vs suffixed is DISTINCT, two titles claiming one bare ID still collide', () => {
  const dup = fixture({
    'e2e/a.spec.js': "test('TP-x-079 first claimant', () => {});\n",
    'e2e/b.spec.js': "test('TP-x-079 second claimant', () => {});\n",
  });
  const ok = fixture({
    'e2e/a.spec.js': "test('TP-x-079 first claimant', () => {});\n",
    'e2e/b.spec.js': "test('TP-x-079_2 second claimant, suffixed', () => {});\n",
  });
  try {
    const bad = run(['--repo', dup]);
    assert.equal(bad.code, 1);
    assert.match(bad.out, /TP-x-079 claimed in e2e\/a\.spec\.js\s+\+\s+e2e\/b\.spec\.js/);
    const good = run(['--repo', ok]);
    assert.equal(good.code, 0);
    assert.match(good.out, /no duplicate claims/);
  } finally {
    rmSync(dup, { recursive: true, force: true });
    rmSync(ok, { recursive: true, force: true });
  }
});

test('TP-caseid-010: an ID outside a test title is a REFERENCE even inside a spec file — never a collision', () => {
  const root = fixture({
    'e2e/a.spec.js': "test('TP-x-070 the real claimant', () => {});\n",
    // The 2026-08-02 false-duplicate shape: a comment citing the covering test.
    'e2e/b.spec.js': "// index rows — covered by TP-x-070 in a.spec.js.\ntest('TP-x-071 something else', () => {});\n",
    'e2e/fixtures/stub.js': "// fixture serving TP-x-070 and TP-x-071\n",
  });
  try {
    const r = run(['--repo', root, '--json']);
    assert.equal(r.code, 0);
    const data = JSON.parse(r.out);
    assert.deepEqual(data.duplicates, []);
    assert.equal(data.total, 2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('TP-caseid-011: --next counts a suffixed claim via its bare number; --refs classifies title-vs-reference on the ref side too', () => {
  const root = fixture({
    'e2e/a.spec.js': "test('TP-x-079_2 suffixed claimant', () => {});\n",
  });
  try {
    assert.equal(run(['--repo', root, '--next', 'TP-x']).out.trim(), 'TP-x-080');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }

  // --refs: a branch whose DIFFERENT file claims an ID main already claims is a
  // duplicate; a branch line merely REFERENCING it in a comment is not.
  const repo = mkdtempSync(path.join(tmpdir(), 'ws-caseid-git-'));
  const git = (/** @type {string[]} */ a) => execFileSync('git', ['-C', repo, ...a], { stdio: 'pipe' });
  try {
    git(['init', '-q', '-b', 'main']);
    git(['config', 'user.email', 'a@b.c']);
    git(['config', 'user.name', 't']);
    mkdirSync(path.join(repo, 'e2e'));
    writeFileSync(path.join(repo, 'e2e', 'a.spec.js'), "test('TP-x-050 on main', () => {});\n");
    git(['add', '.']);
    git(['commit', '-q', '-m', 'seed']);
    git(['checkout', '-q', '-b', 'feat']);
    writeFileSync(path.join(repo, 'e2e', 'b.spec.js'),
      "// see TP-x-050 in a.spec.js\ntest('TP-x-051 branch work', () => {});\n");
    git(['add', '.']);
    git(['commit', '-q', '-m', 'branch: reference only']);
    git(['checkout', '-q', 'main']);
    assert.equal(run(['--repo', repo, '--refs', 'feat']).code, 0, 'a comment on the branch must not collide');

    git(['checkout', '-q', 'feat']);
    writeFileSync(path.join(repo, 'e2e', 'b.spec.js'),
      "test('TP-x-050 branch claims it too', () => {});\n");
    git(['add', '.']);
    git(['commit', '-q', '-m', 'branch: real claim']);
    git(['checkout', '-q', 'main']);
    const r = run(['--repo', repo, '--refs', 'feat']);
    assert.equal(r.code, 1);
    assert.match(r.out, /TP-x-050 claimed in/);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('TP-caseid-013: suffix-rename supersede — the fix PR does not re-collide with the stale bare claim on the ref', () => {
  const repo = mkdtempSync(path.join(tmpdir(), 'ws-caseid-sup-'));
  const git = (/** @type {string[]} */ a) => execFileSync('git', ['-C', repo, ...a], { stdio: 'pipe' });
  try {
    git(['init', '-q', '-b', 'main']);
    git(['config', 'user.email', 'a@b.c']);
    git(['config', 'user.name', 't']);
    mkdirSync(path.join(repo, 'e2e'));
    // The merged collision: two files claiming one ID on main.
    writeFileSync(path.join(repo, 'e2e', 'a.spec.js'), "test('TP-x-060 first claimant', () => {});\n");
    writeFileSync(path.join(repo, 'e2e', 'b.spec.js'), "test('TP-x-060 second claimant', () => {});\n");
    git(['add', '.']);
    git(['commit', '-q', '-m', 'collision on main']);
    // The fix branch: second claimant suffixed.
    git(['checkout', '-q', '-b', 'fixit']);
    writeFileSync(path.join(repo, 'e2e', 'b.spec.js'), "test('TP-x-060_2 second claimant, suffixed', () => {});\n");
    git(['add', '.']);
    git(['commit', '-q', '-m', 'suffix the second claimant']);
    // From the fix branch, scanning against stale main: the rename supersedes
    // main's bare claim at the same path — the fix itself must scan clean.
    assert.equal(run(['--repo', repo, '--refs', 'main']).code, 0);
    // Control: on main itself (no rename in the tree) the collision still reads
    // loud — the supersede rule fires only for an in-flight rename.
    git(['checkout', '-q', 'main']);
    assert.equal(run(['--repo', repo]).code, 1, 'main alone still collides');
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('TP-caseid-014/TP-nsg-ip-mismatch-check-2026-08-26-017: a date-bearing plan slug keeps its full ID — no manufactured duplicate across files', () => {
  // Grammar owner: CASE_ID_SOURCE in util/baseline.js (greedy). A lazy series stopped at
  // the first numeric segment, so every case of a `...-2026-08-26-NNN` plan read as one
  // truncated ID and two files claiming cases 001/002 looked like a collision (2026-08-26).
  const dated = fixture({
    'test/a.test.js': "test('TP-nsg-ip-mismatch-check-2026-08-26-001: first case', () => {});\n",
    'test/b.test.js': "test('TP-nsg-ip-mismatch-check-2026-08-26-012: another case', () => {});\n",
  });
  const r = run(['--repo', dated, '--dirs', 'test', '--json']);
  assert.equal(r.code, 0, 'distinct cases of one dated plan must not read as duplicates');
  const data = JSON.parse(r.out);
  assert.equal(data.total, 2, 'two distinct IDs, not one collapsed one');
  assert.deepEqual(data.duplicates, []);
  assert.equal(run(['--repo', dated, '--dirs', 'test', '--next', 'TP-nsg-ip-mismatch-check-2026-08-26']).out.trim(), 'TP-nsg-ip-mismatch-check-2026-08-26-013');
});
