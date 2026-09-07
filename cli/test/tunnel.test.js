// TP-log-api-tunnel: the SSH transport for environments that reach the log API across
// the internet (audit finding WS-M5 — the API key must never travel in cleartext).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tunnelConfig, sshArgs, portOpen, ensureTunnel, makeRespawnReporter, looksLikeConnectFailure, diagnoseConnectFailure } from '../util/tunnel.js';

/** @param {object} environments @returns {string} a throwaway workspace root */
function fakeRoot(environments) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'ws-tunnel-'));
  mkdirSync(path.join(root, 'configs'), { recursive: true });
  writeFileSync(
    path.join(root, 'configs', 'environments.json'),
    JSON.stringify({ scheduleOwner: 'azure-vm', environments }),
  );
  return root;
}

const withEnv = (/** @type {string|undefined} */ v, /** @type {() => any} */ fn) => {
  const prev = process.env.WS_ENV;
  if (v === undefined) delete process.env.WS_ENV;
  else process.env.WS_ENV = v;
  try {
    return fn();
  } finally {
    if (prev === undefined) delete process.env.WS_ENV;
    else process.env.WS_ENV = prev;
  }
};

test('TP-log-api-tunnel-001: config is read for THIS environment only', () => {
  const root = fakeRoot({
    'windows-pc': { logApiTunnel: { sshTarget: 'user@host', localPort: 8790, remotePort: 8790 } },
    'azure-vm': { role: 'API host' },
  });
  const pc = withEnv('windows-pc', () => tunnelConfig(root));
  assert.equal(pc?.sshTarget, 'user@host');
  assert.equal(pc?.localPort, 8790);
  assert.equal(withEnv('azure-vm', () => tunnelConfig(root)), null, 'the API host has no tunnel');
  assert.equal(withEnv(undefined, () => tunnelConfig(root)), null, 'no WS_ENV = no tunnel');
});

test('TP-log-api-tunnel-002: ports default, a config without an ssh target is ignored', () => {
  const root = fakeRoot({ 'windows-pc': { logApiTunnel: { sshTarget: 'user@host' } } });
  const cfg = withEnv('windows-pc', () => tunnelConfig(root));
  assert.equal(cfg?.localPort, 8790);
  assert.equal(cfg?.remotePort, 8790);
  const bad = fakeRoot({ 'windows-pc': { logApiTunnel: { localPort: 8790 } } });
  assert.equal(withEnv('windows-pc', () => tunnelConfig(bad)), null);
});

test('TP-log-api-tunnel-003: ssh args forward loopback→loopback and never prompt', () => {
  const args = sshArgs({ sshTarget: 'user@host', localPort: 8791, remotePort: 8790 });
  assert.ok(args.includes('-N'), 'no remote command');
  assert.ok(args.includes('BatchMode=yes'), 'never prompts (runs unattended)');
  assert.ok(args.includes('ExitOnForwardFailure=yes'), 'dies instead of pretending to forward');
  assert.ok(args.includes('127.0.0.1:8791:127.0.0.1:8790'), 'binds loopback only');
  assert.equal(args.at(-1), 'user@host', 'target is last');
});

test('TP-log-api-tunnel-004: ensureTunnel is a no-op where no tunnel is configured', async () => {
  const root = fakeRoot({ 'azure-vm': { role: 'API host' } });
  assert.equal(await withEnv('azure-vm', () => ensureTunnel(root)), 'no-config');
});

test('TP-log-api-tunnel-005: a live listener on the port counts as "up" (no second ssh)', async () => {
  const server = net.createServer();
  await new Promise((r) => server.listen(0, '127.0.0.1', () => r(undefined)));
  const port = /** @type {import('node:net').AddressInfo} */ (server.address()).port;
  try {
    assert.equal(await portOpen(port), true);
    const root = fakeRoot({ 'windows-pc': { logApiTunnel: { sshTarget: 'user@host', localPort: port } } });
    assert.equal(await withEnv('windows-pc', () => ensureTunnel(root)), 'up');
  } finally {
    server.close();
  }
  assert.equal(await portOpen(port), false, 'a closed port is not "up"');
});

// ---- TP-jest-edge-tun: failure-edge expansion (skills-integration Phase 1b,
// jest-skill methodology on node:test — see ws plan get
// test-plan-jest-skill-edge-coverage). Config failures must degrade to a null
// config (module no-ops), never a throw.

