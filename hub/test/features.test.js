'use strict';

// Features API suite (central-DB test plan hub-features-matrix-2026-08-27).
// The route proxies the workspace log API's SERVER-AGGREGATED feature matrix
// (`GET /feature?format=json`, workspace/server/README.md "Feature registry") —
// every cell state is the control plane's finding, echoed through a whitelisted
// strings-only trim (the stations.js posture). Nothing here derives liveness.

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const request = require('supertest');
const { makeApp } = require('./helpers');

const API_KEY = 'stub-api-key';

// Raw feed shape (snake_case, per the README contract), salted with fields the
// trim must drop: a job last_run message, an extra per-feature blob, and an
// unknown key inside a check row — none may reach the response (TP-hubfeat-002).
const FEED = {
  ok: true,
  count: 5,
  stale_minutes: 45,
  schedule_owner: 'vm-a',
  stations: ['vm-a', 'pc-b', 'pc-silent'],
  features: [
    {
      id: 'daily-digest', title: 'Daily digest', description: "Composes and emails the morning digest.", kind: 'job', scope: 'schedule-owner', measured: true,
      job: {
        name: 'daily-digest', cron: '0 7 * * *', disabled: false,
        last_run: { date: '2026-08-26', status: 'done', message: 'x-run-message-NEVER-IN-RESPONSE', ts: '2026-08-26T14:00:00Z', area: 'digest' },
      },
      cells: { 'vm-a': { state: 'ready', age_minutes: 4 }, 'pc-b': { state: 'n/a' }, 'pc-silent': { state: 'n/a' } },
    },
    {
      id: 'service-hub', title: 'Hub prod service env', description: "The settings the hub website needs in production.", kind: 'service', scope: 'env:vm-a', measured: true,
      cells: {
        'vm-a': {
          state: 'ready', age_minutes: 4,
          checks: [{ id: 'cp-env:hub', state: 'ready', level: 'OK', detail: '5 ready of 5', via: 'pc-b', data: { note: 'x-secret-note-NEVER-IN-RESPONSE' } }],
        },
        'pc-b': { state: 'n/a' },
        'pc-silent': { state: 'n/a' },
      },
    },
    {
      id: 'tool-gh', title: 'gh CLI', description: "The GitHub command-line tool agents use for PRs.", kind: 'tool', scope: 'all', measured: true,
      cells: {
        'vm-a': { state: 'missing', age_minutes: 4, checks: [{ id: 'tool:gh', state: 'missing', level: 'FAIL', detail: 'gh not found' }] },
        'pc-b': { state: 'stale', age_minutes: 300 },
        'pc-silent': { state: 'never-reported' },
      },
    },
    {
      id: 'future-page', title: 'A declared page', kind: 'page', scope: 'all', measured: false, note: 'no evidence yet',
      // Built by concatenation so this file never carries a token-shaped literal
      // on one line (the distribution's scan covers the vendored hub tree).
      extra_blob: { token: ['ghp', 'SECRETSECRETSECRETSECRET1234567890ab'].join('_') },
      cells: { 'vm-a': { state: 'unmeasured', age_minutes: 4 }, 'pc-b': { state: 'stale', age_minutes: 300 }, 'pc-silent': { state: 'never-reported' } },
    },
    {
      id: 'disabled-job', title: 'Disabled job', description: "A job somebody switched off on purpose.", kind: 'job', scope: 'schedule-owner', measured: true,
      job: { name: 'disabled-job', cron: '0 3 * * *', disabled: true, last_run: null },
      cells: { 'vm-a': { state: 'off', age_minutes: 4 }, 'pc-b': { state: 'n/a' }, 'pc-silent': { state: 'n/a' } },
    },
  ],
};

/** Stub log API: GET /feature?format=json only (the one endpoint the lib calls). */
function startStubApi({ envelope, invalidRegistry = false } = {}) {
  const seen = [];
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    seen.push({ method: req.method, path: u.pathname, query: Object.fromEntries(u.searchParams), key: req.headers['x-api-key'] });
    res.setHeader('Content-Type', 'application/json');
    if (u.pathname === '/feature') {
      if (invalidRegistry) {
        // Part A's loud failure shape: a broken registry answers 500.
        res.statusCode = 500;
        return res.end(JSON.stringify({ ok: false, error: 'invalid feature registry', errors: ['dup id'] }));
      }
      const staleMin = Number(u.searchParams.get('stale_minutes')) > 0 ? Number(u.searchParams.get('stale_minutes')) : 45;
      return res.end(JSON.stringify(envelope || { ...FEED, stale_minutes: staleMin }));
    }
    res.statusCode = 404;
    res.end(JSON.stringify({ ok: false }));
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ url: `http://127.0.0.1:${server.address().port}`, seen, close: () => server.close() }));
  });
}

