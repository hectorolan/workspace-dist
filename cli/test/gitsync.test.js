// TP-phase0: pullIfBehind against real throwaway git repos (see ws plan get test-plan-phase0-scaffold)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pullIfBehind, syncWorkspace } from '../util/gitsync.js';

/**
 * @param {string} dir
 * @param {string[]} args
 */
function git(dir, args) {
  return execFileSync('git', ['-C', dir, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

/** @param {string} dir */
function commit(dir) {
  writeFileSync(path.join(dir, 'f.txt'), String(Date.now() + Math.random()));
  git(dir, ['add', '.']);
  git(dir, [
    '-c', 'user.name=test', '-c', 'user.email=test@test',
    'commit', '-q', '-m', 'c',
  ]);
}

test('TP-phase0-001: non-git directory is a quiet no-git no-op', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'ws-nogit-'));
  try {
    assert.equal(pullIfBehind(dir), 'no-git');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * Bare origin + seeded work clone for syncWorkspace cases.
 * @param {string} root
 * @returns {{bare: string, work: string}}
 */
function makeOriginAndClone(root) {
  const bare = path.join(root, 'origin.git');
  const seed = path.join(root, 'seed');
  const work = path.join(root, 'work');
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', bare], { stdio: 'ignore' });
  execFileSync('git', ['clone', '-q', bare, seed], { stdio: 'ignore' });
  git(seed, ['config', 'user.email', 'test@test']);
  git(seed, ['config', 'user.name', 'test']);
  commit(seed);
  git(seed, ['push', '-q', '-u', 'origin', 'main']);
  execFileSync('git', ['clone', '-q', bare, work], { stdio: 'ignore' });
  git(work, ['config', 'user.email', 'test@test']);
  git(work, ['config', 'user.name', 'test']);
  return { bare, work };
}

test('TP-phase1-008/009 + TP-ws-sync-paths-003/005: default syncWorkspace pushes whole tree, lists staged, no warning single-area, then clean', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'ws-sync-'));
  try {
    const { bare, work } = makeOriginAndClone(root);

    writeFileSync(path.join(work, 'new.md'), 'content');
    const r = syncWorkspace(work, 'test: sync push');
    assert.equal(r.status, 'pushed');
    assert.deepEqual(r.staged, ['new.md']);
    assert.deepEqual(r.leftBehind, []);
    assert.equal(r.warning, null); // TP-ws-sync-paths-005: single area → no warning
    assert.equal(git(bare, ['rev-parse', 'main']), git(work, ['rev-parse', 'HEAD']));
    assert.match(git(work, ['log', '-1', '--format=%s']), /test: sync push/);

    assert.equal(syncWorkspace(work, 'test: nothing').status, 'clean');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('TP-ws-sync-paths-001/002: --paths commits only listed paths and reports every file left uncommitted', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'ws-sync-'));
  try {
    const { bare, work } = makeOriginAndClone(root);
    // f.txt is tracked (seed commit); modify it but do NOT include it in paths.
    writeFileSync(path.join(work, 'f.txt'), 'concurrent-session edit');
    writeFileSync(path.join(work, 'mine.md'), 'my file');
    writeFileSync(path.join(work, 'other.md'), 'untracked concurrent file');

    const r = syncWorkspace(work, 'test: scoped', { paths: ['mine.md'] });
    assert.equal(r.status, 'pushed');
    assert.deepEqual(r.staged, ['mine.md']);
    // TP-ws-sync-paths-002: modified-tracked AND untracked files both reported
    assert.deepEqual([...r.leftBehind].sort(), ['f.txt', 'other.md']);
    // the commit on origin contains ONLY mine.md
    const shown = git(bare, ['show', '--name-only', '--format=', 'main']);
    assert.deepEqual(shown.split('\n').filter(Boolean), ['mine.md']);
    // the other files are still dirty in the worktree, untouched
    // note: the test git() helper trims output, so the first line loses its
    // leading space — match loosely; the origin-commit assertion above already
    // proves f.txt was not committed.
    assert.match(git(work, ['status', '--porcelain']), /M f\.txt/);
    assert.match(git(work, ['status', '--porcelain']), /\?\? other\.md/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('TP-ws-sync-paths-004/009: default multi-area commit returns a warning naming the areas (root files = "(root)")', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'ws-sync-'));
  try {
    const { work } = makeOriginAndClone(root);
    mkdirSync(path.join(work, 'cli'));
    mkdirSync(path.join(work, 'server'));
    writeFileSync(path.join(work, 'cli', 'a.js'), 'a');
    writeFileSync(path.join(work, 'server', 'b.js'), 'b');
    writeFileSync(path.join(work, 'root.md'), 'r');

    const r = syncWorkspace(work, 'test: multi-area');
    assert.equal(r.status, 'pushed');
    assert.ok(r.warning, 'expected a multi-area warning');
    assert.match(r.warning, /WARNING/);
    assert.match(r.warning, /cli/);
    assert.match(r.warning, /server/);
    assert.match(r.warning, /\(root\)/); // TP-ws-sync-paths-009
    assert.match(r.warning, /--paths/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('TP-ws-sync-paths-004b: scoped multi-area commit does NOT warn (explicit scope)', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'ws-sync-'));
  try {
    const { work } = makeOriginAndClone(root);
    mkdirSync(path.join(work, 'cli'));
    mkdirSync(path.join(work, 'server'));
    writeFileSync(path.join(work, 'cli', 'a.js'), 'a');
    writeFileSync(path.join(work, 'server', 'b.js'), 'b');
    const r = syncWorkspace(work, 'test: scoped multi', { paths: ['cli', 'server'] });
    assert.equal(r.status, 'pushed');
    assert.equal(r.warning, null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('TP-ws-sync-paths-006: --paths pathspec matching nothing throws step=stage, nothing committed', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'ws-sync-'));
  try {
    const { work } = makeOriginAndClone(root);
    const head = git(work, ['rev-parse', 'HEAD']);
    writeFileSync(path.join(work, 'real.md'), 'x');
    assert.throws(
      () => syncWorkspace(work, 'test: typo', { paths: ['no-such-file.md'] }),
      (/** @type {Error & {step?: string}} */ e) => e.step === 'stage',
    );
    assert.equal(git(work, ['rev-parse', 'HEAD']), head); // no commit created
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('TP-ws-sync-paths-007: --paths naming an existing-but-unchanged file reports clean (and still lists left-behind files)', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'ws-sync-'));
  try {
    const { work } = makeOriginAndClone(root);
    const head = git(work, ['rev-parse', 'HEAD']);
    writeFileSync(path.join(work, 'dirty.md'), 'someone else');
    const r = syncWorkspace(work, 'test: noop', { paths: ['f.txt'] });
    assert.equal(r.status, 'clean');
    assert.deepEqual(r.leftBehind, ['dirty.md']);
    assert.equal(git(work, ['rev-parse', 'HEAD']), head);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('TP-ci-guard-010: a preflight refusal aborts before commit — nothing pushed, everything still staged', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'ws-sync-'));
  try {
    const { work } = makeOriginAndClone(root);
    const head = git(work, ['rev-parse', 'HEAD']);
    writeFileSync(path.join(work, 'new.md'), 'work in progress');
    /** @type {string[]} */
    let seen = [];
    const r = syncWorkspace(work, 'test: refused', {
      preflight: (staged) => { seen = staged; return { ok: false }; },
    });
    assert.equal(r.status, 'refused');
    assert.deepEqual(seen, ['new.md']); // the guard sees exactly what would land
    assert.equal(git(work, ['rev-parse', 'HEAD']), head); // no commit
    assert.deepEqual(git(work, ['diff', '--cached', '--name-only']).split('\n').filter(Boolean), ['new.md']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('TP-ci-guard-011: a passing preflight leaves the normal push path untouched', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'ws-sync-'));
  try {
    const { work } = makeOriginAndClone(root);
    writeFileSync(path.join(work, 'new.md'), 'ok');
    let called = 0;
    const r = syncWorkspace(work, 'test: allowed', { preflight: () => { called += 1; return { ok: true }; } });
    assert.equal(r.status, 'pushed');
    assert.equal(called, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('TP-ci-guard-012: a clean tree never invokes the guard (no gates run for an empty commit)', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'ws-sync-'));
  try {
    const { work } = makeOriginAndClone(root);
    let called = 0;
    const r = syncWorkspace(work, 'test: clean', { preflight: () => { called += 1; return { ok: true }; } });
    assert.equal(r.status, 'clean');
    assert.equal(called, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('TP-phase0-002/003: up-to-date clone, then pulls when origin/main is ahead', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'ws-git-'));
  try {
    const origin = path.join(root, 'origin');
    const work = path.join(root, 'work');
    execFileSync('git', ['init', '-q', '-b', 'main', origin], { stdio: 'ignore' });
    commit(origin);
    execFileSync('git', ['clone', '-q', origin, work], { stdio: 'ignore' });

    assert.equal(pullIfBehind(work), 'up-to-date');

    commit(origin);
    assert.equal(pullIfBehind(work), 'pulled');
    assert.equal(git(work, ['rev-parse', 'HEAD']), git(origin, ['rev-parse', 'HEAD']));

    assert.equal(pullIfBehind(work), 'up-to-date');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
