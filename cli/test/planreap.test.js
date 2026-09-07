// TP-planreap: plan-scoped temp-tests, reaped when their test-plan closes
// (plan `ws plan get test-plan-planreap`, backlog 60).
//
// Scope: the pure per-file edit logic (tag parsing, span boundaries, the
// conservative abort paths), the sweep's filesystem behaviour on synthetic temp
// trees, and the baseline strip that keeps a reap from reading as a regression.
// The plan API round trip belongs to `ws plan`; `ws sync`'s hook is asserted by
// the wiring canary at the end.
//
// NOTE: fixture tag lines are built with `tagLine()` (string concatenation) so
// this file's own source never contains a literal tag — otherwise the real
// sweep would read this suite's fixtures as unknown-plan tags on every sync.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  findTags, reapContent, harvestCaseIds, sweepReap, stripReaped,
  stripBaselinePlan, defaultStatusOf, nodeCheck, referencingFiles, WORKSPACE_SUITES, REAP_AGENT,
} from '../util/planreap.js';
import { compareSuite } from '../util/baseline.js';

/** Build a tag comment line without embedding a literal tag in THIS file.
 * @param {string} slug @param {string} disposition */
const tagLine = (slug, disposition) => '// @plan' + ':' + slug + ' @' + disposition;

/** Statuses used by every sweep fixture. @type {(slugs: string[]) => Promise<Map<string, string>>} */
const statusOf = async () => new Map([
  ['closed-plan', 'done'],
  ['archived-plan', 'archived'],
  ['open-plan', 'active'],
]);

/** No-op syntax check for speed; nodeCheck itself is exercised in 009. */
const okCheck = () => null;

/** A file with one throwaway test (closed plan) and one permanent test. */
const THROW_FILE = [
  "import { test } from 'node:test';",
  '',
  '// proves the fix once, then goes',
  tagLine('closed-plan', 'throwaway'),
  "test('TP-demo-001/002: proves it', () => {",
  '  if (!1) throw new Error("no");',
  '});',
  '',
  "test('TP-demo-003: stays forever', () => {",
  '  if (!1) throw new Error("no");',
  '});',
  '',
].join('\n');

/** A file whose only test is a promoted one (closed plan). */
const PROMOTE_FILE = [
  "import { test } from 'node:test';",
  '',
  tagLine('closed-plan', 'promote'),
  "test('TP-demo-010: guards behaviour', () => {",
  '  if (!1) throw new Error("no");',
  '});',
  '',
].join('\n');

/** Write a one-suite fixture tree; returns its root.
 * @param {Record<string, string>} files */
function fixtureTree(files) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'planreap-fix-'));
  mkdirSync(path.join(root, 't'), { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(path.join(root, 't', name), content);
  }
  return root;
}

const SUITES = [{ suite: 'cli', dir: 't', match: /\.test\.js$/ }];

test('TP-planreap-001: tag parse — slug and disposition read from a dedicated comment line', () => {
  const tags = findTags(THROW_FILE);
  assert.equal(tags.length, 1);
  assert.equal(tags[0].slug, 'closed-plan');
  assert.equal(tags[0].disposition, 'throwaway');
  const p = findTags(PROMOTE_FILE);
  assert.equal(p[0].disposition, 'promote');
});

test('TP-planreap-002: closed @throwaway — tag comment and whole test block removed, output parses', () => {
  const r = reapContent(THROW_FILE, () => 'reap');
  assert.equal(r.changed, true);
  assert.equal(r.removedTests, 1);
  assert.ok(!r.content.includes('TP-demo-001'));
  assert.ok(!r.content.includes('proves the fix once'));
  assert.ok(r.content.includes('TP-demo-003: stays forever'));
  assert.equal(nodeCheck(r.content), null);
  assert.deepEqual(r.reapedPlans, ['closed-plan']);
});

test('TP-planreap-003: closed @promote — only the tag line removed, everything else byte-identical', () => {
  const r = reapContent(PROMOTE_FILE, () => 'reap');
  assert.equal(r.changed, true);
  assert.equal(r.removedTests, 0);
  assert.deepEqual(r.promotedPlans, ['closed-plan']);
  const expected = PROMOTE_FILE.split('\n').filter((l) => !l.includes('@plan' + ':')).join('\n');
  assert.equal(r.content, expected);
});

