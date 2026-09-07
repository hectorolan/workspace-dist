// NSG ssh-allowlist vs public-IP mismatch check
// (test plan `ws plan get nsg-ip-mismatch-check-2026-08-26`).
//
// The 2026-08-25 incident in one sentence: this station's public IP rotated, the NSG's
// inbound ssh rule still named the old one, port 22 went dark, and the log-API tunnel
// died for hours with nothing naming the cause. These tests pin the two halves of the
// answer — the comparison, and the exact `az` command a HUMAN runs — plus the hard rule
// that the check only ever READS.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  nsgAllowlistCheck,
  azureNames,
  stationHasTunnel,
  fixCommand,
  classifyAz,
  parseSshRules,
  portCovers22,
  ipInPrefix,
  nsgCoverage,
  isIpv4,
  servesFromCache,
  RULE_QUERY,
} from '../util/nsgcheck.js';
import { checksFailed } from '../util-tools/env-doctor.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const NAMES = { resourceGroup: 'rg-agent-workspace', nsgName: 'agent-workerNSG', sshRuleName: 'default-allow-ssh' };
const OLD_IP = '23.93.84.179';
const NEW_IP = '23.93.91.227';

/** A throwaway workspace root carrying just the config this check reads. */
function fakeRoot(/** @type {any} */ cfg) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'ws-nsg-'));
  mkdirSync(path.join(root, 'configs'), { recursive: true });
  writeFileSync(path.join(root, 'configs', 'environments.json'), JSON.stringify(cfg));
  return root;
}

/** az stub + recorder: every argv this check can produce is captured for the read-only proof. */
function azStub(/** @type {string} */ out, ok = true, status = 0) {
  /** @type {string[][]} */
  const calls = [];
  return {
    calls,
    run: (/** @type {string} */ cmd, /** @type {string[]} */ argv) => {
      calls.push([cmd, ...argv]);
      return { ok, out, status };
    },
  };
}

const rulesJson = (/** @type {string} */ src) => JSON.stringify([
  { name: 'default-allow-ssh', src, srcs: null, port: '22' },
  { name: 'http', src: '*', srcs: null, port: '80' },
]);

/** Everything the check needs except the scenario under test. */
const base = (over = {}) => ({ root: ROOT, hasTunnel: true, names: NAMES, ip: NEW_IP, readCacheFn: () => null, writeCacheFn: () => {}, now: () => 1_000_000, ...over });

test('TP-nsg-ip-mismatch-check-2026-08-26-001: a station with no logApiTunnel is skipped, and az is never spawned', async () => {
  const az = azStub(rulesJson(NEW_IP));
  const r = await nsgAllowlistCheck(base({ hasTunnel: false, run: az.run }));
  assert.equal(r.id, 'nsg-ssh-allowlist');
  assert.equal(r.level, 'INFO');
  assert.match(r.detail, /no logApiTunnel/);
  assert.equal(az.calls.length, 0);
  // and the real config resolves the two station kinds correctly
  const root = fakeRoot({ environments: { 'windows-pc': { logApiTunnel: { sshTarget: 'u@h' } }, 'azure-vm': {} } });
  assert.equal(stationHasTunnel(root, 'windows-pc'), true);
  assert.equal(stationHasTunnel(root, 'azure-vm'), false);
  assert.equal(stationHasTunnel(root, 'not-a-station'), false);
});

test('TP-nsg-ip-mismatch-check-2026-08-26-002: az absent on PATH is INFO, never FAIL', async () => {
  const az = azStub("'az' is not recognized as an internal or external command", false, 1);
  const r = await nsgAllowlistCheck(base({ run: az.run }));
  assert.equal(r.level, 'INFO');
  assert.match(r.detail, /az CLI not on PATH/);
  assert.equal(classifyAz({ ok: false, out: 'az: command not found' }), 'absent');
});

test('TP-nsg-ip-mismatch-check-2026-08-26-003: az present but unauthenticated is INFO naming az login', async () => {
  const az = azStub("Please run 'az login' to setup account.", false, 1);
  const r = await nsgAllowlistCheck(base({ run: az.run }));
  assert.equal(r.level, 'INFO');
  assert.match(r.detail, /az login/);
  assert.equal(classifyAz({ ok: false, out: 'ERROR: Please run az login to setup account' }), 'not-logged-in');
  assert.equal(classifyAz({ ok: true, out: '[]' }), 'ok');
  assert.equal(classifyAz({ ok: false, out: 'ResourceNotFound' }), 'error');
});

