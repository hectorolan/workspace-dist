// TP-dist-phase2-structure-2026-08-25: the distribution export manifest is
// mechanically sane on THIS tree (plan `ws plan get dist-phase2-structure-2026-08-25`,
// parent `ws plan get nexus-distribution-packaging` sections 5-6).
//
// These guard the manifest against rot for as long as the exporter exists, so
// every test is tagged @promote: on plan close the tag is stripped and the test
// graduates into the permanent suite (CLAUDE.md "Tag plan-scoped tests").
//
// Reporting rule: a failing assertion names a PATH or a line NUMBER, never a
// line's text — the encoding-guard lesson (a credential once rode an error message).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { existsSync, readFileSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import {
  MANIFEST_PATH, loadManifest, validateManifest, trackedFiles, compileExclude, compileInclude,
  resolve, relativeImports, getPath, nameHits, secretHits,
} from '../util/distmanifest.js';
import { ceoName } from '../util/ceo.js';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..', '..');
const manifest = loadManifest(ROOT);
const files = trackedFiles(ROOT);
const fileSet = new Set(files);
const { included, decisions } = resolve(manifest, files);
const includedSet = new Set(included);

/** Tracked files under a directory. @param {string} dir */
const under = (dir) => files.filter((f) => f.startsWith(dir.replace(/\/$/, '') + '/'));

/** The Phase 2 artifacts the name/secret scans cover. */
const PHASE2_ARTIFACTS = [
  MANIFEST_PATH,
  'cli/util/distmanifest.js',
  'cli/test/distmanifest.test.js',
  'docs/distribution.md',
];

test('TP-dist-phase2-structure-2026-08-25-001: the manifest parses, has every section, and every entry carries a reason', () => {
  assert.equal(manifest.version, 1);
  assert.equal(manifest.target.repo, 'workspace-dist');
  assert.equal(manifest.target.visibility, 'private');
  assert.equal(manifest.target.firstTag, 'v0.1.0-beta.1');
  for (const key of /** @type {const} */ (['include', 'exclude', 'transforms', 'companions'])) {
    assert.ok(manifest[key].length > 0, `${key} is empty`);
  }
  assert.ok(manifest.overlay.files.length > 0);
  // The validator is what the loader ran; prove it actually bites on a broken shape.
  const broken = JSON.parse(JSON.stringify(manifest));
  broken.include.push({ path: 'cli/' });
  broken.include.push({ path: 'cli/*.js', reason: 'x' });
  broken.transforms.push({ from: 'a.json', to: 'a.json', reason: 'x' });
  const problems = validateManifest(broken);
  assert.ok(problems.some((p) => p.includes('has no reason')), problems.join('; '));
  assert.ok(problems.some((p) => p.includes('wildcard')), problems.join('; '));
  assert.ok(problems.some((p) => p.includes('.example.json')), problems.join('; '));
  assert.ok(problems.some((p) => p.includes('verbatim')), problems.join('; '));
});

test('TP-dist-phase2-structure-2026-08-25-002: every include path exists on this tree as a tracked file or directory', () => {
  /** @type {string[]} */
  const missing = [];
  for (const e of manifest.include) {
    const p = e.path.replace(/\/$/, '');
    const isFile = fileSet.has(p);
    const isDir = files.some((f) => f.startsWith(p + '/'));
    if (!isFile && !isDir) missing.push(e.path);
    if (e.path.endsWith('/') && !isDir) missing.push(e.path + ' (declared as a directory)');
  }
  assert.deepEqual(missing, [], 'include paths not tracked on this tree');
});