test('TP-planreap-004: open plan — both tag kinds left untouched', () => {
  for (const src of [THROW_FILE, PROMOTE_FILE]) {
    const r = reapContent(src, () => 'keep');
    assert.equal(r.changed, false);
    assert.equal(r.content, src);
    assert.deepEqual(r.notes, []);
  }
});

test('TP-planreap-005: unknown plan slug — left alone, note printed', () => {
  const r = reapContent(THROW_FILE, () => 'unknown');
  assert.equal(r.changed, false);
  assert.equal(r.content, THROW_FILE);
  assert.equal(r.notes.length, 1);
  assert.match(r.notes[0], /unknown/);
});

test('TP-planreap-006: throwaway tag not directly above a top-level test — left alone, note', () => {
  const src = [
    tagLine('closed-plan', 'throwaway'),
    'const helper = () => 1;',
    '',
    "test('TP-x-001: indented owner', () => {",
    '});',
    '',
  ].join('\n');
  const r = reapContent(src, () => 'reap');
  assert.equal(r.changed, false);
  assert.equal(r.content, src);
  assert.match(r.notes[0], /not directly above a top-level test/);
});

test('TP-planreap-007: unterminated test block — left alone, note', () => {
  const src = [
    tagLine('closed-plan', 'throwaway'),
    "test('TP-x-001: never closes', () => {",
    '  const x = 1;',
    '',
  ].join('\n');
  const r = reapContent(src, () => 'reap');
  assert.equal(r.changed, false);
  assert.match(r.notes[0], /no terminating/);
});

test('TP-planreap-008: span guard — another column-0 test inside the computed span aborts the file untouched', () => {
  // The terminator of the first test is missing its own `});`, so a naive span
  // would swallow the following test whole. The guard refuses instead.
  const src = [
    tagLine('closed-plan', 'throwaway'),
    "test('TP-x-001: a', () => {",
    '  const weird = 1;',
    "test('TP-x-002: innocent bystander', () => {",
    '});',
    '',
  ].join('\n');
  const r = reapContent(src, () => 'reap');
  assert.equal(r.changed, false);
  assert.equal(r.content, src);
  assert.match(r.notes[0], /another top-level test/);
});