test('TP-nsg-ip-mismatch-check-2026-08-26-004: missing controlPlane.azure config is INFO naming the missing keys; no name is invented', async () => {
  const az = azStub(rulesJson(NEW_IP));
  const noBlock = fakeRoot({ environments: {} });
  const resolved = azureNames(noBlock);
  assert.equal(resolved.names, null);
  assert.deepEqual(resolved.missing, ['resourceGroup', 'nsgName', 'sshRuleName']);
  const r = await nsgAllowlistCheck(base({ names: null, missing: resolved.missing, run: az.run }));
  assert.equal(r.level, 'INFO');
  assert.match(r.detail, /resourceGroup, nsgName, sshRuleName/);
  assert.equal(az.calls.length, 0);
  // partials are reported as partials
  const partial = fakeRoot({ controlPlane: { azure: { resourceGroup: 'rg-x' } }, environments: {} });
  assert.deepEqual(azureNames(partial).missing, ['nsgName', 'sshRuleName']);
  // and the live config carries all three (this is what production reads)
  assert.deepEqual(Object.keys(azureNames(ROOT).names || {}).sort(), ['nsgName', 'resourceGroup', 'sshRuleName']);
});

test('TP-nsg-ip-mismatch-check-2026-08-26-005: an unresolvable or non-IPv4 public IP is INFO with no az call', async () => {
  const az = azStub(rulesJson(NEW_IP));
  const none = await nsgAllowlistCheck(base({ ip: undefined, ipFn: async () => null, run: az.run }));
  assert.equal(none.level, 'INFO');
  assert.match(none.detail, /public IP could not be probed/);
  const v6 = await nsgAllowlistCheck(base({ ip: '2606:4700::1111', run: az.run }));
  assert.equal(v6.level, 'INFO');
  assert.match(v6.detail, /IPv4-only/);
  assert.equal(az.calls.length, 0);
  assert.equal(isIpv4('23.93.91.227'), true);
  assert.equal(isIpv4('999.1.1.1'), false);
  assert.equal(isIpv4(''), false);
});

test('TP-nsg-ip-mismatch-check-2026-08-26-006: the lived mismatch FAILs and carries the exact az fix command', async () => {
  const az = azStub(rulesJson(OLD_IP));
  const r = await nsgAllowlistCheck(base({ run: az.run }));
  assert.equal(r.level, 'FAIL');
  assert.match(r.detail, new RegExp(NEW_IP));
  assert.match(r.detail, new RegExp(OLD_IP));
  assert.match(
    r.detail,
    /az network nsg rule update --nsg-name agent-workerNSG -g rg-agent-workspace --name default-allow-ssh --source-address-prefixes 23\.93\.91\.227/,
  );
  assert.equal(r.data?.fix, fixCommand(NAMES, NEW_IP));
  assert.equal(r.data?.state, 'not-covered');
  assert.equal(r.data?.ip, NEW_IP);
});

test('TP-nsg-ip-mismatch-check-2026-08-26-007: an exact source, a containing CIDR, and a wildcard all read as covered', async () => {
  const exact = await nsgAllowlistCheck(base({ run: azStub(rulesJson(NEW_IP)).run }));
  assert.equal(exact.level, 'OK');
  assert.match(exact.detail, /default-allow-ssh \(23\.93\.91\.227\)/);
  const cidr = await nsgAllowlistCheck(base({ run: azStub(rulesJson('23.93.88.0/21')).run }));
  assert.equal(cidr.level, 'OK');
  assert.match(cidr.detail, /23\.93\.88\.0\/21/);
  const anyIp = await nsgAllowlistCheck(base({ run: azStub(rulesJson('Internet')).run }));
  assert.equal(anyIp.level, 'OK');
  // no ssh-reaching rule at all: WARN (cannot compare), never a FAIL with a bogus fix
  const noRule = await nsgAllowlistCheck(base({ run: azStub(JSON.stringify([{ name: 'http', src: '*', port: '80' }])).run }));
  assert.equal(noRule.level, 'WARN');
  assert.equal(noRule.data?.state, 'unknown');
  // prefix maths + port-range parsing, the pieces the verdict rests on
  assert.ok(ipInPrefix(NEW_IP, '23.93.91.227'));
  assert.ok(!ipInPrefix(NEW_IP, OLD_IP));
  assert.deepEqual(nsgCoverage(NEW_IP, [{ name: 'r', src: '23.93.91.0/24' }]), { state: 'covered', by: 'r (23.93.91.0/24)' });
  assert.deepEqual(nsgCoverage(null, [{ name: 'r', src: '*' }]), { state: 'unknown', by: null });
  assert.equal(portCovers22('*'), true);
  assert.equal(portCovers22('22'), true);
  assert.equal(portCovers22('20-30'), true);
  assert.equal(portCovers22('80,22'), true);
  assert.equal(portCovers22('80'), false);
  assert.equal(portCovers22(''), false);
  assert.equal(parseSshRules('not json').length, 0);
});

