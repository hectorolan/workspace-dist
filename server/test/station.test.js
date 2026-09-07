'use strict';
// TP-station-registry: the station registry (plan environment-setup-streamlining,
// W3/D1b) - dedicated `station` table, PUT /station/:env upsert (last-write-wins,
// NO revisions), roster read with control-plane-side staleness and never-reported
// findings. Cases: `ws plan get test-plan-station-registry`.

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const SERVER = path.join(__dirname, '..', 'server.js');
const API_KEY = 'test-key-station';

let proc;
let base;
let dbPath;

/** A minimal env-doctor-shaped payload. */
const makeReport = (over = {}) => ({
  env: 'st-a',
  platform: 'win32',
  at: '2026-07-28 12:00:00',
  ok: true,
  publicIp: '203.0.113.7',
  results: [{ id: 'node', level: 'OK', name: 'node', detail: 'v24' }],
  ...over,
});

const put = (env, report, key = API_KEY) =>
  fetch(`${base}/station/${env}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', 'X-Api-Key': key },
    body: JSON.stringify({ report }),
  });

const get = (p) => fetch(base + p, { headers: { 'X-Api-Key': API_KEY } });

test.before(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'logapi-station-'));
  dbPath = path.join(dir, 'logs.db');
  // Test roster seam: the server judges "never reported" against this file.
  const envsConfig = path.join(dir, 'environments.json');
  fs.writeFileSync(envsConfig, JSON.stringify({ environments: { 'st-a': {}, 'st-b': {}, 'st-silent': {} } }));
  proc = spawn(process.execPath, [SERVER], {
    env: { ...process.env, LOG_DB_PATH: dbPath, LOG_API_PORT: '0', LOG_API_KEY: API_KEY, WS_ENVS_CONFIG: envsConfig },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  base = await new Promise((resolve, reject) => {
    let out = '';
    const timer = setTimeout(() => reject(new Error('server did not start: ' + out)), 10000);
    proc.stdout.on('data', (d) => {
      out += d;
      const m = out.match(/listening on (http:\/\/127\.0\.0\.1:\d+)/);
      if (m) { clearTimeout(timer); resolve(m[1]); }
    });
    proc.stderr.on('data', (d) => { out += d; });
  });
});

test.after(() => { if (proc) proc.kill(); });

test('TP-station-registry-001: PUT creates a row (201) and GET /station/:env returns the stored report', async () => {
  const res = await put('st-a', makeReport());
  assert.equal(res.status, 201);
  const json = await res.json();
  assert.equal(json.ok, true);
  assert.match(json.line, /^st-a \| ok \| last /);

  const back = await get('/station/st-a?format=json');
  assert.equal(back.status, 200);
  const body = await back.json();
  assert.equal(body.station.env, 'st-a');
  assert.equal(body.station.ok, true);
  assert.equal(body.station.public_ip, '203.0.113.7');
  assert.deepEqual(body.station.report, makeReport());
});

test('TP-station-registry-002: second PUT overwrites - one row, old report gone, no revisions (last-write-wins)', async () => {
  const res = await put('st-a', makeReport({ ok: false, publicIp: '203.0.113.9', results: [{ id: 'pull-task', level: 'FAIL', name: 'pull-task', detail: 'not registered' }] }));
  assert.equal(res.status, 200); // update, not create
  const back = await (await get('/station/st-a?format=json')).json();
  assert.equal(back.station.ok, false);
  assert.equal(back.station.public_ip, '203.0.113.9');
  // Exactly one row per station, and NOTHING landed in plan_revision (the whole
  // point of not using the plan carrier - see server/README.md rationale).
  const db = new DatabaseSync(dbPath);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM station WHERE env = 'st-a'").get().n, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM plan_revision').get().n, 0);
  db.close();
});

test('TP-station-registry-003: PUT without an object report is a 400, nothing written', async () => {
  for (const bad of [undefined, 'a string', ['array']]) {
    const res = await fetch(`${base}/station/st-bad`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'X-Api-Key': API_KEY },
      body: JSON.stringify(bad === undefined ? {} : { report: bad }),
    });
    assert.equal(res.status, 400);
  }
  assert.equal((await get('/station/st-bad')).status, 404);
});

test('TP-station-registry-004: staleness is a read-time control-plane finding (stale_minutes honored)', async () => {
  // Fresh row: not stale under the default 45-min window.
  const fresh = await (await get('/station')).text();
  assert.match(fresh, /^st-a \| FAILING:pull-task \| last [^\n]*m ago\) \|/m);
  assert.doesNotMatch(fresh, /st-a[^\n]*STALE/);
  // Backdate the row 60 min (test-only direct DB write) -> STALE at 45, not at 90.
  const db = new DatabaseSync(dbPath);
  db.prepare("UPDATE station SET ts = ? WHERE env = 'st-a'").run(new Date(Date.now() - 60 * 60000).toISOString());
  db.close();
  assert.match(await (await get('/station')).text(), /st-a[^\n]*STALE/);
  assert.doesNotMatch(await (await get('/station?stale_minutes=90')).text(), /st-a[^\n]*STALE/);
});

test('TP-station-registry-005: a configured station with no row lists as NEVER REPORTED (absence is actionable)', async () => {
  const text = await (await get('/station')).text();
  assert.match(text, /^st-silent \| NEVER REPORTED/m);
  assert.match(text, /^st-b \| NEVER REPORTED/m);
});

test('TP-station-registry-006: a row not in the configured roster still lists, marked not-in-config', async () => {
  assert.equal((await put('st-rogue', makeReport({ env: 'st-rogue' }))).status, 201);
  const text = await (await get('/station')).text();
  assert.match(text, /^st-rogue \| ok[^\n]*not in configs\/environments\.json$/m);
});

test('TP-station-registry-007: format=json returns structured rows for the later ho-nexus page', async () => {
  const json = await (await get('/station?format=json')).json();
  assert.equal(json.ok, true);
  assert.deepEqual(json.never_reported.sort(), ['st-b', 'st-silent']);
  const a = json.stations.find((s) => s.env === 'st-a');
  assert.equal(a.stale, true); // still backdated from 004
  assert.equal(typeof a.age_minutes, 'number');
  assert.equal(a.configured, true);
  assert.equal(a.report.results[0].id, 'pull-task');
  const rogue = json.stations.find((s) => s.env === 'st-rogue');
  assert.equal(rogue.configured, false);
});

test('TP-station-registry-008: the /station endpoints sit behind the same API key', async () => {
  assert.equal((await put('st-a', makeReport(), 'wrong-key')).status, 401);
  assert.equal((await fetch(base + '/station')).status, 401);
});