test('TP-dist-phase2-structure-2026-08-25-003: every exclude pattern compiles and matches what it expects to', () => {
  /** @type {string[]} */
  const dead = [];
  /** @type {string[]} */
  const leaks = [];
  for (const e of manifest.exclude) {
    const rule = compileExclude(e.pattern); // throws on a pattern that cannot compile
    const hits = files.filter(rule.test);
    if (e.expect === 'untracked') {
      if (hits.length) leaks.push(`${e.pattern} -> ${hits.length} tracked path(s)`);
    } else if (!hits.length) {
      dead.push(e.pattern);
    }
  }
  assert.deepEqual(leaks, [], 'a pattern that must never match a tracked file does — something secret-shaped is tracked');
  assert.deepEqual(dead, [], 'exclude patterns that match nothing tracked (typo, or the path moved)');
});

test('TP-dist-phase2-structure-2026-08-25-004: the resolved set contains no secret-bearing path', () => {
  const forbidden = [
    /^configs\/environments\.json$/, /^configs\/repos\.json$/, /^configs\/jobs\/jobs\.json$/,
    /^\.claude\/environments\//, /(^|\/)settings\.local\.json$/, /(^|\/)\.env$/, /\.env$/,
    /\.(pem|key|p12|pfx)$/, /(^|\/)\.secrets?$/, /(^|\/)ops\/log\.md$/,
  ];
  const bad = included.filter((f) => forbidden.some((re) => re.test(f)));
  assert.deepEqual(bad, []);
  // and the live configs are decided by an EXCLUDE, not merely unmatched
  for (const f of ['configs/environments.json', 'configs/repos.json', 'configs/jobs/jobs.json']) {
    assert.equal(decisions.get(f)?.kind, 'exclude', `${f} must be excluded by rule`);
  }
});

test('TP-dist-phase2-structure-2026-08-25-005: section-6 exclusions hold in the resolved set', () => {
  const mustBeOut = [
    'README.md', 'SYSTEM.md', 'configs/distribution.json', 'docs/distribution.md',
    'setup-scripts/deploy/setup-staging.sh', '.claude/environments/environments_setup.md',
    ...under('.github'), ...under('setup-scripts/azure'),
  ]; // the three util-tools once listed here ship since CEO ruling D1 (tests -rulings-001/002)
  const shipped = mustBeOut.filter((f) => includedSet.has(f));
  assert.deepEqual(shipped, [], 'paths the plan excludes but the manifest ships');
  // default-out for util-tools: anything shipped from there is an explicit opt-in line
  const optIns = new Set(manifest.include.filter((e) => e.group === 'util-tools-opt-in').map((e) => e.path));
  const sweptIn = included.filter((f) => f.startsWith('cli/util-tools/') && !optIns.has(f));
  assert.deepEqual(sweptIn, [], 'util-tools shipped without an explicit opt-in line');
});

test('TP-dist-phase2-structure-2026-08-25-006: section-6 include anchors are in the resolved set', () => {
  const mustBeIn = [
    '.claude/CLAUDE.md', '.claude/SETUP.md', '.claude/settings.json', '.claude/README.md',
    '.claude/agents/jr_implementer_github_dependabot.md', '.claude/agents/README.md',
    '.claude/skills/project-iteration/SKILL.md', '.claude/skills/sources.json',
    'cli/ws.js', 'cli/util/ceo.js', 'cli/README.md', 'cli/package.json',
    'cli/util-tools/env-doctor.js', 'cli/util-tools/station-bootstrap.js', 'cli/util-tools/agent-doctor.js',
    'cli/util-tools/log-api-tunnel.js', 'cli/util-tools/dependabot-triage.js',
    'server/server.js', 'server/dump.js', 'server/restore.js', 'server/start.sh', 'server/README.md', 'server/test/helpers.js',
    'configs/harness-settings.json',
    'Dockerfile', 'docker-compose.yml', 'package.json', 'package-lock.json', 'tsconfig.json', '.env.example', '.gitignore',
    'setup-scripts/container/entrypoint.sh', 'setup-scripts/deploy/deploy.sh', 'setup-scripts/windows/register-pull-task.ps1',
    'docs/architecture.md', 'docs/container-runtime.md', 'docs/live-host-rebuild.md',
  ];
  const absent = mustBeIn.filter((f) => !includedSet.has(f));
  assert.deepEqual(absent, [], 'paths the plan includes but the manifest drops');
  // every agent file ships, every deeper README survives the root README exclusion
  for (const f of under('.claude/agents')) assert.ok(includedSet.has(f), f);
  for (const f of files.filter((x) => x.endsWith('/README.md') && !x.startsWith('setup-scripts/azure/'))) {
    assert.ok(includedSet.has(f), `${f} lost to the root README rule`);
  }
});

