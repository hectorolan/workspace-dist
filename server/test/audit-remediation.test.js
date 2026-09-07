'use strict';
// TP-audit-rem: 2026-07-24 audit remediation, server side — WS-H1 fail-fast auth,
// WS-M2 atomic claim, WS-M4 plan revisions read path, and the plan.kind column
// (see ws plan get test-plan-audit-remediation).

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const SERVER = path.join(__dirname, '..', 'server.js');
const API_KEY = 'test-key-audit';

/**
 * Spawn server.js with the given env. Resolves {proc, base} once it listens, or
 * {proc, code, stderr} if it exits first (the WS-H1 refusal path).
 */
function startServer(env) {
  const proc = spawn(process.execPath, [SERVER], {
    env: { ...process.env, LOG_API_PORT: '0', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return new Promise((resolve, reject) => {
    let out = '';
    let err = '';
    const timer = setTimeout(() => reject(new Error('server did not start or exit: ' + out + err)), 10000);
    proc.stdout.on('data', (d) => {
      out += d;
      const m = out.match(/listening on (http:\/\/127\.0\.0\.1:\d+)/);
      if (m) { clearTimeout(timer); resolve({ proc, base: m[1] }); }
    });
    proc.stderr.on('data', (d) => { err += d; });
    proc.on('exit', (code) => { clearTimeout(timer); resolve({ proc, code, stderr: err, stdout: out }); });
  });
}

test('TP-audit-rem-001: empty LOG_API_KEY on a non-loopback host refuses to start (WS-H1)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'logapi-audit-h1-'));
  const r = await startServer({ LOG_DB_PATH: path.join(dir, 'logs.db'), LOG_API_HOST: '0.0.0.0', LOG_API_KEY: '' });
  assert.equal(r.code, 1, 'expected exit 1, got: ' + JSON.stringify({ code: r.code, base: r.base }));
  assert.match(r.stderr, /LOG_API_KEY/);
  assert.match(r.stderr, /refusing to start/);
  assert.doesNotMatch(r.stdout || '', /listening/);
});

test('TP-audit-rem-002: empty key on loopback still starts (container-internal default, test servers)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'logapi-audit-h1b-'));
  const r = await startServer({ LOG_DB_PATH: path.join(dir, 'logs.db'), LOG_API_HOST: '127.0.0.1', LOG_API_KEY: '' });
  assert.ok(r.base, 'expected the server to listen: ' + (r.stderr || ''));
  const res = await fetch(r.base + '/health');
  assert.equal(res.status, 200);
  r.proc.kill();
});

// ---- keyed shared server for claim / revisions / kind ---------------------------

let proc;
let base;
let dbPath;

const api = (p, opts = {}) =>
  fetch(base + p, { ...opts, headers: { 'X-Api-Key': API_KEY, ...(opts.headers || {}) } });
const post = (p, body) =>
  api(p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const put = (p, fields) =>
  api(p, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(fields) });

test.before(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'logapi-audit-test-'));
  dbPath = path.join(dir, 'logs.db');
  const r = await startServer({ LOG_DB_PATH: dbPath, LOG_API_HOST: '127.0.0.1', LOG_API_KEY: API_KEY });
  if (!r.base) throw new Error('server did not start: ' + (r.stderr || ''));
  proc = r.proc;
  base = r.base;
});

test.after(() => { if (proc) proc.kill(); });

test('TP-audit-rem-003: POST /claim — first call grants, second denies, missing key is 400 (WS-M2)', async () => {
  let res = await post('/claim', { key: 'page-comment-100', file: 'page-comment-100.md' });
  assert.equal(res.status, 201);
  assert.deepEqual(await res.json(), { ok: true, granted: true, takeover: false });

  res = await post('/claim', { key: 'page-comment-100' });
  assert.equal(res.status, 200);
  const dup = await res.json();
  assert.equal(dup.granted, false);

  res = await post('/claim', {});
  assert.equal(res.status, 400);
  res = await post('/claim', { key: 'x', ttl_minutes: -1 });
  assert.equal(res.status, 400);
});

test('TP-audit-rem-004: stale claim takeover with ttl 0; fresh claim stays denied (crash-retry)', async () => {
  // ttl_minutes 0 = every existing claim counts as stale — the takeover path.
  const res = await post('/claim', { key: 'page-comment-100', ttl_minutes: 0 });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true, granted: true, takeover: true });

  // Default ttl (60 min): the just-refreshed claim is fresh again — denied.
  const again = await (await post('/claim', { key: 'page-comment-100' })).json();
  assert.equal(again.granted, false);
});

test('TP-audit-rem-005: claim rows are prefixed — they never collide with real refs in /seen', async () => {
  const seen = await (await api('/seen')).text();
  assert.match(seen, /^claim:page-comment-100$/m);
  assert.doesNotMatch(seen, /^page-comment-100$/m);
  // The real ref can still be marked seen independently of its claim row.
  const res = await post('/seen', { message_id: 'page-comment-100', file: 'page-comment-100.md' });
  assert.equal(res.status, 201);
});