/** @param {string} content raw environments.json body @returns {string} root */
function rawRoot(content) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'ws-tunnel-'));
  mkdirSync(path.join(root, 'configs'), { recursive: true });
  writeFileSync(path.join(root, 'configs', 'environments.json'), content);
  return root;
}

test('TP-jest-edge-tun-001: malformed environments.json yields null config, no throw', () => {
  const root = rawRoot('{ "environments": { truncated');
  assert.equal(withEnv('windows-pc', () => tunnelConfig(root)), null);
});

test('TP-jest-edge-tun-002: missing environments.json yields null config', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'ws-tunnel-'));
  assert.equal(withEnv('windows-pc', () => tunnelConfig(root)), null);
});

test('TP-jest-edge-tun-003: unusable configs all yield null (table-driven)', () => {
  const cases = [
    ['WS_ENV absent from the file', fakeRoot({ 'azure-vm': {} })],
    ['logApiTunnel is null', fakeRoot({ 'windows-pc': { logApiTunnel: null } })],
    ['logApiTunnel is a string', fakeRoot({ 'windows-pc': { logApiTunnel: 'user@host' } })],
    ['sshTarget is empty', fakeRoot({ 'windows-pc': { logApiTunnel: { sshTarget: '' } } })],
    ['sshTarget is a number', fakeRoot({ 'windows-pc': { logApiTunnel: { sshTarget: 42 } } })],
  ];
  for (const [label, root] of cases) {
    assert.equal(withEnv('windows-pc', () => tunnelConfig(root)), null, label);
  }
});

test('TP-jest-edge-tun-004: non-numeric localPort defaults to 8790; remotePort follows localPort', () => {
  const bad = fakeRoot({ 'windows-pc': { logApiTunnel: { sshTarget: 'user@host', localPort: 'abc' } } });
  const cfg = withEnv('windows-pc', () => tunnelConfig(bad));
  assert.equal(cfg?.localPort, 8790);
  assert.equal(cfg?.remotePort, 8790);
  const localOnly = fakeRoot({ 'windows-pc': { logApiTunnel: { sshTarget: 'user@host', localPort: 9377 } } });
  const cfg2 = withEnv('windows-pc', () => tunnelConfig(localOnly));
  assert.equal(cfg2?.localPort, 9377);
  assert.equal(cfg2?.remotePort, 9377, 'remotePort defaults to localPort, not 8790');
});

test('TP-jest-edge-tun-005: sshArgs adds -i only when the identity file exists', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'ws-tunnel-key-'));
  const key = path.join(dir, 'id_test');
  writeFileSync(key, 'fake key material');
  const withKey = sshArgs({ sshTarget: 'user@host', localPort: 8791, remotePort: 8790, identityFile: key });
  assert.equal(withKey[withKey.indexOf('-i') + 1], key);
  const bogus = path.join(dir, 'no-such-key');
  const withoutKey = sshArgs({ sshTarget: 'user@host', localPort: 8791, remotePort: 8790, identityFile: bogus });
  assert.equal(withoutKey.includes('-i'), false, 'a missing key file must not be passed to ssh');
  assert.equal(withoutKey.at(-1), 'user@host');
});

test('TP-jest-edge-tun-006: ensureTunnel fails cleanly when the supervisor tool is missing (no spawn)', async () => {
  // A port that was just released is as close to "definitely closed" as loopback gets.
  const server = net.createServer();
  await new Promise((r) => server.listen(0, '127.0.0.1', () => r(undefined)));
  const port = /** @type {import('node:net').AddressInfo} */ (server.address()).port;
  await new Promise((r) => server.close(() => r(undefined)));
  const root = fakeRoot({ 'windows-pc': { logApiTunnel: { sshTarget: 'user@host', localPort: port } } });
  // fakeRoot has no cli/util-tools/log-api-tunnel.js → 'failed' before any spawn attempt.
  assert.equal(await withEnv('windows-pc', () => ensureTunnel(root)), 'failed');
});

// ---- TP-obs48a: respawn observability (backlog 48a — silent-success pair; see
// ws plan get test-plan-obs-pair-api-supervision). A RESPAWNED ssh session that is
// confirmed serving writes one central tunnel-watch line, rate-limited; boot's
// first session and dead/non-serving replacements never log.

const CFG = { sshTarget: 'user@host', localPort: 8790, remotePort: 8790 };

