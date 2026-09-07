// env-doctor capability checks — pins the gap class the 2026-07-28 windows-pc-2 install
// exposed: a station passed every connectivity check and still could not do project work
// (plan environment-setup-streamlining, W1).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  compareHarnessSettings,
  toolPlan,
  parseVersion,
  expandWinVars,
  parseRegPath,
  machinePathGitDir,
  parseSchtasks,
  parseGhScopes,
  projectRepoFindings,
  toolFound,
  checksFailed,
  featureDriftChecks,
  explainCheck,
  collectChecks,
  payload,
} from '../util-tools/env-doctor.js';
import { loadFeatures } from '../util/features.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

// --- (a) per-machine harness config vs desired state in the repo ---

test('TP-env-doctor-001 harness settings matching the desired keys yield no findings', () => {
  assert.deepEqual(compareHarnessSettings({ fallbackModel: ['opus'] }, { fallbackModel: ['opus'], theme: 'dark' }), []);
});

test('TP-env-doctor-002 a missing fallbackModel FAILs (the silent windows-pc-2 gap)', () => {
  const f = compareHarnessSettings({ fallbackModel: ['opus'] }, { theme: 'dark' });
  assert.equal(f.length, 1);
  assert.equal(f[0].level, 'FAIL');
  assert.match(f[0].msg, /fallbackModel.*not set/);
});

test('TP-env-doctor-003 a wrong fallbackModel value FAILs', () => {
  const f = compareHarnessSettings({ fallbackModel: ['opus'] }, { fallbackModel: ['sonnet'] });
  assert.equal(f[0].level, 'FAIL');
  assert.match(f[0].msg, /sonnet/);
});

test('TP-env-doctor-004 scalar and single-element-array forms are equal', () => {
  assert.deepEqual(compareHarnessSettings({ fallbackModel: ['opus'] }, { fallbackModel: 'opus' }), []);
});

test('TP-env-doctor-005 a missing settings file FAILs, and _note keys are ignored', () => {
  const f = compareHarnessSettings({ _note: 'x', fallbackModel: ['opus'] }, null);
  assert.equal(f.length, 1);
  assert.equal(f[0].level, 'FAIL');
  assert.deepEqual(compareHarnessSettings({ _note: 'ignored' }, {}), []);
});

test('TP-env-doctor-006 a secret-looking key is never echoed (D5)', () => {
  const f = compareHarnessSettings({ apiKeyHelper: 'want' }, { apiKeyHelper: 'sk-real-value' });
  assert.equal(f.length, 1);
  assert.ok(!f[0].msg.includes('sk-real-value'));
  assert.match(f[0].msg, /<redacted>/);
});

// --- (b) active project repos as siblings ---

test('TP-env-doctor-010 repos cloned as siblings yield no findings', () => {
  assert.deepEqual(projectRepoFindings(['ho-nexus'], () => ({ sibling: true, isGit: true, insideWorkspace: false })), []);
});

test('TP-env-doctor-011 a missing sibling clone FAILs', () => {
  const f = projectRepoFindings(['ho-nexus'], () => ({ sibling: false, isGit: false, insideWorkspace: false }));
  assert.equal(f[0].level, 'FAIL');
  assert.match(f[0].msg, /not cloned as a sibling/);
});

test('TP-env-doctor-012 a clone INSIDE the workspace repo FAILs', () => {
  const f = projectRepoFindings(['ho-nexus'], () => ({ sibling: false, isGit: false, insideWorkspace: true }));
  assert.equal(f[0].level, 'FAIL');
  assert.match(f[0].msg, /INSIDE the workspace repo/);
});

test('TP-env-doctor-013 a directory that is not a git clone FAILs', () => {
  const f = projectRepoFindings(['ho-nexus'], () => ({ sibling: true, isGit: false, insideWorkspace: false }));
  assert.equal(f[0].level, 'FAIL');
  assert.match(f[0].msg, /not a git clone/);
});

// --- (c) tool plan is kind-aware, versions are reported not gated ---

test('TP-env-doctor-020 a container is never failed for docker or ssh', () => {
  const plan = toolPlan({ kind: 'docker-container', role: '24/7 job host + log API + DB', hasTunnel: false });
  const by = Object.fromEntries(plan.map((t) => [t.name, t.requirement]));
  assert.equal(by.docker, 'n/a');
  assert.equal(by.ssh, 'n/a');
  assert.equal(by.node, 'required');
  assert.equal(by.git, 'required');
  assert.equal(by.claude, 'required');
});

