// station-bootstrap - the "add a station" walk (plan environment-setup-streamlining,
// Workstream S / W6). The cases that matter most here are the D5 boundary ones: the tool
// must never render a secret VALUE, and it must never be able to satisfy a step by acting.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  redactSecrets,
  secretPresence,
  derivedLogApiUrl,
  classifySsh,
  classifyKeyscan,
  ipInPrefix,
  nsgCoverage,
  foldDoctor,
  smokeFindings,
  unmetDeps,
  overallExit,
  summarize,
  render,
  SECRETISH,
} from '../util-tools/station-bootstrap.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

// --- D5: the credential boundary ------------------------------------------------

test('TP-station-bootstrap-001 a secret-named env value is scrubbed out of any rendered line', () => {
  const env = { LOG_API_KEY: 'abcdef0123456789', WS_ENV: 'windows-pc-2' };
  const out = redactSecrets('the key is abcdef0123456789 today', env);
  assert.equal(out, 'the key is <redacted:LOG_API_KEY> today');
  assert.ok(!out.includes('abcdef0123456789'));
});

test('TP-station-bootstrap-002 non-secret names are left alone (a station name is not a credential)', () => {
  const env = { WS_ENV: 'windows-pc-2', OWNER_EMAIL: 'olanhector@gmail.com' };
  assert.equal(redactSecrets('WS_ENV=windows-pc-2', env), 'WS_ENV=windows-pc-2');
});

test('TP-station-bootstrap-003 short values never trigger redaction (a 3-char value would confetti the report)', () => {
  assert.equal(redactSecrets('a is a', { A_TOKEN: 'a' }), 'a is a');
});

test('TP-station-bootstrap-004 secretPresence reports SET/UNSET and never carries a secret value', () => {
  const seen = secretPresence(
    [
      { name: 'LOG_API_KEY', why: 'api' },
      { name: 'GMAIL_APP_PASSWORD', why: 'mail' },
      { name: 'OWNER_EMAIL', why: 'identity' },
      { name: 'NOT_SET_HERE', why: 'x' },
    ],
    { LOG_API_KEY: 'sekritvalue1234', GMAIL_APP_PASSWORD: 'p4ssw0rdvalue', OWNER_EMAIL: 'olanhector@gmail.com' },
  );
  assert.deepEqual(seen.map((s) => [s.name, s.set]), [
    ['LOG_API_KEY', true],
    ['GMAIL_APP_PASSWORD', true],
    ['OWNER_EMAIL', true],
    ['NOT_SET_HERE', false],
  ]);
  // Secret-named entries carry NO value at all - not the string, not its length.
  assert.equal(seen[0].value, null);
  assert.equal(seen[1].value, null);
  assert.equal(seen[2].value, 'olanhector@gmail.com'); // an email is identity, not a credential
  assert.ok(!JSON.stringify(seen).includes('sekritvalue1234'));
  assert.ok(!JSON.stringify(seen).includes('p4ssw0rdvalue'));
});

test('TP-station-bootstrap-005 the secret-name pattern covers every credential class this system holds', () => {
  for (const n of ['LOG_API_KEY', 'GMAIL_APP_PASSWORD', 'GITHUB_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN', 'SESSION_SECRET', 'GOOGLE_OAUTH_CLIENT_SECRET']) {
    assert.ok(SECRETISH.test(n), `${n} must be treated as secret-named`);
  }
  assert.ok(!SECRETISH.test('OWNER_EMAIL'));
  assert.ok(!SECRETISH.test('WS_ENV'));
});

test('TP-station-bootstrap-006 the tool source contains no credential-writing call (D5, enforced not asserted)', () => {
  const src = readFileSync(path.join(ROOT, 'cli', 'util-tools', 'station-bootstrap.js'), 'utf8');
  // Everything below may appear only inside an instruction STRING for the human. These
  // patterns catch the shape of a tool that started performing the action itself.
  for (const forbidden of [/spawnSync\([^)]*['"]setx['"]/, /run\(\s*['"]setx['"]/, /run\(\s*['"]ssh-keygen['"]\s*,\s*\[\s*['"]-t['"]/, /run\(\s*['"]gh['"]\s*,\s*\[\s*['"]auth['"]\s*,\s*['"]login['"]/, /writeFileSync/, /authorized_keys['"]\s*\)/]) {
    assert.ok(!forbidden.test(src), `station-bootstrap must not perform a credential action: ${forbidden}`);
  }
});