const appFor = (stubUrl, overrides = {}) =>
  makeApp({ authBypass: true, logApiUrl: stubUrl, logApiKey: API_KEY, ...overrides });

// @plan:hub-features-matrix-2026-08-27 @promote
test('TP-hubfeat-001: envelope mapped from the feed — roster, owner, feed order, one cell per station', async () => {
  const stub = await startStubApi();
  try {
    const res = await request(appFor(stub.url)).get('/api/features');
    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true);
    assert.equal(res.body.staleMinutes, 45);
    assert.equal(res.body.scheduleOwner, 'vm-a');
    assert.deepEqual(res.body.stations, ['vm-a', 'pc-b', 'pc-silent']);
    assert.deepEqual(
      res.body.features.map((f) => f.id),
      ['daily-digest', 'service-hub', 'tool-gh', 'future-page', 'disabled-job'],
      'feed order kept'
    );
    for (const f of res.body.features) {
      assert.deepEqual(Object.keys(f.cells).sort(), ['pc-b', 'pc-silent', 'vm-a'], `${f.id}: one cell per station`);
    }
    const gh = res.body.features.find((f) => f.id === 'tool-gh');
    assert.equal(gh.cells['vm-a'].state, 'missing');
    assert.equal(gh.cells['pc-b'].state, 'stale');
    assert.equal(gh.cells['pc-silent'].state, 'never-reported');
    const digest = res.body.features.find((f) => f.id === 'daily-digest');
    assert.equal(digest.cells['pc-b'].state, 'n/a', 'out-of-scope station reads n/a, echoed verbatim');
  } finally {
    stub.close();
  }
});

// @plan:hub-features-matrix-2026-08-27 @promote
test('TP-hubfeat-002: trimmed shape — whitelisted keys only; salted feed fields never reach the response; via survives', async () => {
  const stub = await startStubApi();
  try {
    const res = await request(appFor(stub.url)).get('/api/features');
    assert.equal(res.status, 200);
    for (const f of res.body.features) {
      const allowed = ['cells', 'description', 'id', 'job', 'kind', 'measured', 'note', 'scope', 'title'];
      for (const k of Object.keys(f)) assert.ok(allowed.includes(k), `${f.id}: unexpected feature key ${k}`);
      for (const cell of Object.values(f.cells)) {
        for (const k of Object.keys(cell)) assert.ok(['state', 'ageMinutes', 'checks'].includes(k), `unexpected cell key ${k}`);
        for (const c of cell.checks) {
          for (const k of Object.keys(c)) assert.ok(['id', 'state', 'level', 'detail', 'via'].includes(k), `unexpected check key ${k}`);
        }
      }
    }
    assert.ok(!res.text.includes('ghp_'), 'secret-shaped extra blob never reaches the response');
    assert.ok(!res.text.includes('x-secret-note-NEVER-IN-RESPONSE'), 'check data blobs dropped');
    const hub = res.body.features.find((f) => f.id === 'service-hub');
    assert.equal(hub.cells['vm-a'].checks[0].via, 'pc-b', 'cross-station via kept — the cell must be able to say where its evidence came from');
    assert.equal(hub.measured, true);
    const page = res.body.features.find((f) => f.id === 'future-page');
    assert.equal(page.measured, false);
    assert.equal(page.note, 'no evidence yet');
  } finally {
    stub.close();
  }
});

// @plan:hub-features-stations-merge-2026-08-27 @promote
test('TP-fsm-001: description passes the trim verbatim; a feature without one folds to empty string', async () => {
  const stub = await startStubApi();
  try {
    const res = await request(appFor(stub.url)).get('/api/features');
    assert.equal(res.status, 200);
    const digest = res.body.features.find((f) => f.id === 'daily-digest');
    assert.equal(digest.description, 'Composes and emails the morning digest.', 'the registry prose rides through untouched — the UI never authors it');
    const page = res.body.features.find((f) => f.id === 'future-page');
    assert.equal(page.description, '', 'an older feed without descriptions folds to empty, never a crash');
  } finally {
    stub.close();
  }
});