test('TP-dist-phase2-structure-2026-08-25-007: import closure — no shipped module imports a file that stays behind, and no shipped job names an absent tool', () => {
  /** @type {string[]} */
  const broken = [];
  for (const f of included.filter((x) => /\.(m?js)$/.test(x))) {
    const src = readFileSync(path.join(ROOT, f), 'utf8');
    for (const dep of relativeImports(f, src)) {
      const candidates = [dep, dep + '.js', dep + '/index.js'];
      const hit = candidates.find((c) => fileSet.has(c));
      if (!hit) continue; // not a tracked file (a dir import resolved by node_modules, or a fixture path)
      if (!includedSet.has(hit)) broken.push(`${f} -> ${hit}`);
    }
  }
  assert.deepEqual(broken, [], 'shipped files importing excluded files');
  // The jobs.json template keeps every job (disabled); each tool it names must ship.
  const jobs = JSON.parse(readFileSync(path.join(ROOT, 'configs/jobs/jobs.json'), 'utf8'));
  const named = jobs.jobs.map((/** @type {{run: string}} */ j) => j.run.match(/cli\/util-tools\/\S+/)?.[0]).filter(Boolean);
  assert.deepEqual(named.filter((/** @type {string} */ t) => !includedSet.has(t)), [], 'jobs.json names a tool that does not ship');
});

test('TP-dist-phase2-structure-2026-08-25-008: precedence — the most specific rule wins, ties go to exclude', () => {
  const synthetic = ['cli/ws.js', 'cli/util-tools/a.js', 'cli/util-tools/b.js', 'cli/util-tools/deep/c.js',
    'README.md', 'cli/README.md', 'x/y.env', 'x/y.env.example', 'x/keep.env'];
  /** @type {import('../util/distmanifest.js').Manifest} */
  const m = {
    ...manifest,
    include: [
      { path: 'cli/', reason: 't' },
      { path: 'cli/util-tools/a.js', reason: 't' },
      { path: 'cli/README.md', reason: 't' }, // a basename exclude ties with a top-level dir include; the explicit file wins
      { path: 'x/keep.env', reason: 't' },
      { path: 'x/', reason: 't' },
    ],
    exclude: [
      { pattern: 'cli/util-tools/', reason: 't' },
      { pattern: 'README.md', reason: 't' },
      { pattern: '*.env', reason: 't' },
    ],
    transforms: [],
  };
  const r = resolve(m, synthetic);
  assert.deepEqual(r.included, ['cli/ws.js', 'cli/util-tools/a.js', 'cli/README.md', 'x/y.env.example', 'x/keep.env']);
  assert.equal(r.decisions.get('README.md')?.kind, 'exclude');
  assert.equal(r.decisions.get('cli/util-tools/b.js')?.spec, 'cli/util-tools/');
  // a tie (same specificity, both kinds) resolves to exclude
  const tie = resolve({ ...m, include: [{ path: 'x/y.env', reason: 't' }], exclude: [{ pattern: 'x/y.env', reason: 't' }] }, synthetic);
  assert.equal(tie.included.length, 0);
  // glob forms compile and match as documented
  assert.ok(compileExclude('**/ops/log.md').test('hub/ops/log.md'));
  assert.ok(compileExclude('**/ops/log.md').test('ops/log.md'));
  assert.ok(compileExclude('docs/*.md').test('docs/a.md'));
  assert.ok(!compileExclude('docs/*.md').test('docs/sub/a.md'));
  assert.equal(compileInclude('cli/util/').specificity, 2);
  assert.equal(compileExclude('**/ops/log.md').specificity, 2);
});

