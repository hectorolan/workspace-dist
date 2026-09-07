// TP-deptriage: Dependabot red-PR triage — the zero-token-when-idle trigger and the
// mechanically guarded merge path (see ws plan get test-plan-dependabot-triage).
// All gh + dispatch traffic is faked: no network, no real merges, no agent sessions.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  triage,
  guardMerge,
  checksVerdict,
  bumpKind,
  touchesTests,
  isDependabot,
  treeState, restoreTree,
} from '../util-tools/dependabot-triage.js';
import { checkAgentSource, checkReadmeIndex } from '../util-tools/agent-doctor.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const GREEN = [{ __typename: 'CheckRun', status: 'COMPLETED', conclusion: 'SUCCESS', name: 'ci' }];
const RED = [
  { __typename: 'CheckRun', status: 'COMPLETED', conclusion: 'SUCCESS', name: 'lint' },
  { __typename: 'CheckRun', status: 'COMPLETED', conclusion: 'FAILURE', name: 'ci' },
];
const PENDING = [{ __typename: 'CheckRun', status: 'IN_PROGRESS', conclusion: '', name: 'ci' }];

/** @typedef {Record<string, unknown>} PRView */

/**
 * Fake `gh` serving pr list / pr view / merge / comment from canned data and
 * recording every argv.
 * @param {{list?: unknown[], view?: PRView | (() => PRView)}} [data]
 */
function fakeGh({ list = [], view } = {}) {
  /** @type {string[][]} */
  const calls = [];
  /** @param {string[]} args */
  const gh = (args) => {
    calls.push(args);
    const cmd = args.slice(0, 2).join(' ');
    if (cmd === 'pr list') return JSON.stringify(list);
    if (cmd === 'pr view') {
      if (!view) throw new Error('fake gh: no view configured');
      return JSON.stringify(typeof view === 'function' ? view() : view);
    }
    if (cmd === 'pr merge') return '';
    if (cmd === 'pr comment') return '';
    throw new Error(`fake gh: unexpected argv ${args.join(' ')}`);
  };
  return { gh, calls };
}

/** @param {string[][]} calls @param {string} sub */
const callsOf = (calls, sub) => calls.filter((a) => a.slice(0, 2).join(' ') === `pr ${sub}`);

/**
 * A canned open Dependabot PR view/list row.
 * @param {Record<string, unknown>} [over]
 */
const dependabotPR = (over = {}) => ({
  number: 12,
  title: 'chore(deps): bump express from 4.18.2 to 4.19.0',
  url: 'https://github.com/hectorolan/workspace/pull/12',
  state: 'OPEN',
  author: { login: 'app/dependabot' },
  files: [{ path: 'package.json' }, { path: 'package-lock.json' }],
  statusCheckRollup: GREEN,
  ...over,
});

// --- the trigger: zero tokens when idle -------------------------------------------

test('TP-deptriage-001: idle — no open Dependabot PRs, no dispatch, "idle" diagnostic', async () => {
  const { gh } = fakeGh({ list: [] });
  let dispatched = 0;
  /** @type {string[]} */
  const lines = [];
  const r = await triage({ gh, dispatch: async () => { dispatched++; return { code: 0, output: '' }; }, out: (l) => lines.push(l) });
  assert.equal(r.dispatched, false);
  assert.equal(dispatched, 0);
  assert.match(lines.join('\n'), /idle/);
});

test('TP-deptriage-002: open Dependabot PRs but all green or pending — no dispatch', async () => {
  const { gh } = fakeGh({
    list: [dependabotPR(), dependabotPR({ number: 13, statusCheckRollup: PENDING })],
  });
  let dispatched = 0;
  const r = await triage({ gh, dispatch: async () => { dispatched++; return { code: 0, output: '' }; }, out: () => {} });
  assert.equal(r.dispatched, false);
  assert.equal(dispatched, 0);
});