/** @param {Partial<Parameters<typeof makeRespawnReporter>[0]>} [over] */
function reporterHarness(over = {}) {
  /** @type {Array<Record<string, unknown>>} */
  const logged = [];
  /** @type {string[]} */
  const notes = [];
  const reporter = makeRespawnReporter({
    cfg: CFG,
    confirmDelayMs: 0,
    probe: async () => true,
    logFn: async (entry) => {
      logged.push(entry);
      return { ok: true, line: 'x' };
    },
    noteFn: (l) => notes.push(l),
    ...over,
  });
  return { reporter, logged, notes };
}

const live = { exitCode: null };

test('TP-obs48a-001/002: respawn confirmed serving logs ONE tunnel-watch line; boot session never logs', async () => {
  const { reporter, logged } = reporterHarness();
  assert.equal(reporter.onSpawn(live), null, 'boot session must be silent (no promise, no line)');
  assert.equal(await reporter.onSpawn(live), 'logged');
  assert.equal(logged.length, 1);
  assert.equal(logged[0].area, 'tunnel');
  assert.equal(logged[0].status, 'done');
  assert.equal(logged[0].agent, 'tunnel-watch');
  assert.match(String(logged[0].message), /respawned/);
  assert.match(String(logged[0].message), /127\.0\.0\.1:8790/);
  assert.match(String(logged[0].message), /user@host/);
});

test('TP-obs48a-003: flap guard — second respawn inside the window is rate-limited; minMs 0 logs every time', async () => {
  const { reporter, logged, notes } = reporterHarness(); // default window: 30 min
  reporter.onSpawn(live); // boot
  assert.equal(await reporter.onSpawn(live), 'logged');
  assert.equal(await reporter.onSpawn(live), 'rate-limited');
  assert.equal(logged.length, 1, 'the flap must not write a second central line');
  assert.ok(notes.some((n) => /rate-limited/.test(n)));
  const open = reporterHarness({ minMs: 0 });
  open.reporter.onSpawn(live);
  await open.reporter.onSpawn(live);
  await open.reporter.onSpawn(live);
  assert.equal(open.logged.length, 2, 'an elapsed window logs again');
});

test('TP-obs48a-004: a replacement that died or is not serving at confirm time never logs', async () => {
  const dead = reporterHarness();
  dead.reporter.onSpawn(live);
  assert.equal(await dead.reporter.onSpawn({ exitCode: 255 }), 'died');
  assert.equal(dead.logged.length, 0);
  const closed = reporterHarness({ probe: async () => false });
  closed.reporter.onSpawn(live);
  assert.equal(await closed.reporter.onSpawn(live), 'not-serving');
  assert.equal(closed.logged.length, 0);
});

test('TP-obs48a-005: offline fallback result is noted; a throwing logFn is swallowed (tunnel never breaks)', async () => {
  const fb = reporterHarness({
    logFn: async () => ({ ok: false, fallback: '/data/fallback/log.md' }),
  });
  fb.reporter.onSpawn(live);
  assert.equal(await fb.reporter.onSpawn(live), 'logged');
  assert.ok(fb.notes.some((n) => /queued to offline fallback/.test(n)));
  const boom = reporterHarness({
    logFn: async () => { throw new Error('ECONNREFUSED'); },
  });
  boom.reporter.onSpawn(live);
  assert.equal(await boom.reporter.onSpawn(live), 'log-failed');
  assert.ok(boom.notes.some((n) => /central log failed/.test(n)));
});

// --- connect-failure diagnosis (test plan `ws plan get nsg-ip-mismatch-check-2026-08-26`) ---
// The supervisor must name the cause of a closed network path — a rotated public IP no
// longer in the NSG ssh rule — instead of respawning ssh blindly for hours (2026-08-25).

const DIAG_CFG = { sshTarget: 'user@host', localPort: 8790, remotePort: 8790 };
const FIX = 'az network nsg rule update --nsg-name someNSG -g some-rg --name allow-ssh --source-address-prefixes 23.93.91.227';

/** A diagnosis harness with every seam captured — no fs, no network, no clock. */
/**
 * @param {{verdict?: any, logFn?: any, stampAt?: number, now?: number, minMs?: number}} [opts]
 */
