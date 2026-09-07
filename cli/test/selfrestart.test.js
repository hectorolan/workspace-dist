// TP-ssr: self-restart flag flow — pulled-change detection, syntax gate, marker
// (see ws plan get test-plan-scheduler-self-restart). Case IDs in test names.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

// apiclient freezes LOG_API_URL at import time — point it at a dead port BEFORE
// the module graph loads, so scripted log lines land in the offline fallback file
// where the tests can assert them.
process.env.LOG_API_URL = 'http://127.0.0.1:1';
const { isTriggerPath, flagRestartIfNeeded, checkFiles, markerPath, consumeMarker, markerExists, stampState } =
  await import('../util/selfrestart.js');

/** @param {string} dir @param {string[]} args */
const g = (dir, args) =>
  execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

/** @param {string} dir */
function initRepo(dir) {
  g(dir, ['init', '-q', '-b', 'main']);
  g(dir, ['config', 'user.email', 't@t.test']);
  g(dir, ['config', 'user.name', 't']);
  g(dir, ['config', 'commit.gpgsign', 'false']);
}

/** @param {string} dir @param {Record<string, string>} files @returns {string} head sha */
function commit(dir, files, msg = 'c') {
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(dir, rel);
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, content, 'utf8');
  }
  g(dir, ['add', '-A']);
  g(dir, ['commit', '-q', '-m', msg]);
  return g(dir, ['rev-parse', 'HEAD']);
}

/** Fixture: temp git repo + temp WS_DATA_DIR; restores env afterwards. @param {(ctx: {root: string, data: string}) => Promise<void>} fn */
async function withFixture(fn) {
  const root = mkdtempSync(path.join(tmpdir(), 'ws-ssr-repo-'));
  const data = mkdtempSync(path.join(tmpdir(), 'ws-ssr-data-'));
  const prev = process.env.WS_DATA_DIR;
  process.env.WS_DATA_DIR = data;
  try {
    initRepo(root);
    await fn({ root, data });
  } finally {
    if (prev === undefined) delete process.env.WS_DATA_DIR;
    else process.env.WS_DATA_DIR = prev;
    rmSync(root, { recursive: true, force: true });
    rmSync(data, { recursive: true, force: true });
  }
}

const statePathIn = (/** @type {string} */ data) => path.join(data, 'restart', 'last-checked');

test('TP-ssr-001: trigger filter matches the restart set and nothing else', () => {
  for (const f of ['server/server.js', 'server/lib/db.js', 'cli/util/scheduler.js', 'configs/jobs/jobs.json', 'package-lock.json', 'cli\\util\\scheduler.js']) {
    assert.ok(isTriggerPath(f), `${f} should trigger`);
  }
  for (const f of ['docs/architecture.md', 'cli/util/prwatch.js', 'cli/ws.js', '.claude/agents/implementer.md', 'configs/environments.json', 'cli/package-lock.json']) {
    assert.ok(!isTriggerPath(f), `${f} should NOT trigger`);
  }
});

// Fixture files declare their module type like the real repo does (cli and server
// both have a nearest package.json): without one, `node --check` treats detected-ESM
// sources as unparseable-but-passing (observed Node 24) and the gate goes blind.
const ESM_PKG = { 'package.json': '{"type":"module"}\n' };

test('TP-ssr-002/009: first run initializes the baseline; a valid trigger change flags the marker', async () => {
  await withFixture(async ({ root, data }) => {
    const head1 = commit(root, { ...ESM_PKG, 'server/app.js': 'export const ok = 1;\n' });
    let r = await flagRestartIfNeeded({ root, env: {} });
    assert.equal(r.status, 'initialized');
    assert.ok(!markerExists(), 'initialization must not flag a restart');
    assert.equal(readFileSync(statePathIn(data), 'utf8').trim(), head1);

    const head2 = commit(root, { 'server/app.js': 'export const ok = 2;\n' });
    r = await flagRestartIfNeeded({ root, env: {} });
    assert.equal(r.status, 'flagged');
    assert.match(String(r.detail), /server\/app\.js/);
    assert.ok(markerExists(), 'marker missing after a valid trigger change');
    assert.match(readFileSync(markerPath(), 'utf8'), /server\/app\.js/);
    assert.equal(readFileSync(statePathIn(data), 'utf8').trim(), head2);
  });
});

test('TP-ssr-003: broken .js push → check-failed, NO marker, state advanced, loud failed line in the fallback', async () => {
  await withFixture(async ({ root, data }) => {
    commit(root, { ...ESM_PKG, 'server/app.js': 'export const ok = 1;\n' });
    await flagRestartIfNeeded({ root, env: {} });
    const head2 = commit(root, { 'server/app.js': 'export const broken = {\n' });
    const r = await flagRestartIfNeeded({ root, env: {} });
    assert.equal(r.status, 'check-failed');
    assert.match(String(r.failures?.[0]), /server\/app\.js/);
    assert.ok(!markerExists(), 'a broken push must never flag a restart');
    assert.equal(readFileSync(statePathIn(data), 'utf8').trim(), head2, 'state must advance so the fix re-triggers once');
    const fallback = path.join(data, 'fallback', 'log.md');
    assert.ok(existsSync(fallback), 'failed line missing from offline fallback');
    assert.match(readFileSync(fallback, 'utf8'), /scheduler \| failed \| pulled change .* REFUSED/);
    // Re-run on the same HEAD: unchanged, no second failed line (advance-once contract).
    assert.equal((await flagRestartIfNeeded({ root, env: {} })).status, 'unchanged');
  });
});

