'use strict';
// TP-features-registry (server half): GET /feature — the join point of the declared
// feature registry (configs/features.json), the station table's observed reports,
// and job-run `runner` log rows. Cases: `ws plan get features-registry-2026-08-27`;
// the loader/validator + state-derivation unit cases are cli/test/features.test.js.
// Contract: server/README.md "Feature registry".

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const SERVER = path.join(__dirname, '..', 'server.js');
const API_KEY = 'test-key-features';

let proc;
let base;
let dbPath;
let featuresConfig;

// Test roster: ft-vm is the schedule owner (docker-container), ft-pc is an
// interactive box, ft-silent is configured but never reports.
const ENVS = {
  scheduleOwner: 'ft-vm',
  environments: {
    'ft-vm': { kind: 'docker-container' },
    'ft-pc': { kind: 'interactive + rollback host' },
    'ft-silent': { kind: 'interactive + rollback host' },
  },
};
const JOBS = {
  timezone: 'UTC',
  jobs: [
    { name: 'digest', cron: '0 7 * * *' },
    { name: 'quiet-job', cron: '0 8 * * *' },
    { name: 'staged-job', cron: '0 9 * * *', disabled: true },
  ],
};
const desc = (id) => `Plain words about ${id} for an unfamiliar operator.`;
const FEATURES = {
  features: [
    { id: 'tool-node', title: 'node runtime', kind: 'tool', scope: 'all', description: desc('tool-node'), evidence: ['check:tool:node'] },
    { id: 'pull-task', title: 'per-PC pull task', kind: 'job', scope: 'kind:interactive + rollback host', description: desc('pull-task'), evidence: ['check:pull-task'] },
    { id: 'svc-hub', title: 'hub service env', kind: 'service', scope: 'env:ft-vm', description: desc('svc-hub'), evidence: ['check:cp-env:hub'] },
    { id: 'digest', title: 'daily digest', kind: 'job', scope: 'schedule-owner', description: desc('digest'), evidence: ['job:digest', 'runner-log:digest-alias'] },
    { id: 'quiet-job', title: 'job with no run rows', kind: 'job', scope: 'schedule-owner', description: desc('quiet-job'), evidence: ['job:quiet-job'] },
    { id: 'staged-job', title: 'disabled job', kind: 'job', scope: 'schedule-owner', description: desc('staged-job'), evidence: ['job:staged-job'] },
    { id: 'declared-only', title: 'declared, unmeasured', kind: 'page', scope: 'all', description: desc('declared-only'), evidence: [] },
  ],
};

const hdrs = { 'Content-Type': 'application/json', 'X-Api-Key': API_KEY };
const putStation = (env, report) =>
  fetch(`${base}/station/${env}`, { method: 'PUT', headers: hdrs, body: JSON.stringify({ report }) });
const postLog = (body) =>
  fetch(`${base}/log`, { method: 'POST', headers: hdrs, body: JSON.stringify(body) });
const get = (p) => fetch(base + p, { headers: { 'X-Api-Key': API_KEY } });
const getFeatures = async (qs = '?format=json') => {
  const res = await get('/feature' + qs);
  assert.equal(res.status, 200);
  return res.json();
};

