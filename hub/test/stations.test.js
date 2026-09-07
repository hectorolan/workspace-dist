'use strict';

// Stations API suite (central-DB test plan hn-test-plan-2026-07-28-stations-page).
// The route renders the workspace log API's control-plane verdicts — staleness and
// never-reported are ITS findings (`GET /station?format=json`), never recomputed here.

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const request = require('supertest');
const { makeApp } = require('./helpers');

const API_KEY = 'stub-api-key';

/** A check row shaped like the env-doctor payload's results entries. */
const check = (id, level, detail, data) => ({ id, level, name: id, detail, ...(data ? { data } : {}) });

// Verdicts here are deliberately INVERTED from what the timestamps suggest:
// stale-says-the-server has a fresh ts but stale:true; fresh-says-the-server is
// ancient but stale:false. TP-stations-002 asserts the app echoes the server.
const STATIONS = [
  {
    env: 'green-station', ts: '2026-07-28T22:54:33.782Z', date: '2026-07-28', platform: 'win32',
    ok: true, public_ip: '203.0.113.7', age_minutes: 4, stale: false, configured: true,
    report: {
      env: 'green-station', platform: 'win32', ok: true, publicIp: '203.0.113.7',
      results: [
        check('node', 'OK', 'v24.18.0'),
        check('harness', 'OK', '~/.claude/settings.json matches desired fallbackModel', { path: 'C:\\Users\\x\\.claude\\settings.json' }),
        check('gh-scopes', 'INFO', 'scopes: gist, read:org, repo, workflow', { scopes: ['gist', 'read:org', 'repo', 'workflow'] }),
        // Secret-shaped data value: must never reach the /api/stations response (TP-stations-003).
        // Token built by concatenation: no token-shaped literal on one line
        // (the distribution's scan covers the vendored hub tree).
        check('tool:gh', 'OK', '2.96.0', { version: '2.96.0', token: ['ghp', 'SECRETSECRETSECRETSECRET1234567890ab'].join('_') }),
        // New-shape per-service cp-env rows (workspace 655e1d0): the grouping fields
        // ride in `data` and must be trimmed like everything else — the Stations page
        // derives the grouping from id/name/detail strings alone (TP-stations-010).
        check('cp-env:hub', 'OK', '~/agent/hub/repo/.env: 1 ready, 0 off, 0 missing of 1 capabilities (names from hub/.env.example; values never leave the host)', { service: 'hub', ready: 1, off: 0, missing: 0 }),
        {
          id: 'cp-env:hub:GOOGLE_OAUTH_CLIENT_ID', level: 'OK', name: 'hub: Google sign-in',
          detail: 'ready — GOOGLE_OAUTH_CLIENT_ID, GOOGLE_OAUTH_CLIENT_SECRET set in ~/agent/hub/repo/.env',
          data: { service: 'hub', capability: 'Google sign-in', vars: ['GOOGLE_OAUTH_CLIENT_ID', 'GOOGLE_OAUTH_CLIENT_SECRET'], state: 'ready', note: 'x-secret-note-NEVER-IN-RESPONSE' },
        },
        // C-2 follow-up rows (central-DB test plan check-explainers-hub-2026-08-27):
        // env-doctor's plain-language `explain` — one valid string that must survive
        // the trim verbatim, plus guard shapes that must be DROPPED, never coerced.
        {
          id: 'pull-task', level: 'OK', name: 'pull-task', detail: 'registered (Enabled), LastResult=0',
          explain: 'Verifies the Windows scheduled task that refreshes this machine every 15 minutes exists and is healthy.',
        },
        { id: 'x-explain-object', level: 'OK', name: 'x-explain-object', detail: 'guard row', explain: { secret: 'x-explain-secret-NEVER-IN-RESPONSE' } },
        { id: 'x-explain-number', level: 'OK', name: 'x-explain-number', detail: 'guard row', explain: 42 },
        { id: 'x-explain-huge', level: 'OK', name: 'x-explain-huge', detail: 'guard row', explain: 'x'.repeat(1001) },
      ],
    },
  },
  {
    env: 'red-station', ts: '2020-01-01T00:00:00.000Z', date: '2020-01-01', platform: 'win32',
    ok: false, public_ip: '203.0.113.8', age_minutes: 9999, stale: false, configured: true,
    report: {
      env: 'red-station', platform: 'win32', ok: false, publicIp: '203.0.113.8',
      results: [
        check('harness', 'FAIL', "~/.claude/settings.json 'fallbackModel' not set — desired 'opus'"),
        check('pull-task', 'FAIL', 'Claude-WorkspacePull not registered'),
        check('deps', 'WARN', 'lockfile drift'),
      ],
    },
  },
  {
    env: 'fresh-but-stale', ts: '2026-07-28T22:54:00.000Z', date: '2026-07-28', platform: 'linux',
    ok: true, public_ip: null, age_minutes: 2, stale: true, configured: true,
    report: null, // API parse-fail contract: report may come back null (TP-stations-004)
  },
];