test('TP-dist-phase2-structure-2026-08-25-009: transforms — sources are tracked and never plain-copied, every placeholder path exists in the live file, identity keys are all covered', () => {
  for (const t of manifest.transforms) {
    assert.ok(fileSet.has(t.from), `${t.from} is not tracked`);
    assert.ok(!includedSet.has(t.from), `${t.from} would ship verbatim`);
    assert.ok(!fileSet.has(t.to), `${t.to} exists as a hand-maintained file — templates are derived, never kept`);
    const live = JSON.parse(readFileSync(path.join(ROOT, t.from), 'utf8'));
    for (const k of Object.keys(t.set || {})) assert.notEqual(getPath(live, k), undefined, `${t.from}: placeholder path "${k}" is not in the live file`);
    for (const k of t.drop || []) assert.notEqual(getPath(live, k), undefined, `${t.from}: drop path "${k}" is not in the live file`);
    for (const [k, v] of Object.entries(t.setEach || {})) {
      assert.ok(Array.isArray(getPath(live, k)), `${t.from}: setEach path "${k}" is not an array`);
      assert.ok(Object.keys(v).length, `${t.from}: setEach "${k}" sets nothing`);
    }
  }
  const env = manifest.transforms.find((t) => t.from === 'configs/environments.json');
  assert.ok(env);
  const covered = new Set([...Object.keys(env.set || {}).map((k) => k.split('.')[0]), ...(env.drop || [])]);
  for (const key of ['ceo', 'backupRepoUrl', 'controlPlane', 'environments', 'scheduleOwner', 'activeProjectRepos']) {
    assert.ok(covered.has(key), `identity key "${key}" leaks through the environments template`);
  }
  const jobs = manifest.transforms.find((t) => t.from === 'configs/jobs/jobs.json');
  assert.equal(jobs?.setEach?.jobs?.disabled, true, 'safe-by-default: every shipped job is disabled');
});

test('TP-dist-phase2-structure-2026-08-25-010: overlay — phase<=2 entries exist, no target collides with the copied tree', () => {
  for (const o of manifest.overlay.files) {
    assert.ok(Number.isInteger(o.phase) && o.phase >= 2, `${o.source}: phase`);
    if (o.phase <= 2) assert.ok(existsSync(path.join(ROOT, o.source)), `${o.source} is due now and missing`);
    assert.ok(!includedSet.has(o.target), `${o.target} is both copied and overlaid`);
  }
  // an overlay file that already exists must be tracked (it ships from git, not the working tree)
  for (const o of manifest.overlay.files) {
    if (existsSync(path.join(ROOT, o.source))) assert.ok(fileSet.has(o.source), `${o.source} exists but is untracked`);
  }
  const targets = manifest.overlay.files.map((o) => o.target);
  assert.equal(new Set(targets).size, targets.length, 'duplicate overlay targets');
});

test('TP-dist-phase2-structure-2026-08-25-011: name scan — the Phase 2 artifacts carry no person\'s name outside a dated attribution', () => {
  const name = ceoName(ROOT);
  /** @type {string[]} */
  const findings = [];
  for (const f of PHASE2_ARTIFACTS) {
    const hits = nameHits(readFileSync(path.join(ROOT, f), 'utf8'), name, manifest.guards.attributionDatePattern);
    if (hits.length) findings.push(`${f}: lines ${hits.join(',')}`);
  }
  assert.deepEqual(findings, []);
  // and the scanner itself is proven on synthetic text
  assert.deepEqual(nameHits(`${name} 2026-07-19: ruled\nplain ${name.toLowerCase()}olan here\nthe CEO`, name, manifest.guards.attributionDatePattern), [2]);
});