test.before(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'logapi-features-'));
  dbPath = path.join(dir, 'logs.db');
  const envsConfig = path.join(dir, 'environments.json');
  const jobsConfig = path.join(dir, 'jobs.json');
  featuresConfig = path.join(dir, 'features.json');
  fs.writeFileSync(envsConfig, JSON.stringify(ENVS));
  fs.writeFileSync(jobsConfig, JSON.stringify(JOBS));
  fs.writeFileSync(featuresConfig, JSON.stringify(FEATURES));
  proc = spawn(process.execPath, [SERVER], {
    env: {
      ...process.env, LOG_DB_PATH: dbPath, LOG_API_PORT: '0', LOG_API_KEY: API_KEY,
      WS_ENVS_CONFIG: envsConfig, WS_JOBS_CONFIG: jobsConfig, WS_FEATURES_CONFIG: featuresConfig,
    },
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

  // ft-vm reports: node OK; NO pull-task and NO cp-env rows (a container neither
  // registers a pull task nor probes the control plane about itself).
  await putStation('ft-vm', {
    env: 'ft-vm', platform: 'linux', ok: true,
    results: [{ id: 'tool:node', level: 'OK', name: 'tool node', detail: 'v26' }],
  });
  // ft-pc reports: node OK, pull-task FAIL, and the control-plane cp-env rows about
  // the VM host (probed over SSH from the PC — the cross-station case).
  await putStation('ft-pc', {
    env: 'ft-pc', platform: 'win32', ok: false,
    results: [
      { id: 'tool:node', level: 'OK', name: 'tool node', detail: 'v26' },
      { id: 'pull-task', level: 'FAIL', name: 'pull-task', detail: 'not registered' },
      { id: 'cp-env:hub', level: 'INFO', name: 'cp-env:hub', detail: '1 ready, 1 off', data: { service: 'hub', state: 'off' } },
    ],
  });
  // One runner run for the digest job.
  await postLog({ area: 'digest', status: 'done', message: 'output archived', agent: 'runner' });
});

test.after(() => { if (proc) proc.kill(); });

test('TP-features-registry-012: JSON shape — roster, one cell per configured env, n/a outside scope', async () => {
  const json = await getFeatures();
  assert.equal(json.ok, true);
  assert.equal(json.count, FEATURES.features.length);
  assert.equal(json.schedule_owner, 'ft-vm');
  assert.deepEqual(json.stations, ['ft-vm', 'ft-pc', 'ft-silent']);
  for (const f of json.features) assert.deepEqual(Object.keys(f.cells).sort(), ['ft-pc', 'ft-silent', 'ft-vm']);
  // kind-scoped: the container is outside; env-scoped: the PC is outside;
  // schedule-owner: only ft-vm is in.
  const pullTask = json.features.find((f) => f.id === 'pull-task');
  assert.equal(pullTask.cells['ft-vm'].state, 'n/a');
  const svcHub = json.features.find((f) => f.id === 'svc-hub');
  assert.equal(svcHub.cells['ft-pc'].state, 'n/a');
  const digest = json.features.find((f) => f.id === 'digest');
  assert.equal(digest.cells['ft-pc'].state, 'n/a');
});

test('TP-features-registry-013: a station\'s own evidence drives its cell — OK ready, FAIL missing, cp-env off', async () => {
  const json = await getFeatures();
  const toolNode = json.features.find((f) => f.id === 'tool-node');
  assert.equal(toolNode.cells['ft-vm'].state, 'ready');
  assert.equal(toolNode.cells['ft-pc'].state, 'ready');
  assert.equal(toolNode.cells['ft-pc'].checks[0].id, 'tool:node');
  const pullTask = json.features.find((f) => f.id === 'pull-task');
  assert.equal(pullTask.cells['ft-pc'].state, 'missing'); // FAIL evidence
  const svcHub = json.features.find((f) => f.id === 'svc-hub');
  // cp-env data.state 'off' wins over the INFO level mapping (same answer here,
  // but the state field is what rides through — asserted on the check row).
  const vmCell = svcHub.cells['ft-vm'];
  assert.equal(vmCell.state, 'off');
});

test('TP-features-registry-016: cross-station evidence — cp-env about the VM read from the PC\'s report, cell carries via', async () => {
  const json = await getFeatures();
  const svcHub = json.features.find((f) => f.id === 'svc-hub');
  const check = svcHub.cells['ft-vm'].checks.find((c) => c.id === 'cp-env:hub');
  assert.equal(check.state, 'off');
  assert.equal(check.via, 'ft-pc'); // the evidence lives in ft-pc's report
});

test('TP-features-registry-015: job features — disabled off, runner done ready + last_run, no rows unmeasured', async () => {
  const json = await getFeatures();
  const digest = json.features.find((f) => f.id === 'digest');
  assert.equal(digest.job.name, 'digest');
  assert.equal(digest.job.disabled, false);
  assert.equal(digest.job.last_run.status, 'done');
  assert.equal(digest.cells['ft-vm'].state, 'ready');
  const quiet = json.features.find((f) => f.id === 'quiet-job');
  assert.equal(quiet.job.last_run, null);
  assert.equal(quiet.cells['ft-vm'].state, 'unmeasured'); // no run rows — never fake liveness
  const staged = json.features.find((f) => f.id === 'staged-job');
  assert.equal(staged.job.disabled, true);
  assert.equal(staged.cells['ft-vm'].state, 'off');
});

