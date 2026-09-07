// TP-station-registry (client half): cli/util/station.js - the fail-soft
// station-registry reporter the `ws pull` tick runs (W3/D1b). All seams
// injected; no network, no real probes. Cases: `ws plan get test-plan-station-registry`.
import test from 'node:test';
import assert from 'node:assert/strict';
import { reportStation, publicIp } from '../util/station.js';

const okHealth = async () => JSON.stringify({ ok: true, entries: 1 });

test('TP-station-registry-009: happy path - consumes the env-doctor payload as-is, adds publicIp, PUTs keyed by env', async () => {
  /** @type {any[]} */
  const puts = [];
  const payload = { env: 'st-x', platform: 'win32', ok: true, results: [{ id: 'gh-scopes', level: 'INFO' }] };
  const r = await reportStation({
    env: 'st-x',
    healthFn: okHealth,
    collect: async () => ({ ...payload }),
    ip: async () => '198.51.100.4',
    put: async (env, report) => { puts.push([env, report]); return { line: 'l', created: true }; },
  });
  assert.deepEqual(r, { status: 'reported', env: 'st-x', ok: true, detail: 'row created' });
  assert.equal(puts.length, 1);
  assert.equal(puts[0][0], 'st-x');
  // The W1 payload passes through untouched (REUSE, not re-derive - and no new
  // fields that could carry a secret); publicIp is the ONLY addition.
  assert.deepEqual(puts[0][1], { ...payload, publicIp: '198.51.100.4' });
});

test('TP-station-registry-010: unreachable API -> offline, the collector is never invoked (offline ticks stay fast)', async () => {
  let collected = 0;
  const r = await reportStation({
    env: 'st-x',
    healthFn: async () => { throw new Error('ECONNREFUSED'); },
    collect: async () => { collected++; return {}; },
    put: async () => { throw new Error('must not be called'); },
  });
  assert.equal(r.status, 'offline');
  assert.equal(collected, 0);
});

test('TP-station-registry-011: no WS_ENV -> no-identity, no PUT attempted', async () => {
  let called = 0;
  const r = await reportStation({
    env: '',
    healthFn: okHealth,
    collect: async () => ({}),
    put: async () => { called++; return { line: '', created: false }; },
  });
  assert.equal(r.status, 'no-identity');
  assert.equal(called, 0);
});

test('TP-station-registry-012: a rejecting PUT -> failed, never a throw (the pull tick continues)', async () => {
  const r = await reportStation({
    env: 'st-x',
    healthFn: okHealth,
    collect: async () => ({ ok: true }),
    ip: async () => null,
    put: async () => { throw new Error('boom 500'); },
  });
  assert.equal(r.status, 'failed');
  assert.match(r.detail, /boom 500/);
});

test('TP-station-registry-013: a failed public-IP probe still lands the report with publicIp null', async () => {
  /** @type {any} */
  let sent = null;
  const r = await reportStation({
    env: 'st-x',
    healthFn: okHealth,
    collect: async () => ({ ok: false }),
    ip: async () => null,
    put: async (env, report) => { sent = report; return { line: 'l', created: false }; },
  });
  assert.equal(r.status, 'reported');
  assert.equal(r.ok, false);
  assert.equal(sent.publicIp, null);
});

test('TP-station-registry-014: publicIp() is fail-soft and shape-checked', async () => {
  /** @param {any} impl */
  const withFetch = (impl) => publicIp({ url: 'https://example.invalid', fetchFn: impl });
  assert.equal(await withFetch(async () => ({ ok: false, text: async () => '' })), null);
  assert.equal(await withFetch(async () => ({ ok: true, text: async () => '<html>error</html>' })), null);
  assert.equal(await withFetch(async () => { throw new Error('offline'); }), null);
  assert.equal(await withFetch(async () => ({ ok: true, text: async () => ' 203.0.113.7\n' })), '203.0.113.7');
  assert.equal(await withFetch(async () => ({ ok: true, text: async () => '2001:db8::1' })), '2001:db8::1');
});