test('TP-deptriage-003: a failing check dispatches exactly once, prompt names the PR and jr_implementer_github_dependabot', async () => {
  const { gh } = fakeGh({ list: [dependabotPR({ statusCheckRollup: RED })] });
  /** @type {string[]} */
  const prompts = [];
  const r = await triage({ gh, dispatch: async (p) => { prompts.push(p); return { code: 0, output: 'ok' }; }, out: () => {} });
  assert.equal(r.dispatched, true);
  assert.equal(prompts.length, 1);
  assert.match(prompts[0], /jr_implementer_github_dependabot/);
  assert.match(prompts[0], /#12\b/);
  assert.match(prompts[0], /pull\/12/);
});

test('TP-deptriage-004: a failing legacy StatusContext also counts as red', async () => {
  assert.equal(checksVerdict([{ __typename: 'StatusContext', state: 'FAILURE', context: 'ci' }]), 'red');
  assert.equal(checksVerdict([{ __typename: 'StatusContext', state: 'ERROR', context: 'ci' }]), 'red');
  assert.equal(checksVerdict([{ __typename: 'StatusContext', state: 'PENDING', context: 'ci' }]), 'pending');
  const { gh } = fakeGh({
    list: [dependabotPR({ statusCheckRollup: [{ __typename: 'StatusContext', state: 'FAILURE', context: 'ci' }] })],
  });
  const r = await triage({ gh, dispatch: async () => ({ code: 0, output: '' }), out: () => {} });
  assert.equal(r.dispatched, true);
});

test('TP-deptriage-005: a red PR by a non-Dependabot author is never dispatched', async () => {
  const { gh } = fakeGh({
    list: [dependabotPR({ statusCheckRollup: RED, author: { login: 'hectorolan' } })],
  });
  let dispatched = 0;
  const r = await triage({ gh, dispatch: async () => { dispatched++; return { code: 0, output: '' }; }, out: () => {} });
  assert.equal(r.dispatched, false);
  assert.equal(dispatched, 0);
  assert.equal(isDependabot('hectorolan'), false);
  assert.equal(isDependabot('app/dependabot'), true);
  assert.equal(isDependabot('dependabot[bot]'), true);
});

// --- the merge guard: the four rules, mechanically --------------------------------

test('TP-deptriage-006: author guard — non-Dependabot PR is REFUSED with no merge and no comment', async () => {
  const { gh, calls } = fakeGh({ view: dependabotPR({ author: { login: 'hectorolan' } }) });
  /** @type {string[]} */
  const lines = [];
  const r = await guardMerge(12, { gh, out: (l) => lines.push(l) });
  assert.equal(r.merged, false);
  assert.equal(r.reason, 'author');
  assert.equal(callsOf(calls, 'merge').length, 0);
  assert.equal(callsOf(calls, 'comment').length, 0);
  assert.match(lines.join('\n'), /REFUSED/);
});

test('TP-deptriage-007: test-file guard — a diff touching a test file is REFUSED with one comment, no merge', async () => {
  const { gh, calls } = fakeGh({
    view: dependabotPR({ files: [{ path: 'package.json' }, { path: 'cli/test/foo.test.js' }] }),
  });
  const r = await guardMerge(12, { gh, out: () => {} });
  assert.equal(r.merged, false);
  assert.equal(r.reason, 'tests');
  assert.equal(callsOf(calls, 'merge').length, 0);
  const comments = callsOf(calls, 'comment');
  assert.equal(comments.length, 1);
  assert.match(comments[0].join(' '), /cli\/test\/foo\.test\.js/);
});

test('TP-deptriage-008: test-file patterns match test paths and nothing else', () => {
  assert.deepEqual(touchesTests(['cli/test/x.test.js']), ['cli/test/x.test.js']);
  assert.deepEqual(touchesTests(['server/test/y.test.js']), ['server/test/y.test.js']);
  assert.deepEqual(touchesTests(['src/a.spec.ts']), ['src/a.spec.ts']);
  assert.deepEqual(touchesTests(['pkg/__tests__/z.js']), ['pkg/__tests__/z.js']);
  assert.deepEqual(touchesTests(['tests/helper.js']), ['tests/helper.js']);
  assert.deepEqual(touchesTests(['package.json', 'package-lock.json', 'cli/util/agent.js', 'docs/latest-notes.md', 'server/server.js']), []);
});

test('TP-deptriage-009: major guard — a major bump is REFUSED with one comment, no merge', async () => {
  const { gh, calls } = fakeGh({
    view: dependabotPR({ title: 'chore(deps): bump express from 4.18.2 to 5.0.0' }),
  });
  const r = await guardMerge(12, { gh, out: () => {} });
  assert.equal(r.merged, false);
  assert.equal(r.reason, 'major');
  assert.equal(callsOf(calls, 'merge').length, 0);
  assert.equal(callsOf(calls, 'comment').length, 1);
});

test('TP-deptriage-010: an unparseable bump title is refused as major (conservative)', async () => {
  const { gh, calls } = fakeGh({
    view: dependabotPR({ title: 'chore(deps): bump the npm_and_yarn group with 3 updates' }),
  });
  const r = await guardMerge(12, { gh, out: () => {} });
  assert.equal(r.merged, false);
  assert.equal(r.reason, 'major');
  assert.equal(callsOf(calls, 'merge').length, 0);
  assert.equal(bumpKind('bump the npm_and_yarn group with 3 updates'), 'unknown');
});

test('TP-deptriage-011: still-red checks at merge time are REFUSED, no merge, no wait', async () => {
  const { gh, calls } = fakeGh({ view: dependabotPR({ statusCheckRollup: RED }) });
  const r = await guardMerge(12, { gh, out: () => {} });
  assert.equal(r.merged, false);
  assert.equal(r.reason, 'not-green');
  assert.equal(callsOf(calls, 'merge').length, 0);
});

test('TP-deptriage-012: --wait polls pending checks to green, then merges', async () => {
  let views = 0;
  const { gh, calls } = fakeGh({
    view: () => dependabotPR({ statusCheckRollup: ++views < 3 ? PENDING : GREEN }),
  });
  const r = await guardMerge(12, { gh, waitMinutes: 1, pollMs: 1, sleep: async () => {}, out: () => {} });
  assert.equal(r.merged, true);
  assert.equal(callsOf(calls, 'merge').length, 1);
  assert.ok(views >= 3);
});

test('TP-deptriage-013: --wait budget exhausted while still pending — REFUSED, no merge', async () => {
  const { gh, calls } = fakeGh({ view: dependabotPR({ statusCheckRollup: PENDING }) });
  const r = await guardMerge(12, { gh, waitMinutes: 0.0005, pollMs: 1, sleep: async () => {}, out: () => {} });
  assert.equal(r.merged, false);
  assert.equal(r.reason, 'not-green');
  assert.equal(callsOf(calls, 'merge').length, 0);
});

test('TP-deptriage-014: a green minor Dependabot PR merges with exactly --squash', async () => {
  const { gh, calls } = fakeGh({ view: dependabotPR() });
  const r = await guardMerge(12, { gh, out: () => {} });
  assert.equal(r.merged, true);
  const merges = callsOf(calls, 'merge');
  assert.equal(merges.length, 1);
  assert.deepEqual(merges[0], ['pr', 'merge', '12', '--squash']);
});

test('TP-deptriage-015: bump parsing — minor/patch are non-major, v-prefix and prerelease parse', () => {
  assert.equal(bumpKind('bump foo from 1.2.3 to 1.3.0'), 'minor-or-patch');
  assert.equal(bumpKind('bump foo from 1.2.3 to 1.2.4'), 'minor-or-patch');
  assert.equal(bumpKind('bump actions/checkout from 4 to 5'), 'major');
  assert.equal(bumpKind('bump express from 4.18.2 to 5.0.0'), 'major');
  assert.equal(bumpKind('bump foo from v3.1.0 to v4.0.0'), 'major');
  assert.equal(bumpKind('bump foo from 2.0.0-rc.1 to 2.0.0'), 'minor-or-patch');
});

// --- wiring + registration ---------------------------------------------------------

test('TP-deptriage-017: jobs.json has the dependabot-triage entry running the tool, daily, no boot catch-up', () => {
  const cfg = JSON.parse(readFileSync(path.join(ROOT, 'configs', 'jobs', 'jobs.json'), 'utf8'));
  const job = (cfg.jobs || []).find((/** @type {{name: string}} */ j) => j.name === 'dependabot-triage');
  assert.ok(job, 'no dependabot-triage job in configs/jobs/jobs.json');
  assert.match(String(job.run), /cli\/util-tools\/dependabot-triage\.js/);
  // No catch-up: with catchUpArgs (or a runJob block's --if-missing default) the job
  // would also fire on EVERY container boot — including each self-restart — and could
  // re-dispatch an agent while a red PR is mid-fix. A missed 5:30 slot just waits a day.
  assert.equal(job.catchUpArgs, undefined);
  assert.equal(job.runJob, undefined);
});

test('TP-deptriage-018: jr_implementer_github_dependabot registers (agent-doctor static) and is indexed in .claude/README.md', () => {
  const file = path.join(ROOT, '.claude', 'agents', 'jr_implementer_github_dependabot.md');
  const { name, findings } = checkAgentSource('jr_implementer_github_dependabot', readFileSync(file, 'utf8'));
  assert.equal(name, 'jr_implementer_github_dependabot');
  assert.deepEqual(findings.filter((f) => f.level === 'FAIL'), []);
  const agentDir = path.join(ROOT, '.claude', 'agents');
  const skillDir = path.join(ROOT, '.claude', 'skills');
  const agents = readdirSync(agentDir).filter((f) => f.endsWith('.md') && f.toLowerCase() !== 'readme.md').map((f) => path.basename(f, '.md'));
  const skills = readdirSync(skillDir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && existsSync(path.join(skillDir, d.name, 'SKILL.md')))
    .map((d) => d.name);
  assert.ok(agents.includes('jr_implementer_github_dependabot'));
  const readme = readFileSync(path.join(ROOT, '.claude', 'README.md'), 'utf8');
  assert.deepEqual(checkReadmeIndex(readme, { agents, skills }), []);
});

/** A fake git whose branch/dirtiness the test drives. */
function fakeGit({ branch = 'main', dirty = false } = {}) {
  /** @type {string[]} */
  const calls = [];
  let cur = branch;
  /** @param {string[]} a */
  const git = (a) => {
    calls.push(a.join(' '));
    if (a[0] === 'rev-parse') return `${cur}\n`;
    if (a[0] === 'status') return dirty ? ' M cli/util/x.js\n' : '\n';
    if (a[0] === 'checkout') { cur = a[1]; return ''; }
    throw new Error(`unexpected git ${a.join(' ')}`);
  };
  return { git, calls, at: () => cur };
}

test('TP-deptriage-021: a tree left on a Dependabot branch is restored to where it started', () => {
  // Observed live 2026-08-01: `gh pr checkout` switched the working tree and nothing
  // switched it back, stranding this clone on a week-old branch. On the container
  // that means the live host sits on a Dependabot branch and the next `ws sync`
  // commits to the WRONG branch.
  const f = fakeGit({ branch: 'main' });
  const before = treeState(f.git);
  f.git(['checkout', 'dependabot/npm_and_yarn/types/node-26.1.2']); // the agent
  const verdict = restoreTree(before, { git: f.git, out: () => {} });
  assert.equal(verdict, 'restored');
  assert.equal(f.at(), 'main');
});

test('TP-deptriage-022: a DIRTY tree is never force-switched — the warning is the whole contract', () => {
  // The agent may have died mid-fix. Switching would discard or drag that work
  // across branches, which is worse than staying put and saying so.
  const f = fakeGit({ branch: 'main', dirty: true });
  const before = { branch: 'main', dirty: false };
  f.git(['checkout', 'dependabot/x']);
  /** @type {string[]} */
  const lines = [];
  const verdict = restoreTree(before, { git: f.git, out: (l) => lines.push(l) });
  assert.equal(verdict, 'left-dirty');
  assert.equal(f.at(), 'dependabot/x', 'stays put');
  assert.match(lines.join(' '), /WARNING/);
  assert.match(lines.join(' '), /wrong branch/);
});

test('TP-deptriage-023: an unchanged tree is a silent no-op, and an unknown start never guesses', () => {
  const f = fakeGit({ branch: 'main' });
  assert.equal(restoreTree({ branch: 'main', dirty: false }, { git: f.git, out: () => {} }), 'unchanged');
  assert.ok(!f.calls.some((c) => c.startsWith('checkout')), 'no checkout when nothing moved');
  // git unavailable at start => branch '' => never act on a guess
  assert.equal(restoreTree({ branch: '', dirty: true }, { git: f.git, out: () => {} }), 'unknown');
});