test('TP-features-registry-017: evidence [] — measured false, in-scope cells unmeasured', async () => {
  const json = await getFeatures();
  const declared = json.features.find((f) => f.id === 'declared-only');
  assert.equal(declared.measured, false);
  assert.equal(declared.cells['ft-vm'].state, 'unmeasured');
  assert.equal(declared.cells['ft-pc'].state, 'unmeasured');
});

test('TP-features-registry-014: never-reported for a silent configured station; stale honors stale_minutes', async () => {
  let json = await getFeatures();
  const toolNode = json.features.find((f) => f.id === 'tool-node');
  assert.equal(toolNode.cells['ft-silent'].state, 'never-reported');
  // Backdate ft-pc 60 min (test-only direct DB write, the station.test.js precedent):
  // stale at the 45-min default, not at 90.
  const db = new DatabaseSync(dbPath);
  db.prepare("UPDATE station SET ts = ? WHERE env = 'ft-pc'").run(new Date(Date.now() - 60 * 60000).toISOString());
  db.close();
  json = await getFeatures();
  assert.equal(json.features.find((f) => f.id === 'tool-node').cells['ft-pc'].state, 'stale');
  json = await getFeatures('?format=json&stale_minutes=90');
  assert.equal(json.features.find((f) => f.id === 'tool-node').cells['ft-pc'].state, 'ready');
});

test('TP-features-registry-018: invalid registry is a loud 500 with the validator\'s errors; text form renders lines', async () => {
  // Text form first (registry still valid): one line per feature.
  const text = await (await get('/feature?stale_minutes=90')).text();
  assert.match(text, /^tool-node \| tool \| all \| ft-vm=ready ft-pc=ready ft-silent=never-reported$/m);
  assert.match(text, /^digest \| job \| schedule-owner \| [^\n]*\| job digest: last done \d{4}-\d{2}-\d{2}$/m);
  assert.match(text, /^staged-job \| [^\n]*\| job staged-job: disabled$/m);
  assert.match(text, /^declared-only \| page \| all \| [^\n]*\| declared, unmeasured$/m);
  // Break the registry on disk (read fresh every request, so no restart needed).
  fs.writeFileSync(featuresConfig, JSON.stringify({ features: [{ id: 'x', title: 'x', kind: 'job', scope: 'env:nope', evidence: ['job:not-a-job'] }] }));
  const res = await get('/feature?format=json');
  assert.equal(res.status, 500);
  const body = await res.json();
  assert.equal(body.ok, false);
  assert.equal(body.error, 'invalid feature registry');
  assert.ok(body.errors.some((e) => /unknown env 'nope'/.test(e)));
  assert.ok(body.errors.some((e) => /unknown job 'not-a-job'/.test(e)));
  fs.writeFileSync(featuresConfig, JSON.stringify(FEATURES)); // restore for any later case
});

test('TP-features-registry-019: auth regression — every route stays keyed, /feature included', async () => {
  const res = await fetch(base + '/feature?format=json');
  assert.equal(res.status, 401);
});

test('TP-features-desc-004: JSON carries each feature\'s plain-language description verbatim', async () => {
  const json = await getFeatures();
  for (const f of json.features) {
    assert.equal(f.description, FEATURES.features.find((x) => x.id === f.id).description);
  }
});

test('TP-features-desc-006: a registry entry without a description is refused loudly at the API', async () => {
  fs.writeFileSync(featuresConfig, JSON.stringify({ features: [{ id: 'x', title: 'x', kind: 'page', scope: 'all', evidence: [] }] }));
  const res = await get('/feature?format=json');
  assert.equal(res.status, 500);
  const body = await res.json();
  assert.equal(body.error, 'invalid feature registry');
  assert.ok(body.errors.some((e) => /missing description/.test(e)));
  fs.writeFileSync(featuresConfig, JSON.stringify(FEATURES)); // restore for any later case
});