test('TP-planreap-009: syntax-check failure after an edit restores the file byte-identical, note', async () => {
  const root = fixtureTree({ 'a.test.js': THROW_FILE });
  try {
    const out = await sweepReap({ root, suites: SUITES, statusOf, check: () => 'parse error (fixture)' });
    assert.deepEqual(out.changedFiles, []);
    assert.deepEqual(out.removedCaseIds, []);
    assert.ok(out.notes.some((n) => /edit aborted/.test(n)));
    assert.equal(readFileSync(path.join(root, 't', 'a.test.js'), 'utf8'), THROW_FILE);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
  // The real checker recognises both outcomes.
  assert.equal(nodeCheck("import { test } from 'node:test';\n"), null);
  assert.ok(nodeCheck('test((( broken'));
});

test('TP-planreap-010: file with no tests left after reaping is deleted whole', async () => {
  const onlyThrowaway = [
    "import { test } from 'node:test';",
    '',
    tagLine('closed-plan', 'throwaway'),
    "test('TP-gone-001: one-time proof', () => {",
    '});',
    '',
  ].join('\n');
  const root = fixtureTree({ 'gone.test.js': onlyThrowaway });
  try {
    const out = await sweepReap({ root, suites: SUITES, statusOf, check: okCheck });
    assert.deepEqual(out.deletedFiles, ['t/gone.test.js']);
    assert.equal(existsSync(path.join(root, 't', 'gone.test.js')), false);
    assert.deepEqual(out.removedCaseIds, ['TP-gone-001']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('TP-planreap-011: case-ID harvest expands slash runs from removed spans', () => {
  const r = reapContent(THROW_FILE, () => 'reap');
  assert.deepEqual(r.removedIds, ['TP-demo-001', 'TP-demo-002']);
  assert.deepEqual([...harvestCaseIds('x TP-a-001/003 y')].sort(), ['TP-a-001', 'TP-a-003']);
});

test('TP-planreap-012: an ID still referenced by a surviving test is never stripped', async () => {
  const shared = [
    tagLine('closed-plan', 'throwaway'),
    "test('TP-demo-003: duplicate proof', () => {",
    '});',
    '',
  ].join('\n');
  // THROW_FILE keeps a permanent test named TP-demo-003, so that ID survives.
  const root = fixtureTree({ 'a.test.js': THROW_FILE, 'b.test.js': shared });
  try {
    const out = await sweepReap({ root, suites: SUITES, statusOf, check: okCheck });
    assert.ok(!out.removedCaseIds.includes('TP-demo-003'));
    assert.deepEqual(out.removedCaseIds, ['TP-demo-001', 'TP-demo-002']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('TP-planreap-013: stripReaped drops removed IDs from cases and resets the reaped suite pass to 0', () => {
  const baseline = {
    repo: 'workspace', updated: '2026-07-31',
    suites: {
      cli: { commit: 'abc1234', pass: 100, fail: 0, cases: ['TP-demo-001', 'TP-demo-002', 'TP-keep-001'], date: '2026-07-31' },
      server: { commit: 'abc1234', pass: 40, fail: 0, cases: ['TP-srv-001'], date: '2026-07-31' },
    },
  };
  const { baseline: next, changed } = stripReaped(baseline, ['TP-demo-001', 'TP-demo-002'], ['cli']);
  assert.equal(changed, true);
  assert.ok(next);
  assert.deepEqual(next.suites.cli.cases, ['TP-keep-001']);
  assert.equal(next.suites.cli.pass, 0);
  assert.equal(next.suites.server.pass, 40);
});

test('TP-planreap-014: stripReaped leaves untouched suites alone; nothing-to-strip reports changed=false', () => {
  const baseline = {
    repo: 'workspace', updated: '2026-07-31',
    suites: { server: { commit: 'abc1234', pass: 40, fail: 0, cases: ['TP-srv-001'], date: '2026-07-31' } },
  };
  const same = stripReaped(baseline, ['TP-nowhere-001'], []);
  assert.equal(same.changed, false);
  assert.deepEqual(same.baseline, baseline);
  assert.equal(stripReaped(null, ['TP-x-001'], ['cli']).changed, false);
});

test('TP-planreap-015: post-reap run reads matched, not REGRESSED, against the stripped baseline', () => {
  const base = { commit: 'abc1234', pass: 100, fail: 0, cases: ['TP-demo-001', 'TP-demo-002', 'TP-keep-001'], date: '2026-08-01' };
  const run = { pass: 98, fail: 0, cases: ['TP-keep-001'] }; // reaped IDs gone, pass dropped
  // Unstripped, this is exactly the false regression backlog 60 names.
  assert.equal(compareSuite(base, run, { suite: 'cli', today: '2026-08-01' }).state, 'regressed');
  const { baseline: next } = stripReaped(
    { repo: 'workspace', updated: '2026-08-01', suites: { cli: base } },
    ['TP-demo-001', 'TP-demo-002'],
    ['cli']
  );
  assert.ok(next);
  assert.equal(compareSuite(next.suites.cli, run, { suite: 'cli', today: '2026-08-01' }).state, 'matched');
});

test('TP-planreap-016: idempotence — a second sweep over the already-reaped tree changes nothing', async () => {
  const root = fixtureTree({ 'a.test.js': THROW_FILE, 'b.test.js': PROMOTE_FILE });
  try {
    const first = await sweepReap({ root, suites: SUITES, statusOf, check: okCheck });
    assert.equal(first.changedFiles.length, 2);
    const second = await sweepReap({ root, suites: SUITES, statusOf, check: okCheck });
    assert.deepEqual(second.changedFiles, []);
    assert.deepEqual(second.deletedFiles, []);
    assert.deepEqual(second.removedCaseIds, []);
    assert.deepEqual(second.notes, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('TP-planreap-017: mixed tags in one file — throwaway deleted and promote untagged in one pass', () => {
  const src = [
    tagLine('closed-plan', 'promote'),
    "test('TP-mix-001: graduates', () => {",
    '});',
    '',
    tagLine('archived-plan', 'throwaway'),
    "test('TP-mix-002: goes', () => {",
    '});',
    '',
  ].join('\n');
  const r = reapContent(src, () => 'reap');
  assert.ok(r.content.includes('TP-mix-001'));
  assert.ok(!r.content.includes('@plan'));
  assert.ok(!r.content.includes('TP-mix-002'));
  assert.deepEqual(r.reapedPlans, ['archived-plan']);
  assert.deepEqual(r.promotedPlans, ['closed-plan']);
});

test('TP-planreap-018: promote tag sharing its comment line with prose loses only the tag tokens', () => {
  const src = [
    '// worth keeping: guards the retry path. ' + '@plan' + ':closed-plan @promote',
    "test('TP-mix-003: kept', () => {",
    '});',
    '',
  ].join('\n');
  const r = reapContent(src, () => 'reap');
  assert.ok(r.content.includes('// worth keeping: guards the retry path.'));
  assert.ok(!r.content.includes('@plan'));
  assert.ok(!r.content.includes('@promote'));
  assert.ok(r.content.includes('TP-mix-003'));
});

test('TP-planreap-019: plan-status lookup failure skips the whole sweep with a note — never throws, never edits', async () => {
  const root = fixtureTree({ 'a.test.js': THROW_FILE });
  try {
    const out = await sweepReap({
      root, suites: SUITES, check: okCheck,
      statusOf: async () => { throw new Error('API down'); },
    });
    assert.deepEqual(out.changedFiles, []);
    assert.ok(out.notes.some((n) => /sweep skipped/.test(n) && /API down/.test(n)));
    assert.equal(readFileSync(path.join(root, 't', 'a.test.js'), 'utf8'), THROW_FILE);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('TP-planreap-020: dry-run computes identical results and writes nothing', async () => {
  const root = fixtureTree({ 'a.test.js': THROW_FILE });
  try {
    const dry = await sweepReap({ root, suites: SUITES, statusOf, check: okCheck, apply: false });
    assert.deepEqual(dry.changedFiles, ['t/a.test.js']);
    assert.deepEqual(dry.removedCaseIds, ['TP-demo-001', 'TP-demo-002']);
    assert.equal(readFileSync(path.join(root, 't', 'a.test.js'), 'utf8'), THROW_FILE);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('TP-planreap-021: default status lookup maps the kind=test-plan JSON list to slug->status', async () => {
  let asked = /** @type {*} */ (null);
  /** @type {typeof import('../util/apiclient.js').planList} */
  const list = async (params) => {
    asked = params;
    return JSON.stringify({ ok: true, count: 2, plans: [
      { slug: 'closed-plan', status: 'done' },
      { slug: 'open-plan', status: 'active' },
    ] });
  };
  const map = await defaultStatusOf(['closed-plan', 'open-plan'], list);
  assert.equal(map.get('closed-plan'), 'done');
  assert.equal(map.get('open-plan'), 'active');
  assert.equal(asked && asked.kind, 'test-plan');
  assert.equal(asked && asked.format, 'json');
});

test('TP-planreap-022: wiring — ws sync runs the reaper pre-commit and hands the stripped baseline to the guard', () => {
  const src = readFileSync(new URL('../ws.js', import.meta.url), 'utf8');
  const reapAt = src.indexOf("import('./util/planreap.js')");
  const commitAt = src.indexOf('syncWorkspace(dir, message');
  assert.ok(reapAt > -1, 'ws sync imports the reaper');
  assert.ok(commitAt > reapAt, 'the reaper runs BEFORE the commit, so deletions ride it');
  assert.ok(src.includes('paths.push('), 'a scoped sync carries the reaped paths');
  assert.ok(src.includes('stripBaselinePlan'), 'the baseline strip is wired');
  assert.ok(src.includes('baseline = strip.baseline'), 'the guard compares against the stripped baseline');
});

test('TP-planreap-023: baseline-strip write failure degrades to a note; the in-memory strip survives', async () => {
  const current = {
    repo: 'workspace', updated: '2026-08-01',
    suites: { cli: { commit: 'abc1234', pass: 10, fail: 0, cases: ['TP-demo-001', 'TP-keep-001'], date: '2026-08-01' } },
  };
  /** @type {Array<{slug: string, fields: Record<string, unknown>}>} */
  const calls = [];
  const out = await stripBaselinePlan({
    repo: 'workspace',
    removedCaseIds: ['TP-demo-001'],
    reapedSuites: ['cli'],
    current,
    plans: {
      get: async () => { throw new Error('unused'); },
      set: async (slug, fields) => { calls.push({ slug, fields: fields || {} }); throw new Error('API down'); },
    },
  });
  assert.equal(out.changed, true);
  assert.match(out.note, /not persisted/);
  assert.deepEqual(out.baseline && out.baseline.suites.cli.cases, ['TP-keep-001']);
  assert.equal(out.baseline && out.baseline.suites.cli.pass, 0);
  // The write it attempted was attributed to the reaper.
  assert.equal(calls[0] && calls[0].fields.agent, REAP_AGENT);
});

test('workspace suite specs cover exactly the two test directories', () => {
  // Not a numbered case: a canary that the repo-parameterised default still
  // matches this repo's layout (TP-planreap-024/025 are citation rows).
  assert.deepEqual(WORKSPACE_SUITES.map((s) => `${s.suite}:${s.dir}`), ['cli:cli/test', 'server:server/test']);
});

test('TP-planreap-024: an emptied file that another test IMPORTS is kept, not deleted — deleting it wedges every ws sync retry', async () => {
  // Reproduced live 2026-08-01 before the guard existed: the reaper emptied a
  // file whose every test was throwaway and deleted it whole, while a sibling
  // still imported a fixture from it. `nodeCheck` parses ONE file, so it cannot
  // see a cross-file import — the suite went red, ci-guard refused the push, and
  // the deletion was ALREADY staged, so every retry hit the same wall. That
  // wedges the one path every station needs to push anything.
  const root = mkdtempSync(path.join(os.tmpdir(), 'ws-reap-imp-'));
  try {
    mkdirSync(path.join(root, 'cli', 'test'), { recursive: true });
    const shared = path.join(root, 'cli', 'test', 'shared.test.js');
    const consumer = path.join(root, 'cli', 'test', 'consumer.test.js');
    writeFileSync(shared, `import { test } from 'node:test';
export const fixture = { a: 1 };

${tagLine('closed-plan', 'throwaway')}
test('TP-imp-001: one-time proof', () => {});
`);
    writeFileSync(consumer, `import { test } from 'node:test';
import { fixture } from './shared.test.js';
test('TP-imp-002: permanent, needs the fixture', () => { if (!fixture) throw new Error('x'); });
`);

    const out = await sweepReap({
      root,
      suites: [{ suite: 'cli', dir: 'cli/test', match: /\.test\.js$/ }],
      statusOf: async () => new Map([['closed-plan', 'done']]),
      apply: true,
    });

    assert.deepEqual(out.deletedFiles, [], 'an imported file is never deleted');
    assert.ok(existsSync(shared), 'the import target still resolves');
    assert.match(out.notes.join(' '), /imported by/);
    // …and the throwaway test really was reaped from it — kept, not skipped.
    assert.ok(!readFileSync(shared, 'utf8').includes('TP-imp-001'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('TP-planreap-025: referencingFiles matches ESM and CJS, with and without the extension', () => {
  const target = { rel: 'cli/test/shared.test.js', abs: '/x/cli/test/shared.test.js' };
  /** @param {string} rel @param {string} content */
  const mk = (rel, content) => ({ rel, abs: `/x/${rel}`, content });
  const hits = referencingFiles(target, [
    mk('cli/test/a.test.js', "import { f } from './shared.test.js';"),
    mk('cli/test/b.test.js', "import { f } from './shared.test';"),
    mk('cli/test/c.test.js', "const { f } = require('./shared');"),
    mk('cli/test/d.test.js', "import { f } from './unrelated.js';"),
  ]);
  assert.deepEqual(hits.sort(), ['cli/test/a.test.js', 'cli/test/b.test.js', 'cli/test/c.test.js']);
});

// --- case-ID suffix grammar (duplicate resolution, plan test-plan-case-id-suffix) ---

test('TP-caseid-008: harvestCaseIds reads suffixed IDs, alone and as run heads', () => {
  const ids = harvestCaseIds('covers TP-r-001_2 plus the run TP-r-002_2/003 and bare TP-r-004');
  assert.deepEqual([...ids].sort(), ['TP-r-001_2', 'TP-r-002_2', 'TP-r-003', 'TP-r-004']);
});
