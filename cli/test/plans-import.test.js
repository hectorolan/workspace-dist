// TP-plans-db: plans-import derivation helpers (see ws plan get test-plan-plans-db)
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { deriveSlug, deriveTitle, planFiles } from '../util-tools/plans-import.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const WS = path.join(ROOT, 'cli', 'ws.js');
const SERVER = path.join(ROOT, 'server', 'server.js');
const PORT = 17790 + Math.floor(Math.random() * 900);
const KEY = 'test-key-plans-import';

/** @type {import('node:child_process').ChildProcess} */
let server;
/** @type {string} */
let srvDir;

/** @param {string[]} args @param {Record<string, string>} [env] */
function ws(args, env = {}) {
  return spawnSync(process.execPath, [WS, ...args], {
    encoding: 'utf8',
    env: { ...process.env, LOG_API_URL: `http://127.0.0.1:${PORT}`, LOG_API_KEY: KEY, ...env },
  });
}

before(async () => {
  srvDir = fs.mkdtempSync(path.join(os.tmpdir(), 'plans-import-srv-'));
  server = spawn(process.execPath, [SERVER], {
    env: { ...process.env, LOG_DB_PATH: path.join(srvDir, 'logs.db'), LOG_API_PORT: String(PORT), LOG_API_HOST: '127.0.0.1', LOG_API_KEY: KEY },
    stdio: 'ignore',
  });
  for (let i = 0; i < 50; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/health`, { headers: { 'X-Api-Key': KEY } });
      if (res.ok) return;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('api server did not come up');
});

after(async () => {
  if (server && server.exitCode === null) {
    const exited = new Promise((r) => server.once('exit', r));
    server.kill();
    await exited;
  }
  try { fs.rmSync(srvDir, { recursive: true, force: true }); } catch { /* best effort on Windows */ }
});

test('TP-plans-db-020: slug derivation strips .md, leading date, trailing -plan', () => {
  assert.equal(deriveSlug('2026-07-20-ai-ops-product-definition.md'), 'ai-ops-product-definition');
  assert.equal(deriveSlug('mobile-nexus-plan.md'), 'mobile-nexus');
  assert.equal(deriveSlug('income-pipeline.md'), 'income-pipeline');
  assert.equal(deriveSlug('backlog.md'), 'backlog');
  assert.equal(deriveSlug('plans-db-design.md'), 'plans-db-design');
});

test('TP-plans-db-021: title from first # heading, fallback to slug', () => {
  assert.equal(deriveTitle('intro\n\n# The Real Title\n\n## Sub', 'x'), 'The Real Title');
  assert.equal(deriveTitle('## only subheadings here', 'my-slug'), 'my-slug');
  assert.equal(deriveTitle('', 'my-slug'), 'my-slug');
});

test('TP-plans-db-022: file discovery excludes README.md and non-md files', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plans-import-test-'));
  for (const f of ['a-plan.md', 'README.md', 'notes.txt', 'b.md']) {
    fs.writeFileSync(path.join(dir, f), 'x', 'utf8');
  }
  assert.deepEqual(planFiles(dir), ['a-plan.md', 'b.md']);
});

// Relocated from the retired migration-tool test suite (those tools are deleted).
// Self-contained here: seed the plans via `ws plan set` rather than depending on a
// prior migration test having imported them.
test('TP-logs-retirement-003: ws plan list --kind filters by kind', () => {
  let r = ws(['plan', 'set', 'test-plan-phase0-scaffold', '--title', 'Phase 0 scaffold',
    '--body', '# Phase 0 scaffold\n\nCases: TP-x-001.', '--kind', 'test-plan', '--status', 'done']);
  assert.equal(r.status, 0, r.stderr);
  r = ws(['plan', 'set', 'digest-rolling-summary', '--title', 'Rolling summary',
    '--body', 'Last digest: 2026-07-20.', '--kind', 'doc']);
  assert.equal(r.status, 0, r.stderr);

  const list = ws(['plan', 'list', '--kind', 'test-plan']);
  assert.equal(list.status, 0, list.stderr);
  assert.match(list.stdout, /test-plan-phase0-scaffold \| test-plan \| done \|/);
  assert.doesNotMatch(list.stdout, /digest-rolling-summary/); // kind doc excluded
});