// @plan:hub-features-matrix-2026-08-27 @promote
test('TP-hubfeat-003: job block trim — outcome + date only; null last_run kept null; non-job features carry no job', async () => {
  const stub = await startStubApi();
  try {
    const res = await request(appFor(stub.url)).get('/api/features');
    const digest = res.body.features.find((f) => f.id === 'daily-digest');
    assert.deepEqual(digest.job, {
      name: 'daily-digest',
      cron: '0 7 * * *',
      disabled: false,
      lastRun: { date: '2026-08-26', status: 'done' },
    }, 'message/ts/area dropped — the matrix shows the outcome, the log stays in the DB');
    assert.ok(!res.text.includes('x-run-message-NEVER-IN-RESPONSE'));
    const off = res.body.features.find((f) => f.id === 'disabled-job');
    assert.equal(off.job.disabled, true);
    assert.equal(off.job.lastRun, null);
    const hub = res.body.features.find((f) => f.id === 'service-hub');
    assert.ok(!('job' in hub), 'non-job features carry no job block');
  } finally {
    stub.close();
  }
});

// @plan:hub-features-matrix-2026-08-27 @promote
test('TP-hubfeat-004: ?stale_minutes= forwarded only as a positive integer', async () => {
  const stub = await startStubApi();
  try {
    const app = appFor(stub.url);
    const ok = await request(app).get('/api/features?stale_minutes=10');
    assert.equal(ok.body.staleMinutes, 10, 'override reached the feed and its echo came back');
    for (const bad of ['0', '-5', 'abc', '10;DROP', '1.5']) {
      await request(app).get(`/api/features?stale_minutes=${encodeURIComponent(bad)}`);
    }
    const calls = stub.seen.filter((r) => r.path === '/feature');
    assert.equal(calls[0].query.stale_minutes, '10');
    for (const c of calls.slice(1)) assert.ok(!('stale_minutes' in c.query), 'invalid override dropped, not forwarded');
  } finally {
    stub.close();
  }
});

// @plan:hub-features-matrix-2026-08-27 @promote
test('TP-hubfeat-005: unset LOG_API_URL → 503; feed down → 502; invalid-registry 500 → 502', async () => {
  const unconfigured = await request(makeApp({ authBypass: true, logApiUrl: '' })).get('/api/features');
  assert.equal(unconfigured.status, 503);
  assert.match(unconfigured.body.error, /not configured/i);
  const stub = await startStubApi();
  stub.close();
  const down = await request(appFor(stub.url)).get('/api/features');
  assert.equal(down.status, 502);
  assert.match(down.body.error, /could not be reached/i);
  const broken = await startStubApi({ invalidRegistry: true });
  try {
    const res = await request(appFor(broken.url)).get('/api/features');
    assert.equal(res.status, 502, "Part A's loud registry failure surfaces as the friendly unreachable message here");
    assert.ok(!res.text.includes('dup id'), 'upstream validator internals not forwarded');
  } finally {
    broken.close();
  }
});

// @plan:hub-features-matrix-2026-08-27 @promote
test('TP-hubfeat-006: envelope tolerance — missing arrays and cells fold to safe empties, still 200', async () => {
  const stub = await startStubApi({ envelope: { ok: true } });
  try {
    const res = await request(appFor(stub.url)).get('/api/features');
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.stations, []);
    assert.deepEqual(res.body.features, []);
    assert.equal(res.body.staleMinutes, 45);
    assert.equal(res.body.scheduleOwner, '');
  } finally {
    stub.close();
  }
  // A feature missing its cells object: every station folds to unmeasured —
  // never a crash, never fake liveness.
  const partial = await startStubApi({
    envelope: { ok: true, stale_minutes: 45, schedule_owner: null, stations: ['vm-a'], features: [{ id: 'x', title: 'X', kind: 'tool', scope: 'all' }] },
  });
  try {
    const res = await request(appFor(partial.url)).get('/api/features');
    assert.equal(res.status, 200);
    assert.equal(res.body.features[0].cells['vm-a'].state, 'unmeasured');
    assert.deepEqual(res.body.features[0].cells['vm-a'].checks, []);
  } finally {
    partial.close();
  }
});

// @plan:hub-features-matrix-2026-08-27 @promote
test('TP-hubfeat-007: every feed call carries X-Api-Key; the key never appears in a response', async () => {
  const stub = await startStubApi();
  try {
    const res = await request(appFor(stub.url)).get('/api/features');
    for (const r of stub.seen) assert.equal(r.key, API_KEY);
    assert.ok(!res.text.includes(API_KEY));
  } finally {
    stub.close();
  }
});

// @plan:hub-features-matrix-2026-08-27 @promote
test('TP-hubfeat-008: auth regression — unauthenticated /api/features gets 401 JSON, like every /api route', async () => {
  const stub = await startStubApi();
  try {
    const res = await request(appFor(stub.url, { authBypass: false })).get('/api/features');
    assert.equal(res.status, 401);
    assert.equal(res.body.ok, false);
  } finally {
    stub.close();
  }
});