// --- LOG_API_URL is derived, not mirrorable (plan section 3, correction 4) --------

test('TP-station-bootstrap-007 LOG_API_URL is derived from THIS station localPort', () => {
  assert.equal(derivedLogApiUrl({ localPort: 8790 }), 'http://127.0.0.1:8790');
  assert.equal(derivedLogApiUrl({ localPort: 8899 }), 'http://127.0.0.1:8899');
});

test('TP-station-bootstrap-008 a station with no tunnel derives nothing (it hosts the API)', () => {
  assert.equal(derivedLogApiUrl(null), null);
  assert.equal(derivedLogApiUrl({}), null);
});

// --- PROBE, NEVER ASSUME (a): ssh reachability ------------------------------------

test('TP-station-bootstrap-009 a clean ssh exit is CONNECTED - which alone proves NSG coverage', () => {
  assert.equal(classifySsh(0, '').state, 'connected');
});

test('TP-station-bootstrap-010 each ssh failure mode names a different owner', () => {
  assert.equal(classifySsh(255, 'hector@vm: Permission denied (publickey).').state, 'denied');
  assert.equal(classifySsh(255, 'Host key verification failed.').state, 'host-key');
  assert.equal(classifySsh(255, 'ssh: connect to host 20.0.0.1 port 22: Connection timed out').state, 'unreachable');
  assert.equal(classifySsh(255, 'something else entirely').state, 'unknown');
});

// --- PROBE, NEVER ASSUME (b): ssh-keyscan is measured, never assumed --------------

test('TP-station-bootstrap-011 a KEX negotiation failure is reported as such, not as a generic error', () => {
  const v = classifyKeyscan(1, 'Unable to negotiate with 20.57.149.148 port 22: no matching key exchange method found.');
  assert.equal(v.state, 'kex-unsupported');
});

test('TP-station-bootstrap-012 a working keyscan is still not the instruction (trust-on-first-use)', () => {
  const v = classifyKeyscan(0, '# 20.57.149.148:22 SSH-2.0-OpenSSH_9.6p1\n20.57.149.148 ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAA\n');
  assert.equal(v.state, 'usable');
  assert.match(v.detail, /trust-on-first-use/);
});

test('TP-station-bootstrap-013 an empty keyscan is no-response, not success', () => {
  assert.equal(classifyKeyscan(1, '').state, 'no-response');
});

// --- NSG coverage, compared against the MEASURED public IP ------------------------

test('TP-station-bootstrap-014 exact-IP and CIDR NSG prefixes both match', () => {
  assert.ok(ipInPrefix('23.93.84.179', '23.93.84.179'));
  assert.ok(ipInPrefix('23.93.84.179', '23.93.84.0/24'));
  assert.ok(!ipInPrefix('23.93.85.1', '23.93.84.0/24'));
  assert.ok(ipInPrefix('1.2.3.4', '*'));
  assert.ok(ipInPrefix('1.2.3.4', 'Internet'));
  assert.ok(!ipInPrefix('1.2.3.4', ''));
  assert.ok(!ipInPrefix('not-an-ip', '1.2.3.0/24'));
});

test('TP-station-bootstrap-015 both PCs behind one household NAT are covered by the SAME rule (the 2026-07-28 measurement)', () => {
  const rules = [{ name: 'default-allow-ssh', src: '23.93.84.179', srcs: [] }];
  assert.deepEqual(nsgCoverage('23.93.84.179', rules), { state: 'covered', by: 'default-allow-ssh (23.93.84.179)' });
});