test('TP-dist-phase2-structure-2026-08-25-012: secret scan — the Phase 2 artifacts carry no key-shaped literal', () => {
  /** @type {string[]} */
  const findings = [];
  for (const f of PHASE2_ARTIFACTS) {
    const hits = secretHits(readFileSync(path.join(ROOT, f), 'utf8'), manifest.guards.secretPatterns);
    if (hits.length) findings.push(`${f}: lines ${hits.join(',')}`);
  }
  assert.deepEqual(findings, []);
  const fake = ['ghp_', 'A'.repeat(30)].join('');
  const pem = ['-----BEGIN', 'RSA PRIVATE KEY-----'].join(' '); // built by concatenation so this file passes its own scan
  assert.deepEqual(secretHits(`ok\n${fake}\n${pem}`, manifest.guards.secretPatterns), [2, 3]);
});

test('TP-dist-phase2-structure-2026-08-25-013: trackedFiles reads git, not the working tree', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'ws-dist-'));
  try {
    assert.throws(() => trackedFiles(dir), 'a non-repo must throw, never return an empty (silently shipping nothing)');
  } finally { rmSync(dir, { recursive: true, force: true }); }
  assert.ok(files.length > 100);
  for (const f of files.slice(0, 5)) assert.ok(statSync(path.join(ROOT, f)).isFile());
});

test('TP-dist-phase2-structure-2026-08-25-014: companions — hub is vendored (private repo, CEO ruling) with a pin and a target, and the validator refuses a reference-mode hub or a pinless vendored entry', () => {
  const m = loadManifest(ROOT);
  const hub = m.companions.find((c) => c.repo === 'hub');
  assert.ok(hub, 'hub companion declared');
  assert.equal(hub.mode, 'vendored');
  assert.ok(hub.ref && hub.target && hub.target.endsWith('/'));
  assert.doesNotMatch(hub.reason, /public/i, 'the public flip is cancelled — the reason must not promise it');
  assert.deepEqual(validateManifest(m), []);
  const noPin = { ...m, companions: [{ repo: 'hub', mode: 'vendored', reason: 'x' }] };
  assert.ok(validateManifest(noPin).some((p) => /vendored needs/.test(p)));
  const badMode = { ...m, companions: [{ repo: 'hub', mode: 'image', reason: 'x' }] };
  assert.ok(validateManifest(badMode).some((p) => /mode must be/.test(p)));
});

// ---- CEO rulings of the 2026-08-25/26 D1-D8 walk (plan dist-phase2-rulings-2026-08-26) ----

test('TP-dist-phase2-rulings-2026-08-26-001: D1 — the three formerly-excluded tools and plans-import.test.js resolve into the include set', () => {
  const nowIn = [
    'cli/util-tools/plans-import.js', 'cli/util-tools/skills-upstream-sync.js', 'cli/util-tools/stale-status-sweep.js',
    'cli/test/plans-import.test.js',
  ];
  const absent = nowIn.filter((f) => !includedSet.has(f));
  assert.deepEqual(absent, [], 'CEO ruling D1: the full tool set ships');
  // each tool is an explicit opt-in line with a reason, not swept in by a broader rule
  for (const f of nowIn.filter((x) => x.startsWith('cli/util-tools/'))) {
    const line = manifest.include.find((e) => e.path === f);
    assert.ok(line && line.group === 'util-tools-opt-in' && line.reason.trim(), `${f} needs an opt-in line`);
  }
  assert.ok(!manifest.exclude.some((e) => e.pattern === 'cli/test/plans-import.test.js'), 'the plans-import test exclusion is gone');
});