const NEVER = ['silent-station', 'other-silent'];

/** Stub log API: GET /station?format=json only (the one endpoint the lib calls). */
function startStubApi({ stations = STATIONS, never = NEVER, envelope, broken = false } = {}) {
  const seen = [];
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    seen.push({ method: req.method, path: u.pathname, query: Object.fromEntries(u.searchParams), key: req.headers['x-api-key'] });
    res.setHeader('Content-Type', 'application/json');
    if (u.pathname === '/station') {
      const staleMin = Number(u.searchParams.get('stale_minutes')) > 0 ? Number(u.searchParams.get('stale_minutes')) : 45;
      if (broken) return res.end(JSON.stringify({ ok: true })); // no arrays at all (TP-stations-009)
      const body = envelope || { ok: true, count: stations.length, stale_minutes: staleMin, stations, never_reported: never };
      return res.end(JSON.stringify(body));
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

test('TP-stations-001: roster mapped from the feed — reported rows + neverReported + staleMinutes', async () => {
  const stub = await startStubApi();
  try {
    const res = await request(appFor(stub.url)).get('/api/stations');
    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true);
    assert.equal(res.body.staleMinutes, 45);
    assert.deepEqual(res.body.neverReported, NEVER);
    assert.deepEqual(res.body.stations.map((s) => s.env), ['green-station', 'red-station', 'fresh-but-stale'], 'feed order kept');
    const green = res.body.stations[0];
    assert.equal(green.ts, '2026-07-28T22:54:33.782Z');
    assert.equal(green.ok, true);
    assert.equal(green.ageMinutes, 4);
    assert.equal(green.platform, 'win32');
    assert.equal(green.publicIp, '203.0.113.7');
    assert.equal(green.checks.length, 10);
    assert.deepEqual(green.checks[0], { id: 'node', level: 'OK', name: 'node', detail: 'v24.18.0' });
    const red = res.body.stations[1];
    assert.equal(red.ok, false);
    assert.deepEqual(red.checks.filter((c) => c.level === 'FAIL').map((c) => c.id), ['harness', 'pull-task']);
  } finally {
    stub.close();
  }
});

test('TP-stations-002: staleness is the server verdict — echoed, never recomputed from ts', async () => {
  const stub = await startStubApi();
  try {
    const res = await request(appFor(stub.url)).get('/api/stations');
    const byEnv = Object.fromEntries(res.body.stations.map((s) => [s.env, s]));
    assert.equal(byEnv['red-station'].stale, false, 'ancient ts but the control plane said fresh — app must not overrule');
    assert.equal(byEnv['fresh-but-stale'].stale, true, 'fresh ts but the control plane said stale — app must not overrule');
  } finally {
    stub.close();
  }
});

test('TP-stations-003: trimmed shape — no raw report, no data blobs, no secret-shaped values; gh scopes only as names', async () => {
  // TP-checkexp-004 (check-explainers-hub-2026-08-27): the allowlist widened by
  // exactly one STRING field, `explain` — the trim's security purpose is intact:
  // every forwarded key is on the five-field allowlist, every value is a string,
  // `data` objects and the raw `report` still drop wholesale.
  const ALLOWED = ['detail', 'explain', 'id', 'level', 'name'];
  const stub = await startStubApi();
  try {
    const res = await request(appFor(stub.url)).get('/api/stations');
    assert.equal(res.status, 200);
    for (const s of res.body.stations) {
      assert.ok(!('report' in s), 'raw report never ships to the browser');
      for (const c of s.checks) {
        for (const k of Object.keys(c)) {
          assert.ok(ALLOWED.includes(k), `check field '${k}' is not on the allowlist — data must stay dropped`);
          assert.equal(typeof c[k], 'string', `check field '${k}' must be a string`);
        }
      }
    }
    assert.ok(!res.text.includes('ghp_'), 'secret-shaped data value never reaches the response');
    assert.ok(res.text.includes('scopes: gist, read:org, repo, workflow'), 'scope NAMES still surface via detail');
  } finally {
    stub.close();
  }
});

// @plan:check-explainers-hub-2026-08-27 @promote
test('TP-checkexp-001: a string `explain` on a feed check row survives the trim verbatim', async () => {
  const stub = await startStubApi();
  try {
    const res = await request(appFor(stub.url)).get('/api/stations');
    const green = res.body.stations.find((s) => s.env === 'green-station');
    const row = green.checks.find((c) => c.id === 'pull-task');
    assert.equal(row.explain, 'Verifies the Windows scheduled task that refreshes this machine every 15 minutes exists and is healthy.');
    assert.deepEqual(Object.keys(row).sort(), ['detail', 'explain', 'id', 'level', 'name']);
  } finally {
    stub.close();
  }
});

// @plan:check-explainers-hub-2026-08-27 @promote
test('TP-checkexp-002: non-string or oversized `explain` is DROPPED, never coerced — the trim stays a security boundary', async () => {
  const stub = await startStubApi();
  try {
    const res = await request(appFor(stub.url)).get('/api/stations');
    const green = res.body.stations.find((s) => s.env === 'green-station');
    for (const id of ['x-explain-object', 'x-explain-number', 'x-explain-huge']) {
      const row = green.checks.find((c) => c.id === id);
      assert.ok(!('explain' in row), `${id}: guarded explain value must be dropped, key absent`);
    }
    assert.ok(!res.text.includes('x-explain-secret-NEVER-IN-RESPONSE'), 'object-valued explain never leaks its contents');
    assert.ok(!res.text.includes('[object Object]'), 'explain is drop-not-coerce — String() coercion is the bug this guards');
    assert.ok(!res.text.includes('x'.repeat(1001)), 'oversized explain string never rides the prose field');
  } finally {
    stub.close();
  }
});

// @plan:check-explainers-hub-2026-08-27 @promote
test('TP-checkexp-003: rows without `explain` carry exactly the original four keys — no padding (older cached reports)', async () => {
  const stub = await startStubApi();
  try {
    const res = await request(appFor(stub.url)).get('/api/stations');
    const green = res.body.stations.find((s) => s.env === 'green-station');
    const row = green.checks.find((c) => c.id === 'node');
    assert.deepEqual(row, { id: 'node', level: 'OK', name: 'node', detail: 'v24.18.0' }, 'no explain key, no empty-string padding');
  } finally {
    stub.close();
  }
});

test('TP-stations-010: new-shape cp-env rows trim like any other check — grouping data dropped, strings survive', async () => {
  const stub = await startStubApi();
  try {
    const res = await request(appFor(stub.url)).get('/api/stations');
    const green = res.body.stations.find((s) => s.env === 'green-station');
    const row = green.checks.find((c) => c.id === 'cp-env:hub:GOOGLE_OAUTH_CLIENT_ID');
    assert.deepEqual(row, {
      id: 'cp-env:hub:GOOGLE_OAUTH_CLIENT_ID',
      level: 'OK',
      name: 'hub: Google sign-in',
      detail: 'ready — GOOGLE_OAUTH_CLIENT_ID, GOOGLE_OAUTH_CLIENT_SECRET set in ~/agent/hub/repo/.env',
    }, 'everything the panel needs rides id/name/detail; data.service/capability/vars/state/note are gone');
    const summary = green.checks.find((c) => c.id === 'cp-env:hub');
    assert.deepEqual(Object.keys(summary).sort(), ['detail', 'id', 'level', 'name']);
    assert.ok(!res.text.includes('x-secret-note-NEVER-IN-RESPONSE'), 'cp-env data notes never reach the response');
  } finally {
    stub.close();
  }
});

test('TP-stations-004: null report / missing results tolerated as an empty check list', async () => {
  const stub = await startStubApi();
  try {
    const res = await request(appFor(stub.url)).get('/api/stations');
    const s = res.body.stations.find((x) => x.env === 'fresh-but-stale');
    assert.deepEqual(s.checks, []);
    assert.equal(s.publicIp, '', 'null public_ip folds to empty string');
  } finally {
    stub.close();
  }
});

test('TP-stations-005: ?stale_minutes= forwarded only as a positive integer', async () => {
  const stub = await startStubApi();
  try {
    const app = appFor(stub.url);
    const ok = await request(app).get('/api/stations?stale_minutes=10');
    assert.equal(ok.body.staleMinutes, 10, 'override reached the feed and its echo came back');
    for (const bad of ['0', '-5', 'abc', '10;DROP', '1.5']) {
      await request(app).get(`/api/stations?stale_minutes=${encodeURIComponent(bad)}`);
    }
    const calls = stub.seen.filter((r) => r.path === '/station');
    assert.equal(calls[0].query.stale_minutes, '10');
    for (const c of calls.slice(1)) assert.ok(!('stale_minutes' in c.query), 'invalid override dropped, not forwarded');
  } finally {
    stub.close();
  }
});

test('TP-stations-006: empty registry is normal — never-reported roster alone, or nothing at all, still 200', async () => {
  const silentOnly = await startStubApi({ stations: [], never: ['azure-vm', 'windows-pc'] });
  try {
    const res = await request(appFor(silentOnly.url)).get('/api/stations');
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.stations, []);
    assert.deepEqual(res.body.neverReported, ['azure-vm', 'windows-pc']);
  } finally {
    silentOnly.close();
  }
  const empty = await startStubApi({ stations: [], never: [] });
  try {
    const res = await request(appFor(empty.url)).get('/api/stations');
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.stations, []);
    assert.deepEqual(res.body.neverReported, []);
  } finally {
    empty.close();
  }
});

test('TP-stations-007: feed down → 502; unset LOG_API_URL → 503', async () => {
  const stub = await startStubApi();
  stub.close();
  const down = await request(appFor(stub.url)).get('/api/stations');
  assert.equal(down.status, 502);
  assert.match(down.body.error, /could not be reached/i);
  const unconfigured = await request(makeApp({ authBypass: true, logApiUrl: '' })).get('/api/stations');
  assert.equal(unconfigured.status, 503);
  assert.match(unconfigured.body.error, /not configured/i);
});

test('TP-stations-008: every feed call carries X-Api-Key; the key never appears in a response', async () => {
  const stub = await startStubApi();
  try {
    const res = await request(appFor(stub.url)).get('/api/stations');
    for (const r of stub.seen) assert.equal(r.key, API_KEY);
    assert.ok(!res.text.includes(API_KEY));
  } finally {
    stub.close();
  }
});

test('TP-stations-009: envelope tolerance — missing stations/never_reported keys fold to empty arrays', async () => {
  const stub = await startStubApi({ broken: true });
  try {
    const res = await request(appFor(stub.url)).get('/api/stations');
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.stations, []);
    assert.deepEqual(res.body.neverReported, []);
  } finally {
    stub.close();
  }
});