test('TP-env-doctor-021 a rollback host requires docker, and a tunnelled station requires ssh', () => {
  const plan = toolPlan({ kind: 'interactive + rollback host', role: 'Claude Code dev sessions, Docker Desktop rollback lane', hasTunnel: true });
  const by = Object.fromEntries(plan.map((t) => [t.name, t.requirement]));
  assert.equal(by.docker, 'required');
  assert.equal(by.ssh, 'required');
  assert.equal(by.az, 'optional');
});

test('TP-env-doctor-022 unresolved identity still requires the universal four only', () => {
  const by = Object.fromEntries(toolPlan(null).map((t) => [t.name, t.requirement]));
  assert.deepEqual(
    Object.entries(by).filter(([, v]) => v === 'required').map(([k]) => k).sort(),
    ['claude', 'gh', 'git', 'node'],
  );
});

test('TP-env-doctor-023 version parsing handles git/gh/ssh/az output shapes', () => {
  assert.equal(parseVersion('git version 2.55.0.windows.3'), '2.55.0.windows.3');
  assert.equal(parseVersion('gh version 2.96.0 (2026-07-01)\nhttps://x'), '2.96.0');
  assert.equal(parseVersion('OpenSSH_9.5p2, LibreSSL 3.3.6'), '9.5p2');
  assert.equal(parseVersion('{\n "azure-cli": "2.88.0"\n}'), '2.88.0');
});

test('TP-env-doctor-024 a missing tool is detected despite shell noise and non-zero version exits', () => {
  assert.equal(toolFound({ ok: false, out: "'az' is not recognized as an internal or external command,\noperable program or batch file." }), false);
  assert.equal(toolFound({ ok: false, out: 'bash: docker: command not found' }), false);
  assert.equal(toolFound({ ok: false, out: 'OpenSSH_9.5p2, LibreSSL 3.3.6' }), true);
  assert.equal(toolFound({ ok: true, out: 'git version 2.55.0' }), true);
});

// --- (c2) git on the MACHINE PATH ---

test('TP-env-doctor-030 the registry Path value is parsed out of reg query output', () => {
  const out = '\r\nHKEY_LOCAL_MACHINE\\SYSTEM\\...\\Environment\r\n    Path    REG_EXPAND_SZ    C:\\Windows\\system32;C:\\Program Files\\Git\\cmd\r\n';
  assert.equal(parseRegPath(out), 'C:\\Windows\\system32;C:\\Program Files\\Git\\cmd');
  assert.equal(parseRegPath('ERROR: The system was unable to find the specified registry key'), null);
});

test('TP-env-doctor-031 machine PATH containing git resolves to its directory', () => {
  const dir = machinePathGitDir('C:\\Windows\\system32;C:\\Program Files\\Git\\cmd\\', (d) => d.endsWith('Git\\cmd'), {});
  assert.equal(dir, 'C:\\Program Files\\Git\\cmd');
});

test('TP-env-doctor-032 git only on the USER PATH is reported as absent (the S4U trap)', () => {
  assert.equal(machinePathGitDir('C:\\Windows\\system32;C:\\Windows', () => false, {}), null);
  assert.equal(machinePathGitDir(null, () => true, {}), null);
});

test('TP-env-doctor-033 %VAR% entries are expanded case-insensitively', () => {
  assert.equal(expandWinVars('%SystemRoot%\\system32', { SYSTEMROOT: 'C:\\Windows' }), 'C:\\Windows\\system32');
  assert.equal(expandWinVars('%Nope%\\bin', {}), '%Nope%\\bin');
});

// --- (d) Claude-WorkspacePull registration ---

test('TP-env-doctor-040 a registered task reports state, last result and next run', () => {
  const out = [
    'Folder: \\',
    'HostName:                             PC',
    'TaskName:                             \\Claude-WorkspacePull',
    'Next Run Time:                        7/28/2026 9:45:00 AM',
    'Status:                               Ready',
    'Last Result:                          0',
    'Scheduled Task State:                 Enabled',
  ].join('\r\n');
  const t = parseSchtasks(out, 0);
  assert.equal(t.found, true);
  assert.equal(t.state, 'Enabled');
  assert.equal(t.lastResult, '0');
  assert.equal(t.nextRun, '7/28/2026 9:45:00 AM');
});