test('TP-dist-phase2-rulings-2026-08-26-002: D1 — every tracked util-tool ships; only the exporter (dist-export.js) stays behind by the default-out rule', () => {
  const tracked = under('cli/util-tools').filter((f) => /\.m?js$/.test(f));
  assert.ok(tracked.length >= 20, `expected the full tool set, saw ${tracked.length}`);
  const left = tracked.filter((f) => !includedSet.has(f));
  // the one carve-out (Phase 3, real since 2026-09-07): the exporter builds this
  // product, so it is exactly what stays behind — nothing more, nothing less
  assert.deepEqual(left, ['cli/util-tools/dist-export.js'], 'only the exporter may stay behind — the CEO ruled the full set ships unless the tool builds this product');
  assert.equal(decisions.get('cli/util-tools/dist-export.js')?.kind, 'exclude');
  assert.match(manifest.exclude.find((e) => e.pattern === 'cli/util-tools/')?.reason ?? '', /dist-export\.js/);
});

test('TP-dist-phase2-rulings-2026-08-26-003: D7 — the distribution targets postgres and the validator refuses a missing or unknown engine', () => {
  assert.equal(manifest.target.dbEngine, 'postgres');
  assert.deepEqual(validateManifest(manifest), []);
  const unknown = { ...manifest, target: { ...manifest.target, dbEngine: 'mysql' } };
  assert.ok(validateManifest(unknown).some((p) => /dbEngine/.test(p)), 'unknown engine must be refused');
  const { dbEngine: _drop, ...rest } = manifest.target;
  const missing = { ...manifest, target: rest };
  assert.ok(validateManifest(missing).some((p) => /dbEngine/.test(p)), 'missing engine must be refused');
});

test('TP-dist-phase2-rulings-2026-08-26-004: D2 — the dependabot auto-merge toggle is declared, default OFF, and gates both halves', () => {
  const t = manifest.setup?.toggles.find((x) => x.id === 'dependabot-automerge');
  assert.ok(t, 'setup.toggles must declare dependabot-automerge');
  assert.equal(t.default, false, 'CEO ruling D2: opt-in, default OFF');
  assert.ok(t.gates.some((g) => /ci\.yml/.test(g)), 'gates the ci.yml automerge job');
  assert.ok(t.gates.some((g) => /dependabot-triage/.test(g)), 'gates the scheduled red-PR triage job');
  assert.match(t.reason, /major/i, 'majors stay human-only regardless — the reason must say so');
  // shape is enforced, not just present
  const noDefault = { ...manifest, setup: { toggles: [{ id: 'x', label: 'x', gates: ['a'], reason: 'r' }] } };
  assert.ok(validateManifest(noDefault).some((p) => /toggles\[0\]/.test(p)));
  const noReason = { ...manifest, setup: { toggles: [{ id: 'x', label: 'x', default: false, gates: ['a'] }] } };
  assert.ok(validateManifest(noReason).some((p) => /toggles\[0\]/.test(p)));
});

test('TP-docs-truth-001: configs/features.json ships via an explicit include line — GET /feature, util/features.js, env-doctor and features.test.js all read it at runtime/CI', () => {
  assert.ok(includedSet.has('configs/features.json'), 'configs/features.json must resolve into the include set (a generated distribution 500s GET /feature without it)');
  const line = manifest.include.find((e) => e.path === 'configs/features.json');
  assert.ok(line && line.group === 'configs' && line.reason.trim(), 'configs/features.json needs an explicit include line (group configs) with a reason');
  assert.equal(decisions.get('configs/features.json')?.spec, 'configs/features.json', 'the decision must come from the explicit line, not a sweep');
});

test('TP-dist-phase2-rulings-2026-08-26-005: regression — the plans-import test → tool import edge is shipped-to-shipped', () => {
  const src = readFileSync(path.join(ROOT, 'cli/test/plans-import.test.js'), 'utf8');
  const deps = relativeImports('cli/test/plans-import.test.js', src).map((d) => (fileSet.has(d) ? d : d + '.js'));
  assert.ok(deps.includes('cli/util-tools/plans-import.js'), 'fixture still imports the tool');
  for (const d of deps.filter((x) => fileSet.has(x))) assert.ok(includedSet.has(d), `${d} must ship with its test`);
});