test('TP-station-bootstrap-016 an uncovered IP is not-covered, and an unknown IP is UNKNOWN (never assumed covered)', () => {
  const rules = [{ name: 'default-allow-ssh', src: '23.93.84.179', srcs: [] }];
  assert.equal(nsgCoverage('8.8.8.8', rules).state, 'not-covered');
  assert.equal(nsgCoverage(null, rules).state, 'unknown');
  assert.equal(nsgCoverage('8.8.8.8', []).state, 'unknown');
});

// --- env-doctor stays the verifier -------------------------------------------------

test('TP-station-bootstrap-017 a step folds env-doctor results instead of re-probing', () => {
  const results = [
    { id: 'tool:git', level: 'OK', name: 'tool git', detail: '2.55.0' },
    { id: 'tool:az', level: 'WARN', name: 'tool az', detail: 'not found' },
    { id: 'harness', level: 'FAIL', name: 'harness', detail: 'fallbackModel not set' },
  ];
  const tools = foldDoctor(results, (id) => id.startsWith('tool:'));
  assert.equal(tools.failed, false);
  assert.equal(tools.findings.length, 2);
  const harness = foldDoctor(results, (id) => id === 'harness');
  assert.equal(harness.failed, true);
});

// --- the project-work smoke check (the gap plumbing gates missed) -------------------

test('TP-station-bootstrap-018 a repo that is cloned but whose origin is unreachable FAILS the smoke check', () => {
  const f = smokeFindings(['ho-nexus'], () => ({ cloned: true, isGit: true, remoteOk: false, hasClaudeMd: true }));
  assert.equal(f[0].level, 'FAIL');
  assert.match(f[0].msg, /git credential does not work/);
});

test('TP-station-bootstrap-019 a missing project repo FAILS with the "cannot do project work" reason', () => {
  const f = smokeFindings(['ho-nexus'], () => ({ cloned: false, isGit: false, remoteOk: false, hasClaudeMd: false }));
  assert.equal(f[0].level, 'FAIL');
  assert.match(f[0].msg, /cannot do project work/);
});

test('TP-station-bootstrap-020 a clone with a reachable origin passes', () => {
  const f = smokeFindings(['ho-nexus'], () => ({ cloned: true, isGit: true, remoteOk: true, hasClaudeMd: true }));
  assert.equal(f[0].level, 'OK');
});

// --- dependency ordering + resumability --------------------------------------------

test('TP-station-bootstrap-021 a step whose prerequisite is unsatisfied is BLOCKED, never silently probed', () => {
  const statuses = new Map([['s1', 'todo'], ['s3', 'ok'], ['s4', 'skipped']]);
  assert.deepEqual(unmetDeps(['s1', 's3', 's4'], /** @type {any} */ (statuses)), ['s1']);
});

test('TP-station-bootstrap-022 skipped counts as satisfied (a container owes no Windows task)', () => {
  const statuses = new Map([['s8', 'skipped']]);
  assert.deepEqual(unmetDeps(['s8'], /** @type {any} */ (statuses)), []);
});

test('TP-station-bootstrap-023 exit 0 only when nothing is owed; blocked counts as owed', () => {
  const mk = (/** @type {string} */ status) => ({ id: 'x', n: 1, title: 't', deps: [], status, findings: [], actions: [] });
  assert.equal(overallExit(/** @type {any} */ ([mk('ok'), mk('skipped')])), 0);
  assert.equal(overallExit(/** @type {any} */ ([mk('ok'), mk('todo')])), 1);
  assert.equal(overallExit(/** @type {any} */ ([mk('ok'), mk('blocked')])), 1);
});

test('TP-station-bootstrap-024 summarize counts every status bucket', () => {
  const mk = (/** @type {string} */ status) => ({ id: 'x', n: 1, title: 't', deps: [], status, findings: [], actions: [] });
  assert.deepEqual(summarize(/** @type {any} */ ([mk('ok'), mk('ok'), mk('todo'), mk('blocked'), mk('skipped')])), {
    ok: 2, todo: 1, blocked: 1, skipped: 1, total: 5,
  });
});

// --- the report ---------------------------------------------------------------------