test('TP-env-doctor-041 a missing task is found:false (no tunnel keeper, no fallback replay)', () => {
  assert.deepEqual(parseSchtasks('ERROR: The system cannot find the file specified.', 1), {
    found: false, state: null, lastResult: null, nextRun: null,
  });
});

// --- (e) gh scopes, informational ---

test('TP-env-doctor-050 gh scopes are parsed; absence is empty, never a throw', () => {
  assert.deepEqual(parseGhScopes("  - Token scopes: 'gist', 'read:org', 'repo'"), ['gist', 'read:org', 'repo']);
  assert.deepEqual(parseGhScopes('not logged in'), []);
});

// --- gate semantics + the real repo config (step 0 lives or dies here) ---

test('TP-env-doctor-060 only FAIL fails the gate — WARN and INFO do not', () => {
  assert.equal(checksFailed([{ id: 'a', level: 'OK', name: 'a', detail: '' }, { id: 'b', level: 'WARN', name: 'b', detail: '' }, { id: 'c', level: 'INFO', name: 'c', detail: '' }]), false);
  assert.equal(checksFailed([{ id: 'a', level: 'OK', name: 'a', detail: '' }, { id: 'b', level: 'FAIL', name: 'b', detail: '' }]), true);
});

test('TP-env-doctor-061 configs/environments.json declares activeProjectRepos, none of them retired', () => {
  const envs = JSON.parse(readFileSync(path.join(ROOT, 'configs', 'environments.json'), 'utf8'));
  assert.ok(Array.isArray(envs.activeProjectRepos), 'activeProjectRepos must exist as an array');
  assert.ok(envs.activeProjectRepos.every((/** @type {unknown} */ r) => typeof r === 'string' && r.length));
  const retired = JSON.parse(readFileSync(path.join(ROOT, 'configs', 'repos.json'), 'utf8')).retired || [];
  for (const r of envs.activeProjectRepos) assert.ok(!retired.includes(r), `${r} is both active and retired`);
});

// --- (f) feature-registry drift check (registry vs reality) ---
// Plan: ws plan get features-drift-check-2026-08-27. Fixtures are pure literals;
// the wiring inside collectChecks() is exercised live (TP-features-drift-011, deferred).

const DRIFT_ENVS = { scheduleOwner: 'vm', environments: { vm: { kind: 'container' }, pc: { kind: 'interactive + rollback host' } } };
/** @param {string} id @param {Record<string, unknown>} [over] */
const feat = (id, over = {}) => ({ id, title: id, kind: 'check', scope: 'all', description: 'x', evidence: [], ...over });
/** @param {any[]} features */
const loadedReg = (features) => ({ registry: { features }, errors: [] });
/** @param {Partial<Parameters<typeof featureDriftChecks>[0]>} over */
const drift = (over = {}) => featureDriftChecks({
  loaded: loadedReg([
    feat('daily-digest', { kind: 'job', scope: 'schedule-owner', evidence: ['job:daily-digest'] }),
    feat('tool-node', { kind: 'tool', evidence: ['check:tool:node'] }),
    feat('log-api', { kind: 'service', evidence: ['check:log-api'] }),
  ]),
  jobsCfg: { jobs: [{ name: 'daily-digest' }] },
  toolNames: ['node'],
  self: 'vm',
  envsCfg: DRIFT_ENVS,
  emittedIds: new Set(['tool:node', 'log-api']),
  remoteIds: new Set(),
  ...over,
});

test('TP-features-drift-001 a registry in sync with reality yields exactly one OK row', () => {
  const rows = drift();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, 'feature-registry');
  assert.equal(rows[0].level, 'OK');
  assert.match(rows[0].detail, /in sync/);
});

test('TP-features-drift-002 an invalid registry FAILs loudly with the validator errors and no drift rows', () => {
  const rows = drift({ loaded: { registry: null, errors: ["feature 'x': duplicate id"] } });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].level, 'FAIL');
  assert.match(rows[0].detail, /duplicate id/);
  assert.match(rows[0].detail, /features\.json/);
});

test('TP-features-drift-003 a jobs.json job no feature cites WARNs, disabled or not', () => {
  const rows = drift({ jobsCfg: { jobs: /** @type {{name?: string}[]} */ ([{ name: 'daily-digest' }, { name: 'ghost-job', disabled: true }]) } });
  const warns = rows.filter((r) => r.level === 'WARN');
  assert.equal(warns.length, 1);
  assert.match(warns[0].detail, /job 'ghost-job'/);
  assert.match(warns[0].detail, /add a feature|remove the job/);
});

