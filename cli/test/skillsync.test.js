// TP-skillsync: the vendored-skills upstream sync (see ws plan get
// test-plan-skills-upstream-sync). Contract under test (Hector 2026-07-28, plan
// `environment-setup-streamlining` W4/D2/D6): NO environment gate — the trigger is the
// scheduled gh-workflow in the control plane, its cron is the throttle, the local stamp
// only throttles station runs and `--force` means "ignore the stamp"; agent-doctor
// verifies the refreshed clone before the PR; PR-only updates titled
// "Agent: update for skill '<name>'" — never a merge. All gh / git / PR traffic is
// faked; temp roots + WS_DATA_DIR keep every write out of the real workspace and data
// dir.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import {
  syncSkills, readManifest, extractLocalBlocks, applyLocalBlocks, refreshSkillDir,
  latestUpstreamSha, updateBranch, prTitle, agentDoctor, manifestFile,
  LOCAL_START, LOCAL_END, CHECK_INTERVAL_MS,
} from '../util/skillsync.js';

const SHA_OLD = 'a'.repeat(40);
const SHA_NEW = 'b'.repeat(40);

/**
 * A throwaway workspace root with environments.json (incl. the
 * external_skills_git allow-list; registry: null omits it) + skills manifest.
 * @param {{env?: object, manifest?: object|string|null, registry?: object|null}} [p]
 */
function fakeRoot({ env = { 'windows-pc': { kind: 'interactive' } }, manifest, registry } = {}) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'ws-skillsync-'));
  mkdirSync(path.join(root, 'configs'), { recursive: true });
  const external_skills_git = registry === undefined
    ? { _note: 'canonical sources', 'LambdaTest/agent-skills': {}, 'anthropics/skills': {} }
    : registry;
  writeFileSync(path.join(root, 'configs', 'environments.json'),
    JSON.stringify({ scheduleOwner: 'azure-vm', external_skills_git, environments: env }));
  mkdirSync(path.join(root, '.claude', 'skills'), { recursive: true });
  if (manifest !== null) {
    const data = manifest === undefined
      ? { skills: { 'jest-skill': { repo: 'LambdaTest/agent-skills', path: 'jest-skill', sha: SHA_OLD } } }
      : manifest;
    writeFileSync(manifestFile(root), typeof data === 'string' ? data : JSON.stringify(data));
  }
  return root;
}

/**
 * Run fn with WS_ENV (null = unset) + a temp WS_DATA_DIR (throttle stamp isolated per test).
 * @param {(dataDir: string) => any} fn
 * @param {{wsEnv?: string|null, dataDir?: string}} [opts]
 */