test('TP-ssr-004/005: jobs.json gate — invalid JSON and invalid cron pattern refuse; valid config flags', async () => {
  await withFixture(async ({ root }) => {
    commit(root, { 'configs/jobs/jobs.json': JSON.stringify({ timezone: 'UTC', jobs: [{ name: 'ok', cron: '0 7 * * *', run: 'ws pull' }] }) });
    await flagRestartIfNeeded({ root, env: {} });

    commit(root, { 'configs/jobs/jobs.json': JSON.stringify({ timezone: 'UTC', jobs: [{ name: 'ok', cron: '30 3 * * *', run: 'ws backup' }] }) });
    let r = await flagRestartIfNeeded({ root, env: {} });
    assert.equal(r.status, 'flagged', 'a valid jobs.json change must flag');
    consumeMarker();

    commit(root, { 'configs/jobs/jobs.json': '{ not json' });
    r = await flagRestartIfNeeded({ root, env: {} });
    assert.equal(r.status, 'check-failed', 'invalid JSON must refuse');
    assert.ok(!markerExists());

    commit(root, { 'configs/jobs/jobs.json': JSON.stringify({ jobs: [{ name: 'bad', cron: 'not a cron at all', run: 'ws pull' }] }) });
    r = await flagRestartIfNeeded({ root, env: {} });
    assert.equal(r.status, 'check-failed', 'invalid cron pattern must refuse (boot-loop guard)');
    assert.ok(!markerExists());

    // disabled jobs are exempt from pattern validation (never armed at boot)
    commit(root, { 'configs/jobs/jobs.json': JSON.stringify({ jobs: [{ name: 'staged', cron: 'not a cron', run: 'ws pull', disabled: true }] }) });
    r = await flagRestartIfNeeded({ root, env: {} });
    assert.equal(r.status, 'flagged');
  });
});

test('TP-ssr-006: lockfile-only change flags without checking unchanged (even broken) files', async () => {
  await withFixture(async ({ root }) => {
    commit(root, { ...ESM_PKG, 'package-lock.json': '{"v":1}', 'server/broken.js': 'const oops = {\n' });
    await flagRestartIfNeeded({ root, env: {} }); // baseline includes the pre-existing broken file
    commit(root, { 'package-lock.json': '{"v":2}' });
    const r = await flagRestartIfNeeded({ root, env: {} });
    assert.equal(r.status, 'flagged', 'only CHANGED files are gated — unchanged ones are already running');
    assert.match(String(r.detail), /package-lock\.json/);
  });
});

test('TP-ssr-007/008: non-trigger changes advance quietly; same HEAD is unchanged', async () => {
  await withFixture(async ({ root, data }) => {
    commit(root, { 'docs/x.md': 'a' });
    await flagRestartIfNeeded({ root, env: {} });
    const head2 = commit(root, { 'docs/x.md': 'b', 'cli/util/prwatch.js': 'export const x = 1;\n' });
    let r = await flagRestartIfNeeded({ root, env: {} });
    assert.equal(r.status, 'no-relevant-changes');
    assert.ok(!markerExists());
    assert.equal(readFileSync(statePathIn(data), 'utf8').trim(), head2);
    r = await flagRestartIfNeeded({ root, env: {} });
    assert.equal(r.status, 'unchanged');
  });
});

test('TP-ssr-010: non-owner environment is inert — no state, no marker, no checks', async () => {
  await withFixture(async ({ root, data }) => {
    commit(root, { 'configs/environments.json': JSON.stringify({ scheduleOwner: 'azure-vm' }), 'server/app.js': 'ok\n' });
    const r = await flagRestartIfNeeded({ root, env: { WS_ENV: 'windows-pc' } });
    assert.equal(r.status, 'not-owner');
    assert.ok(!existsSync(statePathIn(data)), 'non-owner must not write state');
    assert.ok(!markerExists());
    // the owner itself proceeds normally
    assert.equal((await flagRestartIfNeeded({ root, env: { WS_ENV: 'azure-vm' } })).status, 'initialized');
  });
});

test('TP-ssr-011: unknown baseline (history rewrite) → conservative flag via canonical entries', async () => {
  await withFixture(async ({ root, data }) => {
    commit(root, { 'docs/x.md': 'a' });
    mkdirSync(path.dirname(statePathIn(data)), { recursive: true });
    writeFileSync(statePathIn(data), 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef', 'utf8');
    const r = await flagRestartIfNeeded({ root, env: {} });
    assert.equal(r.status, 'flagged');
    assert.match(String(r.detail), /baseline unknown/);
    assert.ok(markerExists());
  });
});

test('TP-ssr-015 (module half): stampState writes HEAD in a git repo, silently no-ops elsewhere', async () => {
  await withFixture(async ({ root, data }) => {
    const head = commit(root, { 'a.txt': 'x' });
    stampState(root);
    assert.equal(readFileSync(statePathIn(data), 'utf8').trim(), head);
    rmSync(statePathIn(data));
    stampState(mkdtempSync(path.join(tmpdir(), 'ws-ssr-nogit-'))); // must not throw
    assert.ok(!existsSync(statePathIn(data)), 'non-git root must not write state');
  });
});

test('TP-ssr checkFiles: deleted trigger file is not checkable but does not fail the gate', async () => {
  await withFixture(async ({ root }) => {
    const failures = await checkFiles(root, ['server/gone.js']);
    assert.deepEqual(failures, []);
  });
});