test('TP-audit-rem-020: GET /plan/:slug/revisions — lines newest first, json full bodies, limit, 404 (WS-M4)', async () => {
  assert.equal((await put('/plan/rev-plan', { title: 'Rev plan', body: 'v1', agent: 'coo' })).status, 201);
  assert.equal((await put('/plan/rev-plan', { body: 'v2 body', agent: 'implementer' })).status, 200);
  assert.equal((await put('/plan/rev-plan', { body: 'v3 body!' })).status, 200);

  // Text lines: id | date | updated_by | n chars, newest snapshot first.
  const text = await (await api('/plan/rev-plan/revisions')).text();
  const lines = text.trim().split('\n');
  assert.equal(lines.length, 2);
  assert.match(lines[0], /^\d+ \| \d{4}-\d{2}-\d{2} \| implementer \| 7 chars$/); // 'v2 body' snapshot
  assert.match(lines[1], /^\d+ \| \d{4}-\d{2}-\d{2} \| coo \| 2 chars$/); // original 'v1'

  // JSON returns the full bodies — the whole point of a history read.
  const json = await (await api('/plan/rev-plan/revisions?format=json')).json();
  assert.equal(json.ok, true);
  assert.equal(json.count, 2);
  assert.equal(json.revisions[0].body, 'v2 body');
  assert.equal(json.revisions[1].body, 'v1'); // oldest snapshot = original body

  // ?limit= bounds, newest kept.
  const limited = await (await api('/plan/rev-plan/revisions?format=json&limit=1')).json();
  assert.equal(limited.count, 1);
  assert.equal(limited.revisions[0].body, 'v2 body');

  assert.equal((await api('/plan/nope/revisions')).status, 404);
  assert.equal((await api('/plan/nope/revisions?format=json')).status, 404);
  // Auth regression: revisions require the key like every /plan route.
  assert.equal((await fetch(base + '/plan/rev-plan/revisions')).status, 401);
});

test('TP-audit-rem-030: create defaults kind=plan; line is slug | kind | status | date | title; json exposes kind', async () => {
  const res = await put('/plan/kind-default', { title: 'Kind default', body: 'b' });
  assert.equal(res.status, 201);
  const { plan, line } = await res.json();
  assert.equal(plan.kind, 'plan');
  assert.match(line, /^kind-default \| plan \| active \| \d{4}-\d{2}-\d{2} \| Kind default$/);

  const list = await (await api('/plan?format=json')).json();
  assert.equal(list.plans.find((p) => p.slug === 'kind-default').kind, 'plan');
  const detail = await (await api('/plan/kind-default?format=json')).json();
  assert.equal(detail.plan.kind, 'plan');
});

test('TP-audit-rem-031: kind audit|design persists; update preserves; invalid kind 400s, nothing written', async () => {
  let res = await put('/plan/kind-audit', { title: 'An audit', body: 'findings', kind: 'audit' });
  assert.equal(res.status, 201);
  assert.equal((await res.json()).plan.kind, 'audit');

  // Update without kind preserves it.
  res = await put('/plan/kind-audit', { status: 'done' });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).plan.kind, 'audit');

  // Update CAN change it.
  res = await put('/plan/kind-audit', { kind: 'design' });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).plan.kind, 'design');

  // Invalid kind: 400 on create AND update, nothing written.
  res = await put('/plan/kind-bad', { title: 'x', body: 'y', kind: 'sonnet' });
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /invalid kind/);
  assert.equal((await api('/plan/kind-bad')).status, 404);
  res = await put('/plan/kind-audit', { kind: 'sonnet' });
  assert.equal(res.status, 400);
  assert.equal((await (await api('/plan/kind-audit?format=json')).json()).plan.kind, 'design');
});

test('TP-audit-rem-032: live-DB migration — pre-kind plan table gets the column at boot, rows read back as plan', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'logapi-audit-mig-'));
  const oldDb = path.join(dir, 'logs.db');
  const db = new DatabaseSync(oldDb);
  // The plan table exactly as it shipped BEFORE the kind column (commit 732fa0f).
  db.exec(`
    CREATE TABLE plan (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      slug       TEXT NOT NULL UNIQUE,
      title      TEXT NOT NULL,
      status     TEXT NOT NULL DEFAULT 'active',
      repo       TEXT,
      body       TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      updated_by TEXT
    );
  `);
  db.prepare(
    "INSERT INTO plan (slug, title, status, repo, body, created_at, updated_at, updated_by) VALUES ('old-plan', 'Old plan', 'active', 'ho-nexus', 'old body', '2026-07-23T00:00:00Z', '2026-07-23T00:00:00Z', 'coo')"
  ).run();
  db.close();

  const r = await startServer({ LOG_DB_PATH: oldDb, LOG_API_HOST: '127.0.0.1', LOG_API_KEY: API_KEY });
  assert.ok(r.base, 'migrated server did not start: ' + (r.stderr || ''));
  try {
    const json = await (
      await fetch(r.base + '/plan/old-plan?format=json', { headers: { 'X-Api-Key': API_KEY } })
    ).json();
    assert.equal(json.plan.kind, 'plan'); // existing rows read back as 'plan'
    // Nothing else rewritten by the migration (orchestrator reclassifies explicitly, post-deploy).
    assert.equal(json.plan.body, 'old body');
    assert.equal(json.plan.updated_at, '2026-07-23T00:00:00Z');
    assert.equal(json.plan.updated_by, 'coo');
  } finally {
    r.proc.kill();
  }
});