async function withEnv(fn, { wsEnv = 'windows-pc', dataDir } = {}) {
  const prev = { WS_ENV: process.env.WS_ENV, WS_DATA_DIR: process.env.WS_DATA_DIR };
  if (wsEnv === null) delete process.env.WS_ENV;
  else process.env.WS_ENV = wsEnv;
  process.env.WS_DATA_DIR = dataDir || mkdtempSync(path.join(os.tmpdir(), 'ws-skillsync-data-'));
  try {
    return await fn(process.env.WS_DATA_DIR);
  } finally {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

/** gh fake serving one path-scoped commits response. @param {string} sha */
const ghWith = (sha) => (/** @type {string[]} */ args) => {
  assert.equal(args[0], 'api');
  return JSON.stringify([{ sha }]);
};

test('TP-skillsync-001: NO environment gate — the identical pass runs under any WS_ENV, including none', async () => {
  // The station gate is gone (D2): the trigger lives in the control plane, so a station is
  // disposable and nothing about WS_ENV changes what this pass does. Any environment that
  // runs it — the gh-workflow runner, either PC, the container — gets the same result.
  const root = fakeRoot({ env: { 'azure-vm': { role: 'API host' } } });
  for (const wsEnv of ['azure-vm', 'windows-pc', 'windows-pc-2', null]) {
    let ghCalls = 0;
    const summary = await withEnv(
      () => syncSkills({ root, gh: (a) => { ghCalls++; return ghWith(SHA_OLD)(a); } }),
      { wsEnv },
    );
    assert.match(summary, /jest-skill up-to-date/, `WS_ENV=${wsEnv} must run the real pass`);
    assert.equal(ghCalls, 1, `WS_ENV=${wsEnv} must reach upstream exactly once`);
  }
});

test('TP-skillsync-017: an ephemeral runner carries no stamp, so every scheduled pass is due', async () => {
  // The gh-workflow's cron IS the throttle (D2). Proven by giving each pass a FRESH
  // WS_DATA_DIR, which is what a new runner is: no --force needed, never throttled.
  const root = fakeRoot();
  for (let i = 0; i < 3; i++) {
    const summary = await withEnv(() => syncSkills({ root, gh: ghWith(SHA_OLD) }));
    assert.match(summary, /jest-skill up-to-date/, 'a stampless run is always due');
  }
});

test('TP-skillsync-002: no WS_ENV and a malformed environments.json no longer stop the pass (no throw)', async () => {
  const root = fakeRoot();
  assert.match(await withEnv(() => syncSkills({ root, gh: ghWith(SHA_OLD) }), { wsEnv: null }), /up-to-date/);
  // A broken environments.json only costs the allow-list check (see TP-skillsync-013);
  // it can no longer silently disable the whole sync.
  const broken = fakeRoot();
  writeFileSync(path.join(broken, 'configs', 'environments.json'), '{ nope');
  assert.match(await withEnv(() => syncSkills({ root: broken, gh: ghWith(SHA_OLD) })), /up-to-date/);
});

test('TP-skillsync-003: missing or malformed manifest skips the pass', async () => {
  assert.match(await withEnv(() => syncSkills({ root: fakeRoot({ manifest: null }) })), /^skipped \(no readable/);
  assert.match(await withEnv(() => syncSkills({ root: fakeRoot({ manifest: '{ bad' }) })), /^skipped/);
  assert.match(await withEnv(() => syncSkills({ root: fakeRoot({ manifest: { skills: {} } }) })), /^skipped/);
  assert.equal(readManifest(fakeRoot({ manifest: { skills: { x: { repo: 1 } } } })), null, 'shapeless entries are dropped');
});

test('TP-skillsync-004: local stamp — second pass is quiet, --force ignores the stamp, stale stamp re-checks', async () => {
  const root = fakeRoot();
  await withEnv(async (data) => {
    const gh = ghWith(SHA_OLD);
    let t = 1_000_000_000_000;
    const now = () => t;
    assert.match(await syncSkills({ root, gh, now }), /jest-skill up-to-date/);
    t += 60 * 60 * 1000; // one hour later
    assert.match(await syncSkills({ root, gh, now }), /^throttled/);
    assert.match(await syncSkills({ root, gh, now, force: true }), /up-to-date/, 'force bypasses');
    t += CHECK_INTERVAL_MS + 1; // past the window
    assert.match(await syncSkills({ root, gh, now }), /up-to-date/);
    assert.equal(existsSync(path.join(data, 'skills-sync', 'last-check')), true);
  });
});

test('TP-skillsync-005: unchanged upstream sha → up-to-date, publish never called', async () => {
  const root = fakeRoot();
  let published = 0;
  const summary = await withEnv(() => syncSkills({
    root, gh: ghWith(SHA_OLD), publish: () => { published++; return 'opened'; },
  }));
  assert.match(summary, /jest-skill up-to-date/);
  assert.equal(published, 0);
});

test('TP-skillsync-006: changed sha → ONE review PR, never a merge/push to main', async () => {
  const root = fakeRoot();
  /** @type {any[]} */
  const calls = [];
  const summary = await withEnv(() => syncSkills({
    root,
    gh: ghWith(SHA_NEW),
    publish: (p) => { calls.push(p); return 'opened'; },
  }));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].name, 'jest-skill');
  assert.equal(calls[0].newSha, SHA_NEW);
  assert.equal(calls[0].src.sha, SHA_OLD);
  assert.match(summary, /jest-skill update PR opened \(aaaaaaa → bbbbbbb\)/);
});

test('TP-skillsync-007: existing update branch dedupes — "already open"', async () => {
  const root = fakeRoot();
  const summary = await withEnv(() => syncSkills({
    root, gh: ghWith(SHA_NEW), publish: () => 'exists',
  }));
  assert.match(summary, /jest-skill update PR already open \(bbbbbbb\)/);
});

test('TP-skillsync-018: the agent-doctor verifier reaches publish, and a failure ANNOTATES rather than suppresses', async () => {
  // D6c: skill PRs get no ci.yml run (opened with GITHUB_TOKEN, no PAT), so agent-doctor
  // inside the job is their only automated check. A failure must still produce the PR —
  // suppressing it after the push would leave a branch the branch-exists dedupe then reads
  // as "already seen", silently swallowing every future PR for that sha.
  const root = fakeRoot();
  const verify = () => ({ ok: false, output: 'FAIL skill-creator: missing frontmatter key' });
  /** @type {any[]} */
  const calls = [];
  const summary = await withEnv(() => syncSkills({
    root, gh: ghWith(SHA_NEW), verify,
    publish: (p) => { calls.push(p); return 'opened-unverified'; },
  }));
  assert.equal(calls[0].verify, verify, 'the verifier is handed to the publisher, not re-derived');
  assert.match(summary, /jest-skill update PR opened but agent-doctor FAILED \(aaaaaaa → bbbbbbb\)/);
  // and the green path stays a plain "opened"
  const ok = await withEnv(() => syncSkills({
    root, gh: ghWith(SHA_NEW), verify: () => ({ ok: true, output: 'agent-doctor: OK' }),
    publish: () => 'opened',
  }));
  assert.match(ok, /jest-skill update PR opened \(aaaaaaa → bbbbbbb\)/);
});

test('TP-skillsync-019: agentDoctor runs the CLONE\'s own tool and reports pass/fail with its output', () => {
  // It must check the refreshed tree, not the tree it was launched from, and it must never
  // throw — a non-zero exit is data (the PR annotation), not a crash.
  const mk = (/** @type {string} */ body) => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'ws-skillsync-doctor-'));
    mkdirSync(path.join(dir, 'cli', 'util-tools'), { recursive: true });
    writeFileSync(path.join(dir, 'cli', 'util-tools', 'agent-doctor.js'), body);
    return dir;
  };
  const pass = agentDoctor(mk("console.log('agent-doctor: 12 files OK');\n"));
  assert.equal(pass.ok, true);
  assert.match(pass.output, /12 files OK/);
  const fail = agentDoctor(mk("console.log('FAIL rogue-skill: no frontmatter');\nprocess.exit(1);\n"));
  assert.equal(fail.ok, false);
  assert.match(fail.output, /FAIL rogue-skill/, 'the failure text must survive into the PR body');
  const missing = agentDoctor(mkdtempSync(path.join(os.tmpdir(), 'ws-skillsync-doctor-none-')));
  assert.equal(missing.ok, false, 'no tool in the clone is a failure, not a silent pass');
});

