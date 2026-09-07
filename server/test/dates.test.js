'use strict';

// Day-window cutoffs in the SCHEDULE timezone (audit 2026-07-26 M9; plan
// `ws plan get test-plan-server-tz-day-windows`). Row `date` stamps and every
// `?days=` cutoff must come from the timezone in the jobs config (WS_JOBS_CONFIG
// seam — the same knob the scheduler honors), never raw UTC / host TZ.
//
// Zone choice makes the pin runtime-independent: Pacific/Kiritimati (UTC+14)
// differs from UTC whenever the UTC hour is >= 10, Etc/GMT+12 (UTC-12) differs
// whenever it is < 12 — so at ANY moment at least one zone's calendar date is
// not the UTC date, and a UTC-based implementation fails at least one zone.

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const API_KEY = 'test-key-tz';

/** Calendar date YYYY-MM-DD of (now - offsetDays) in `timeZone` (host TZ when undefined). */
const zoneDate = (timeZone, offsetDays = 0) =>
  new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' })
    .format(new Date(Date.now() - offsetDays * 86400000));

/** Spawn one server with its own temp DB + jobs config; resolve helpers bound to it. */
async function startServer({ timezone, jobsConfigPath } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'logapi-dates-test-'));
  let cfg = jobsConfigPath;
  if (!cfg) {
    cfg = path.join(dir, 'jobs.json');
    fs.writeFileSync(cfg, JSON.stringify({ timezone, jobs: [] }));
  }
  const proc = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: {
      ...process.env,
      LOG_DB_PATH: path.join(dir, 'logs.db'),
      LOG_API_PORT: '0',
      LOG_API_HOST: '127.0.0.1',
      LOG_API_KEY: API_KEY,
      WS_JOBS_CONFIG: cfg,
    },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  const base = await new Promise((resolve, reject) => {
    let out = '';
    const timer = setTimeout(() => reject(new Error('server did not start: ' + out)), 10000);
    proc.stdout.on('data', (d) => {
      out += d;
      const m = out.match(/listening on (http:\/\/127\.0\.0\.1:\d+)/);
      if (m) { clearTimeout(timer); resolve(m[1]); }
    });
    proc.on('exit', (code) => reject(new Error('server exited early: ' + code + ' ' + out)));
  });
  const api = (p, opts = {}) =>
    fetch(base + p, { ...opts, headers: { 'X-Api-Key': API_KEY, ...(opts.headers || {}) } });
  const post = (p, fields) =>
    api(p, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(fields).toString(),
    });
  return { proc, api, post };
}

for (const tz of ['Pacific/Kiritimati', 'Etc/GMT+12']) {
  test(`schedule-timezone day windows — ${tz}`, async (t) => {
    const { proc, api, post } = await startServer({ timezone: tz });
    t.after(() => proc.kill());
    const today = zoneDate(tz, 0);
    const yesterday = zoneDate(tz, 1);
    const twoDaysAgo = zoneDate(tz, 2);

    await t.test('TP-server-tz-001: POST /log stamps date in the schedule timezone', async () => {
      const res = await post('/log', { area: 'tz-stamp', status: 'done', message: 'stamped now' });
      assert.equal(res.status, 201);
      assert.equal((await res.json()).entry.date, today);
    });

    await t.test('TP-server-tz-002: GET /log?days=1 cutoff is the schedule-TZ date', async () => {
      await post('/log', { area: 'tz-win', status: 'done', message: 'row from yesterday', date: yesterday });
      await post('/log', { area: 'tz-win', status: 'done', message: 'row from two days ago', date: twoDaysAgo });
      const text = await (await api('/log?days=1&area=tz-win')).text();
      assert.match(text, /row from yesterday/);
      assert.doesNotMatch(text, /row from two days ago/);
    });

    await t.test('TP-server-tz-003: GET /summary?days=1 cutoff is the schedule-TZ date', async () => {
      await post('/log', { repo: 'tz-fresh', area: 'a', status: 'done', message: 'in window', date: yesterday });
      await post('/log', { repo: 'tz-stale', area: 'a', status: 'done', message: 'out of window', date: twoDaysAgo });
      const text = await (await api('/summary?days=1')).text();
      assert.match(text, /## tz-fresh/);
      assert.doesNotMatch(text, /## tz-stale/);
    });

    await t.test('TP-server-tz-004: GET /message?days=1 cutoff is the schedule-TZ date', async () => {
      await post('/message', { kind: 'tz-doc', ref: 'fresh', subject: 'fresh doc', body: 'b', date: yesterday });
      await post('/message', { kind: 'tz-doc', ref: 'stale', subject: 'stale doc', body: 'b', date: twoDaysAgo });
      const text = await (await api('/message?days=1&kind=tz-doc')).text();
      assert.match(text, /fresh doc/);
      assert.doesNotMatch(text, /stale doc/);
    });
  });
}

test('TP-server-tz-005: unreadable jobs config falls back to the host timezone', async (t) => {
  const { proc, post } = await startServer({ jobsConfigPath: path.join(os.tmpdir(), 'no-such-dir', 'jobs.json') });
  t.after(() => proc.kill());
  const res = await post('/log', { area: 'tz-fallback', status: 'done', message: 'still works' });
  assert.equal(res.status, 201);
  const { entry } = await res.json();
  assert.match(entry.date, /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(entry.date, zoneDate(undefined, 0)); // host-TZ today
});