test('TP-station-bootstrap-025 a complete station renders no TODO and says so explicitly', () => {
  const steps = [1, 2, 3].map((n) => ({ id: `s${n}`, n, title: `step ${n}`, deps: [], status: 'ok', findings: [{ level: 'OK', msg: 'fine' }], actions: [] }));
  const out = render(/** @type {any} */ ({ steps, env: 'windows-pc-2', notes: [] })).join('\n');
  assert.match(out, /3 satisfied, 0 need a human/);
  assert.match(out, /fully bootstrapped/);
  assert.ok(!/TODO/.test(out));
});

test('TP-station-bootstrap-026 an unsatisfied step prints its instructions and points at the next action', () => {
  const steps = [
    { id: 's1', n: 1, title: 'entry', deps: [], status: 'todo', findings: [{ level: 'FAIL', msg: 'no entry' }], actions: ['  edit configs/environments.json'] },
    { id: 's2', n: 2, title: 'clone', deps: ['s1'], status: 'blocked', findings: [{ level: 'INFO', msg: 'not probed - waiting on step(s) s1' }], actions: [] },
  ];
  const out = render(/** @type {any} */ ({ steps, env: 'new-station', notes: [] })).join('\n');
  assert.match(out, /TODO {2}1\. entry/);
  assert.match(out, /WAIT {2}2\. clone/);
  assert.match(out, /do this \(by hand\)/);
  assert.match(out, /edit configs\/environments\.json/);
  assert.match(out, /Next: step 1 \(s1\)/);
  assert.match(out, /safe to re-run/);
});

test('TP-station-bootstrap-027 only the FIRST unsatisfied step instructs by default; --all instructs everywhere', () => {
  const steps = [
    { id: 's1', n: 1, title: 'a', deps: [], status: 'todo', findings: [], actions: ['  first-action'] },
    { id: 's4', n: 4, title: 'b', deps: [], status: 'todo', findings: [], actions: ['  later-action'] },
  ];
  const quiet = render(/** @type {any} */ ({ steps, env: 'x', notes: [] })).join('\n');
  assert.ok(quiet.includes('first-action'));
  assert.ok(!quiet.includes('later-action'));
  const all = render(/** @type {any} */ ({ steps, env: 'x', notes: [] }), { all: true }).join('\n');
  assert.ok(all.includes('later-action'));
});

test('TP-station-bootstrap-028 the walk covers exactly the ten ordered Workstream S steps', () => {
  const src = readFileSync(path.join(ROOT, 'cli', 'util-tools', 'station-bootstrap.js'), 'utf8');
  const ids = [...src.matchAll(/^\s*\{ id: '(s\d+)', title:/gm)].map((m) => m[1]);
  assert.deepEqual(ids, ['s1', 's2', 's3', 's4', 's5', 's6', 's7', 's8', 's9', 's10']);
});

test('TP-station-bootstrap-029 the config entry is step 1 - everything else resolves from it', () => {
  const src = readFileSync(path.join(ROOT, 'cli', 'util-tools', 'station-bootstrap.js'), 'utf8');
  const first = /^\s*\{ id: '(s\d+)', title: '([^']+)', deps: /m.exec(src);
  assert.equal(first?.[1], 's1');
  assert.match(String(first?.[2]), /environments\.json/);
});

test('TP-station-bootstrap-030 controlPlane.azure identifiers are config, not hardcoded in the tool', () => {
  const cfg = JSON.parse(readFileSync(path.join(ROOT, 'configs', 'environments.json'), 'utf8'));
  assert.ok(cfg.controlPlane?.azure?.resourceGroup, 'controlPlane.azure.resourceGroup must exist');
  assert.ok(cfg.controlPlane?.azure?.vmName);
  assert.ok(cfg.controlPlane?.azure?.nsgName);
  const src = readFileSync(path.join(ROOT, 'cli', 'util-tools', 'station-bootstrap.js'), 'utf8');
  assert.ok(!src.includes(cfg.controlPlane.azure.resourceGroup), 'resource group must come from config, never a literal');
  assert.ok(!src.includes(cfg.controlPlane.azure.nsgName), 'nsg name must come from config, never a literal');
});