test('TP-skillsync-020: a pass that scanned NOTHING exits 1 — the scheduled run must not go green empty', async () => {
  // Regression: the first gh-workflow proof run reported success having checked zero
  // skills. workspaceDir() defaults to the station layout (~/sources/workspace), which does
  // not exist on a runner, so the manifest was unreadable and "skipped" read as a pass.
  // The job now sets WORKSPACE_DIR; this guards the other half — a silent skip is red.
  const tool = fileURLToPath(new URL('../util-tools/skills-upstream-sync.js', import.meta.url));
  const empty = mkdtempSync(path.join(os.tmpdir(), 'ws-skillsync-empty-'));
  const r = spawnSync(process.execPath, [tool], {
    encoding: 'utf8',
    env: { ...process.env, WORKSPACE_DIR: empty, WS_DATA_DIR: empty },
  });
  assert.equal(r.status, 1, 'no manifest scanned = exit 1');
  assert.match(r.stdout, /skills-upstream-sync: skipped \(no readable/);
});

test('TP-skillsync-008: gh/API failure degrades to a FAILED note; other skills still checked; never throws', async () => {
  const root = fakeRoot({
    manifest: { skills: {
      'jest-skill': { repo: 'LambdaTest/agent-skills', path: 'jest-skill', sha: SHA_OLD },
      'skill-creator': { repo: 'anthropics/skills', path: 'skills/skill-creator', sha: SHA_OLD },
    } },
  });
  const summary = await withEnv(() => syncSkills({
    root,
    gh: (args) => {
      if (String(args[1]).includes('LambdaTest')) throw new Error('HTTP 502');
      return JSON.stringify([{ sha: SHA_OLD }]);
    },
  }));
  assert.match(summary, /jest-skill check FAILED \(HTTP 502\)/);
  assert.match(summary, /skill-creator up-to-date/);
});

test('TP-skillsync-009: malformed gh api output makes that skill FAIL cleanly', async () => {
  const root = fakeRoot();
  const summary = await withEnv(() => syncSkills({ root, gh: () => '<!DOCTYPE html>' }));
  assert.match(summary, /jest-skill check FAILED/);
  assert.throws(() => latestUpstreamSha(() => '[]', { repo: 'r', path: 'p', sha: SHA_OLD }), /no commit sha/);
});

test('TP-skillsync-010: local-block extract/apply round-trip; no markers → none', () => {
  const block = `${LOCAL_START}\n## Workspace adaptation\ncontent\n${LOCAL_END}`;
  const text = `---\nname: x\n---\n\n# Skill\n\nbody\n\n${block}\n`;
  assert.deepEqual(extractLocalBlocks(text), [block]);
  assert.deepEqual(extractLocalBlocks('# plain upstream skill'), []);
  const applied = applyLocalBlocks('# fresh upstream\n', [block]);
  assert.ok(applied.endsWith(`${block}\n`));
  assert.equal(applyLocalBlocks('# fresh upstream\n', []), '# fresh upstream\n');
});

test('TP-skillsync-011: refreshSkillDir replaces files, re-applies local blocks, keeps workspace LICENSE', () => {
  const root = fakeRoot();
  const skillDir = path.join(root, '.claude', 'skills', 'jest-skill');
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(path.join(skillDir, 'SKILL.md'),
    `# old upstream\n\n${LOCAL_START}\nlocal notes\n${LOCAL_END}\n`);
  writeFileSync(path.join(skillDir, 'LICENSE.txt'), 'MIT (from upstream repo root)');
  writeFileSync(path.join(skillDir, 'stale-upstream-file.md'), 'removed upstream');
  const upstreamDir = mkdtempSync(path.join(os.tmpdir(), 'ws-skillsync-up-'));
  writeFileSync(path.join(upstreamDir, 'SKILL.md'), '# new upstream\n');
  mkdirSync(path.join(upstreamDir, 'reference'));
  writeFileSync(path.join(upstreamDir, 'reference', 'new.md'), 'new ref');
  const { localBlocks } = refreshSkillDir({ root, name: 'jest-skill', upstreamDir });
  assert.equal(localBlocks, 1);
  const skillMd = readFileSync(path.join(skillDir, 'SKILL.md'), 'utf8');
  assert.match(skillMd, /# new upstream/);
  assert.match(skillMd, /local notes/, 'workspace-local block re-applied');
  assert.equal(readFileSync(path.join(skillDir, 'LICENSE.txt'), 'utf8'), 'MIT (from upstream repo root)');
  assert.equal(existsSync(path.join(skillDir, 'stale-upstream-file.md')), false, 'stale files dropped');
  assert.deepEqual(readdirSync(path.join(skillDir, 'reference')), ['new.md']);
});

test('TP-skillsync-012: branch name pins the sha; PR title is the exact agreed form', () => {
  assert.equal(updateBranch('jest-skill', SHA_NEW), 'skills/jest-skill-bbbbbbb');
  assert.equal(prTitle('jest-skill'), "Agent: update for skill 'jest-skill'");
});

test('TP-skillsync-013: a repo outside the external_skills_git allow-list FAILS its check (no substitute sources)', async () => {
  const root = fakeRoot({
    manifest: { skills: { rogue: { repo: 'evil/skills', path: 'rogue', sha: SHA_OLD } } },
  });
  let published = 0;
  const summary = await withEnv(() => syncSkills({
    root, gh: ghWith(SHA_NEW), publish: () => { published++; return 'opened'; },
  }));
  assert.match(summary, /rogue check FAILED \(repo evil\/skills not in the external_skills_git allow-list\)/);
  assert.equal(published, 0);
  // Registry section absent entirely → enforcement is skipped (pre-registry compat).
  const noReg = fakeRoot({ registry: null });
  assert.match(await withEnv(() => syncSkills({ root: noReg, gh: ghWith(SHA_OLD) })), /jest-skill up-to-date/);
});