test('TP-features-drift-004 a toolPlan tool with no check:tool:<name> citation WARNs', () => {
  const rows = drift({ toolNames: ['node', 'git'] });
  const warns = rows.filter((r) => r.level === 'WARN');
  assert.equal(warns.length, 1);
  assert.match(warns[0].detail, /tool 'git'/);
  assert.match(warns[0].detail, /check:tool:git/);
});

test('TP-features-drift-005 an in-scope check id emitted nowhere WARNs with feature, id and fix', () => {
  const rows = drift({
    loaded: loadedReg([feat('daily-digest', { kind: 'job', scope: 'schedule-owner', evidence: ['job:daily-digest'] }), feat('tool-node', { kind: 'tool', evidence: ['check:tool:node'] }), feat('phantom-feature', { evidence: ['check:phantom'] })]),
  });
  const warns = rows.filter((r) => r.level === 'WARN');
  assert.equal(warns.length, 1);
  assert.match(warns[0].detail, /'phantom-feature' cites 'check:phantom'/);
  assert.match(warns[0].detail, /fix the evidence id|remove the feature/);
});

test('TP-features-drift-006 an id this run emits at ANY level (INFO skip included) is not drift', () => {
  const rows = drift({
    loaded: loadedReg([feat('daily-digest', { kind: 'job', scope: 'schedule-owner', evidence: ['job:daily-digest'] }), feat('tool-node', { kind: 'tool', evidence: ['check:tool:node'] }), feat('phantom-feature', { evidence: ['check:phantom'] })]),
    emittedIds: new Set(['tool:node', 'phantom']),
  });
  assert.equal(rows.filter((r) => r.level === 'WARN').length, 0);
});

test('TP-features-drift-007 an id another station reports satisfies the evidence (cross-station via)', () => {
  const rows = drift({
    loaded: loadedReg([feat('daily-digest', { kind: 'job', scope: 'schedule-owner', evidence: ['job:daily-digest'] }), feat('tool-node', { kind: 'tool', evidence: ['check:tool:node'] }), feat('cp-service', { scope: 'all', evidence: ['check:cp-env:hub'] })]),
    remoteIds: new Set(['cp-env:hub']),
  });
  assert.equal(rows.filter((r) => r.level === 'WARN').length, 0);
});

test('TP-features-drift-008 a feature scoped outside this station is never judged here', () => {
  const rows = drift({
    loaded: loadedReg([feat('daily-digest', { kind: 'job', scope: 'schedule-owner', evidence: ['job:daily-digest'] }), feat('tool-node', { kind: 'tool', evidence: ['check:tool:node'] }), feat('pc-only', { scope: 'env:pc', evidence: ['check:pull-task'] }), feat('kind-only', { scope: 'kind:interactive + rollback host', evidence: ['check:nsg-ssh-allowlist'] })]),
  });
  assert.equal(rows.filter((r) => r.level !== 'OK').length, 0);
});

test('TP-features-drift-009 an unreachable station roster yields INFO for unresolved ids, never a guessed WARN', () => {
  const rows = drift({
    loaded: loadedReg([feat('daily-digest', { kind: 'job', scope: 'schedule-owner', evidence: ['job:daily-digest'] }), feat('tool-node', { kind: 'tool', evidence: ['check:tool:node'] }), feat('phantom-feature', { evidence: ['check:phantom'] })]),
    remoteIds: null,
  });
  assert.equal(rows.filter((r) => r.level === 'WARN').length, 0);
  const infos = rows.filter((r) => r.level === 'INFO');
  assert.equal(infos.length, 1);
  assert.match(infos[0].detail, /phantom/);
  assert.match(infos[0].detail, /roster unreachable/);
});

test('TP-features-drift-010 the SHIPPED registry has zero job/tool drift against the real configs', () => {
  const loaded = loadFeatures({
    featuresPath: path.join(ROOT, 'configs', 'features.json'),
    envsPath: path.join(ROOT, 'configs', 'environments.json'),
    jobsPath: path.join(ROOT, 'configs', 'jobs', 'jobs.json'),
  });
  assert.ok(loaded.registry, `registry must load: ${loaded.errors.join('; ')}`);
  const jobsCfg = JSON.parse(readFileSync(path.join(ROOT, 'configs', 'jobs', 'jobs.json'), 'utf8'));
  const envsCfg = JSON.parse(readFileSync(path.join(ROOT, 'configs', 'environments.json'), 'utf8'));
  const rows = featureDriftChecks({
    loaded,
    jobsCfg,
    toolNames: toolPlan(null).map((t) => t.name),
    self: null, // R4 needs live emissions — the static guard covers R2/R3 only
    envsCfg,
    emittedIds: new Set(),
    remoteIds: null,
  });
  assert.deepEqual(rows.filter((r) => r.level === 'WARN').map((r) => r.detail), []);
  assert.equal(rows[rows.length - 1].level, 'OK');
});