function diagHarness({ verdict, logFn, stampAt = 0, now = 10_000_000, minMs = 60 * 60000 } = {}) {
  /** @type {string[]} */
  const notes = [];
  /** @type {any[]} */
  const logged = [];
  /** @type {number[]} */
  const stamps = [];
  let stamp = stampAt;
  return {
    notes, logged, stamps,
    run: () => diagnoseConnectFailure({
      cfg: DIAG_CFG,
      check: typeof verdict === 'function' ? verdict : async () => verdict,
      noteFn: (l) => notes.push(l),
      logFn: logFn || (async (/** @type {any} */ e) => { logged.push(e); return { ok: /** @type {const} */ (true), line: 'ok' }; }),
      minMs,
      now: () => now,
      readStamp: () => stamp,
      writeStamp: (at) => { stamps.push(at); stamp = at; },
    }),
  };
}

test('TP-nsg-ip-mismatch-check-2026-08-26-011: only a closed NETWORK path counts as a connect failure', () => {
  const cases = [
    ['exit 255 — ssh: connect to host 20.57.149.148 port 22: Connection timed out', 3000, true],
    ['exit 255 — ssh: connect to host h port 22: Connection refused', 2000, true],
    ['exit 255 — ssh: connect to host h port 22: No route to host', 1000, true],
    ['spawn-failed: ETIMEDOUT', 500, true],
    ['exit 255 — Permission denied (publickey)', 1000, false],
    ['exit 255 — Host key verification failed.', 1000, false],
    ['exit 0', 5000, false],
    ['exit 255 — ssh: connect to host h port 22: Connection timed out', 120000, false],
    ['', 100, false],
  ];
  for (const [detail, ranMs, want] of cases) {
    assert.equal(looksLikeConnectFailure(String(detail), Number(ranMs)), want, `${detail} @${ranMs}ms`);
  }
});

test('TP-nsg-ip-mismatch-check-2026-08-26-012: a proven mismatch writes ONE central blocked line carrying the fix', async () => {
  const h = diagHarness({ verdict: { level: 'FAIL', detail: `this station's public IP is 23.93.91.227, but someNSG/allow-ssh allows 23.93.84.179 — ssh (and the log-API tunnel) is blocked until the CEO runs: ${FIX}`, data: { fix: FIX } } });
  assert.equal(await h.run(), 'logged');
  assert.equal(h.logged.length, 1);
  assert.equal(h.logged[0].agent, 'tunnel-watch');
  assert.equal(h.logged[0].area, 'tunnel');
  assert.equal(h.logged[0].status, 'blocked');
  assert.match(h.logged[0].message, /user@host/);
  assert.match(h.logged[0].message, /az network nsg rule update .* --source-address-prefixes 23\.93\.91\.227/);
  assert.ok(h.notes.some((n) => /connect-failure diagnosis: FAIL/.test(n)));
  assert.deepEqual(h.stamps, [10_000_000]);
});

test('TP-nsg-ip-mismatch-check-2026-08-26-013: rate-limited inside the window; no cause and no crash ever reach the DB', async () => {
  const fail = { level: 'FAIL', detail: `blocked until the CEO runs: ${FIX}`, data: { fix: FIX } };
  const limited = diagHarness({ verdict: fail, stampAt: 10_000_000 - 60_000 });
  assert.equal(await limited.run(), 'rate-limited');
  assert.equal(limited.logged.length, 0);
  assert.ok(limited.notes.some((n) => /rate-limited/.test(n)));

  for (const verdict of [{ level: 'OK', detail: 'admits this station' }, { level: 'INFO', detail: 'az not on PATH' }, { level: 'WARN', detail: 'no ssh rule' }]) {
    const quiet = diagHarness({ verdict });
    assert.equal(await quiet.run(), 'no-cause');
    assert.equal(quiet.logged.length, 0, `${verdict.level} must never write a central line`);
    assert.equal(quiet.stamps.length, 0);
    assert.ok(quiet.notes.some((n) => n.includes(verdict.detail)), 'the local note still records the verdict');
  }

  // a throwing check and a throwing log client are both swallowed — the tunnel keeps trying
  const broken = diagHarness({ verdict: async () => { throw new Error('az exploded'); } });
  assert.equal(await broken.run(), 'check-failed');
  assert.ok(broken.notes.some((n) => /diagnosis errored/.test(n)));
  const noApi = diagHarness({ verdict: fail, logFn: async () => { throw new Error('ECONNREFUSED'); } });
  assert.equal(await noApi.run(), 'log-failed');
  assert.ok(noApi.notes.some((n) => /central log failed/.test(n)));
});