test('TP-nsg-ip-mismatch-check-2026-08-26-008: every Azure name in the command comes from config, none from code', async () => {
  const other = { resourceGroup: 'rg-other', nsgName: 'otherNSG', sshRuleName: 'allow-ssh-2' };
  const az = azStub(rulesJson(OLD_IP));
  const r = await nsgAllowlistCheck(base({ names: other, run: az.run }));
  assert.match(r.detail, /az network nsg rule update --nsg-name otherNSG -g rg-other --name allow-ssh-2 --source-address-prefixes 23\.93\.91\.227/);
  assert.deepEqual(az.calls[0].slice(0, 8), ['az', 'network', 'nsg', 'rule', 'list', '-g', 'rg-other', '--nsg-name']);
  // the module itself names no Azure resource — a changed config changes everything
  const src = readFileSync(path.join(ROOT, 'cli', 'util', 'nsgcheck.js'), 'utf8');
  for (const literal of ['agent-workerNSG', 'rg-agent-workspace', 'default-allow-ssh']) {
    assert.equal(src.includes(literal), false, `${literal} must not be hardcoded in nsgcheck.js`);
  }
});

test('TP-nsg-ip-mismatch-check-2026-08-26-009: a covered verdict for the same IP serves from cache; a rotation re-reads the rule', async () => {
  const now = 5_000_000;
  const covered = { ip: NEW_IP, state: 'covered', at: now - 60_000 };
  assert.equal(servesFromCache(covered, NEW_IP, false, now), true);
  assert.equal(servesFromCache(covered, OLD_IP, false, now), false, 'a rotated IP must re-measure');
  assert.equal(servesFromCache(covered, NEW_IP, true, now), false, 'force must re-measure');
  assert.equal(servesFromCache({ ...covered, state: 'not-covered' }, NEW_IP, false, now), false);
  assert.equal(servesFromCache({ ...covered, at: now - 25 * 60 * 60 * 1000 }, NEW_IP, false, now), false, 'stale beyond a day re-measures');
  assert.equal(servesFromCache(null, NEW_IP, false, now), false);

  const az = azStub(rulesJson(NEW_IP));
  const cachedRun = await nsgAllowlistCheck(base({ run: az.run, readCacheFn: () => covered, now: () => now }));
  assert.equal(cachedRun.level, 'OK');
  assert.equal(cachedRun.data?.cached, true);
  assert.equal(az.calls.length, 0, 'the steady-state tick must not pay for an az call');

  /** @type {any[]} */
  const written = [];
  const rotated = await nsgAllowlistCheck(base({ run: az.run, ip: OLD_IP, readCacheFn: () => covered, writeCacheFn: (/** @type {any} */ v) => written.push(v), now: () => now }));
  assert.equal(az.calls.length, 1, 'a changed IP re-reads the rule on this very tick');
  assert.equal(rotated.level, 'FAIL');
  assert.deepEqual(written, [{ ip: OLD_IP, state: 'not-covered', at: now }]);
});

test('TP-nsg-ip-mismatch-check-2026-08-26-010: env-doctor wires the check and a mismatch fails the station', async () => {
  const doctor = readFileSync(path.join(ROOT, 'cli', 'util-tools', 'env-doctor.js'), 'utf8');
  assert.match(doctor, /nsgAllowlistCheck/);
  assert.match(doctor, /results\.push\(await nsgAllowlistCheck\(/);
  const fail = await nsgAllowlistCheck(base({ run: azStub(rulesJson(OLD_IP)).run }));
  assert.equal(checksFailed([{ id: 'node', level: 'OK', name: 'node', detail: 'v26' }, fail]), true);
  const ok = await nsgAllowlistCheck(base({ run: azStub(rulesJson(NEW_IP)).run }));
  assert.equal(checksFailed([ok]), false);
});

test('TP-nsg-ip-mismatch-check-2026-08-26-014: every az invocation the check can make is a READ', async () => {
  const az = azStub(rulesJson(OLD_IP));
  for (const scenario of [base({ run: az.run }), base({ run: az.run, ip: OLD_IP }), base({ run: az.run, names: { resourceGroup: 'g', nsgName: 'n', sshRuleName: 's' } })]) {
    await nsgAllowlistCheck(scenario);
  }
  assert.ok(az.calls.length >= 3);
  for (const call of az.calls) {
    assert.equal(call[0], 'az');
    assert.deepEqual(call.slice(1, 5), ['network', 'nsg', 'rule', 'list']);
    for (const verb of ['update', 'create', 'delete', 'set']) {
      assert.equal(call.includes(verb), false, `az argv must never carry '${verb}'`);
    }
    assert.ok(call.includes(RULE_QUERY));
  }
});

test('TP-nsg-ip-mismatch-check-2026-08-26-015: station-bootstrap keeps its ipInPrefix/nsgCoverage surface after the move', async () => {
  const bootstrap = await import('../util-tools/station-bootstrap.js');
  assert.equal(bootstrap.ipInPrefix, ipInPrefix, "the tool must re-export the shared implementation, not a copy");
  assert.equal(bootstrap.nsgCoverage, nsgCoverage);
  assert.ok(bootstrap.ipInPrefix('23.93.84.179', '23.93.84.0/24'));
});