// --- (g) colloquial check explainers (C-2 follow-up: every check row carries `explain`) ---
// Plan: ws plan get check-explainers-workspace-2026-08-27. One home for the prose:
// explainCheck() in env-doctor — the hub never hardcodes per-check text.

test('TP-check-explain-001 every check a live run produces carries a non-empty explain (the enforcement gate)', async () => {
  // Neutralize station identity so the run stays fast and side-effect-free on any
  // machine (no ssh probe, no nsg az read, no cache writes) — the rows still emit.
  const saved = process.env.WS_ENV;
  delete process.env.WS_ENV;
  try {
    const results = await collectChecks({ controlPlane: 'auto' });
    assert.ok(results.length >= 10, 'a live run emits the full static check set');
    for (const r of results) {
      assert.ok(typeof r.explain === 'string' && r.explain.trim().length > 0, `check '${r.id}' shipped without a non-empty explain — add it to explainCheck() in env-doctor.js`);
    }
    // The exact object station.js PUTs carries the field through untouched.
    const p = payload(results);
    assert.ok(p.results.every((r) => typeof r.explain === 'string' && r.explain.length));
  } finally {
    if (saved !== undefined) process.env.WS_ENV = saved;
  }
});

test('TP-check-explain-002 explainCheck covers every family a local run cannot emit, reading naturally per instance', () => {
  const staticIds = [
    'node', 'identity', 'deps', 'ci-guard-gates', 'git', 'log-api', 'harness', 'project-repos',
    'git-machine-path', 'pull-task', 'gh-scopes', 'nsg-ssh-allowlist', 'control-plane',
    'cp-cron', 'cp-compose', 'cp-clone', 'cp-env', 'feature-registry',
  ];
  const toolIds = toolPlan(null).map((t) => `tool:${t.name}`);
  for (const id of [...staticIds, ...toolIds, 'cp-env:hub', 'cp-env:hub:PORT']) {
    const e = explainCheck(id);
    assert.equal(typeof e, 'string', `no explain for check id '${id}'`);
    assert.ok(String(e).split(/\s+/).length >= 8 && String(e).trim().endsWith('.'), `explain for '${id}' is not at least one full sentence: ${e}`);
  }
  // Templated families compose per instance — the row must read naturally on its own.
  assert.match(String(explainCheck('tool:git')), /'git'/);
  assert.match(String(explainCheck('cp-env:hub')), /'hub'/);
  assert.match(String(explainCheck('cp-env:hub:PORT')), /'hub'/);
  assert.notEqual(explainCheck('cp-env:hub'), explainCheck('cp-env:hub:PORT'));
  assert.notEqual(explainCheck('cp-env'), explainCheck('cp-env:hub'));
});

test('TP-check-explain-003 an unknown id yields null, never fabricated filler — which is what arms the gate', () => {
  assert.equal(explainCheck('no-such-check'), null);
  assert.equal(explainCheck(''), null);
});

test('TP-env-doctor-062 configs/harness-settings.json declares desired state for real station kinds, secret-free', () => {
  const cfg = JSON.parse(readFileSync(path.join(ROOT, 'configs', 'harness-settings.json'), 'utf8'));
  const envs = JSON.parse(readFileSync(path.join(ROOT, 'configs', 'environments.json'), 'utf8'));
  const kinds = new Set(Object.values(envs.environments).map((/** @type {any} */ e) => e.kind));
  assert.ok(Array.isArray(cfg.appliesToKinds) && cfg.appliesToKinds.length);
  for (const k of cfg.appliesToKinds) assert.ok(kinds.has(k), `appliesToKinds '${k}' matches no environment kind`);
  assert.ok(cfg.userSettings && cfg.userSettings.fallbackModel, 'fallbackModel is the known member of the per-machine class');
  for (const k of Object.keys(cfg.userSettings)) assert.ok(!/token|secret|password/i.test(k), `${k} looks like a secret — this file is public`);
});
