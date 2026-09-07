// TP-planclose: evidence-based test-plan closure for main-direct repos plus the
// pinned CEO block (plan `ws plan get test-plan-planclose`).
//
// Scope: the pure decision logic (what a run must cover, what holds a plan, what
// the block says) and the sweep's degradation paths. The plan API round trip
// itself belongs to `ws plan` and is covered by the plans suite; the fact that
// `ws sync` hands its green tallies in is asserted by the wiring case at the end.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  automatedCaseIds, automatedRows, closureVerdict, ceoAsks, authoredAsks,
  pinCeoBlock, stripCeoBlock, stripPlanHeader, sweepClosures, sweepFromBaseline, CLOSE_AGENT,
} from '../util/planclose.js';
import { renderBaseline } from '../util/baseline.js';
import { ceoName } from '../util/ceo.js';

/** A plan body: two automated cases, one manual case with an authored ask. */
const HELD_PLAN = `# Test plan - demo

Intro prose mentioning manual work, which must never hold a plan.

## Needs the CEO

- TP-demo-003 — run the guard against a real red main once so we can watch it block.

## Cases

| ID | Case | Coverage |
|---|---|---|
| TP-demo-001 | thing one | automated |
| TP-demo-002 | thing two | automated |
| TP-demo-003 | eyeball the live VM | manual (needs Hector) |
`;

/** Same shape, no manual case — the plan that should close on its own. */
const CLEAN_PLAN = `# Test plan - clean

| ID | Case | Coverage |
|---|---|---|
| TP-clean-001 | a | automated |
| TP-clean-002 | b | automated |
`;

/**
 * @param {Array<{slug: string, repo: string|null, status: string}>} rows
 * @param {Record<string, string>} bodies
 * @param {Partial<{list: Function, get: Function, set: Function}>} [over]
 */
function fakePlans(rows, bodies, over = {}) {
  /** @type {Array<{slug: string, fields: any}>} */
  const sets = [];
  // `any`: these fakes satisfy the shapes sweepClosures actually calls, not the
  // full apiclient signatures the PlanDeps typedef points at.
  /** @type {any} */
  const deps = {
    // The REAL envelope the log API returns — `{ok, count, plans}`, never a bare
    // array. A fake that returned an array hid a total-failure bug once already.
    list: async () => JSON.stringify({ ok: true, count: rows.length, plans: rows }),
    /** @param {string} slug */
    get: async (slug) => bodies[slug],
    /** @param {string} slug @param {any} fields */
    set: async (slug, fields) => { sets.push({ slug, fields }); },
    ...over,
  };
  return { deps, sets };
}

function fakeLog() {
  /** @type {any[]} */
  const lines = [];
  /** @type {any} */
  const fn = async (/** @type {any} */ l) => { lines.push(l); };
  return { lines, fn };
}

test('TP-planclose-001: automated case IDs exclude manual/deferred rows — a plan is never "missing coverage" for work no machine was going to do', () => {
  assert.deepEqual(automatedCaseIds(HELD_PLAN), ['TP-demo-001', 'TP-demo-002']);
});

test('TP-planclose-002: prose and bullets never contribute case IDs — only table rows do', () => {
  const body = '# T\n\nSee TP-x-009 for context.\n\n- TP-x-010 mentioned in a bullet\n';
  assert.deepEqual(automatedCaseIds(body), []);
});

test('TP-planclose-003: a run covering only some automated cases is `skip` — the work is unfinished, not blocked on Hector', () => {
  const v = closureVerdict({ body: HELD_PLAN, covered: ['TP-demo-001'] });
  assert.equal(v.action, 'skip');
  assert.deepEqual(v.missing, ['TP-demo-002']);
});

test('TP-planclose-004: full coverage with no holds closes the plan', () => {
  const v = closureVerdict({ body: CLEAN_PLAN, covered: ['TP-clean-001', 'TP-clean-002'] });
  assert.equal(v.action, 'close');
});

test('TP-planclose-005: full coverage with an unperformed manual case holds, and the ask names it', () => {
  const v = closureVerdict({ body: HELD_PLAN, covered: ['TP-demo-001', 'TP-demo-002'] });
  assert.equal(v.action, 'hold');
  assert.equal(v.asks.length, 1);
  assert.match(v.asks[0], /red main/);
  assert.match(v.asks[0], /TP-demo-003/);
});

test('TP-planclose-006: coverage is judged BEFORE the human hold — an unfinished plan never pins a CEO block', () => {
  // Both a missing automated case AND an unperformed manual case: the verdict
  // must be `skip`. Blaming Hector for work still in progress would train him to
  // ignore the block entirely.
  const v = closureVerdict({ body: HELD_PLAN, covered: [] });
  assert.equal(v.action, 'skip');
  assert.deepEqual(v.asks, []);
});

test('TP-planclose-007: a plan with no automated case IDs is `skip` — a test run can evidence nothing about it', () => {
  const v = closureVerdict({ body: '# T\n\njust prose', covered: ['TP-x-001'] });
  assert.equal(v.action, 'skip');
  assert.match(v.reason, /no automated case IDs/);
});

test('TP-planclose-008: an executed manual case does not hold — past-tense evidence closes it out', () => {
  const done = HELD_PLAN.replace('manual (needs Hector)', 'manual - performed 2026-07-28, evidence in the log line');
  const v = closureVerdict({ body: done, covered: ['TP-demo-001', 'TP-demo-002'] });
  assert.equal(v.action, 'close');
});

test('TP-planclose-009: pin then strip round-trips to the exact original body', () => {
  const pinned = pinCeoBlock(HELD_PLAN, ceoAsks(HELD_PLAN));
  assert.notEqual(pinned, HELD_PLAN);
  assert.equal(stripCeoBlock(pinned), HELD_PLAN);
});

test('TP-planclose-010: pinning is idempotent — repeated sweeps never stack blocks or accrete whitespace', () => {
  const asks = ceoAsks(HELD_PLAN);
  const once = pinCeoBlock(HELD_PLAN, asks);
  const twice = pinCeoBlock(once, asks);
  assert.equal(twice, once);
  assert.equal((twice.match(/ceo-block/g) || []).length, 2); // one open, one close
});

test('TP-planclose-011: the block sits directly under the H1, above all other content', () => {
  const pinned = pinCeoBlock(HELD_PLAN, ceoAsks(HELD_PLAN));
  const lines = pinned.split('\n');
  assert.match(lines[0], /^# /);
  assert.equal(lines[2], '<!-- ceo-block -->');
  assert.ok(pinned.indexOf('ceo-block') < pinned.indexOf('Intro prose'));
});

test('TP-planclose-012: no asks means no block at all — a healthy plan carries no banner', () => {
  assert.equal(pinCeoBlock(CLEAN_PLAN, []), CLEAN_PLAN);
});

test('TP-planclose-013: the authored colloquial sentence wins over the mechanical fallback', () => {
  assert.equal(authoredAsks(HELD_PLAN).get('TP-demo-003'),
    'run the guard against a real red main once so we can watch it block.');
});

test('TP-planclose-014: with no authored bullet the case description is used — a missing sentence is visible, not silent', () => {
  const noSection = HELD_PLAN.replace(/## Needs the CEO[\s\S]*?\n## Cases/, '## Cases');
  const asks = ceoAsks(noSection);
  assert.equal(asks.length, 1);
  assert.match(asks[0], /eyeball the live VM/);
});

test('TP-planclose-026: a case citing other case IDs is covered when those are — "regression: existing suites" stays traceable', () => {
  const body = `# T
| ID | Case | Coverage |
|---|---|---|
| TP-x-001 | a | automated |
| TP-x-002 | regression | automated (existing TP-y-001/002 kept green) |
`;
  const covered = ['TP-x-001', 'TP-y-001', 'TP-y-002'];
  assert.equal(closureVerdict({ body, covered }).action, 'close');
  // …and NOT covered when a cited case is missing: citation is a chain of
  // evidence, not a way to opt out of having any.
  assert.equal(closureVerdict({ body, covered: ['TP-x-001', 'TP-y-001'] }).action, 'skip');
});

test('TP-planclose-027: bare NNN citations resolve against the row\'s own prefix', () => {
  const body = `# T
| ID | Case | Coverage |
|---|---|---|
| TP-x-003 | covered elsewhere | automated (010/012 cover the module contract) |
| TP-x-010 | ten | automated |
| TP-x-012 | twelve | automated |
`;
  assert.equal(closureVerdict({ body, covered: ['TP-x-010', 'TP-x-012'] }).action, 'close');
});

test('TP-planclose-028: an "automated" claim citing NO case IDs is untraceable and never self-satisfies', () => {
  // The strict rule Hector chose: a label is not evidence. `automated (existing
  // suites)` names nothing checkable, so it holds the plan until someone writes
  // the test or cites what really covers it.
  const body = '# T\n| ID | Case | Coverage |\n|---|---|---|\n| TP-x-004 | vague | automated (existing suites) |\n';
  const v = closureVerdict({ body, covered: [] });
  assert.equal(v.action, 'skip');
  assert.deepEqual(v.missing, ['TP-x-004']);
});

test('TP-planclose-029: the tail of a cited shorthand run is not re-read as a bare local citation', () => {
  // Regression: `TP-prwatch-plan-close-001/002/005` had its `002`/`005` picked up
  // a second time as bare numbers and resolved against the ROW's prefix,
  // inventing TP-obs48b-002/005 as required citations and holding the plan on
  // cases nobody cited.
  const body = '# T\n| ID | Case | Coverage |\n|---|---|---|\n'
    + '| TP-obs48b-003 | regression | automated (existing TP-prwatch-plan-close-001/002/005 kept green) |\n';
  const [row] = automatedRows(body);
  assert.deepEqual(row.cites, [
    'TP-prwatch-plan-close-001', 'TP-prwatch-plan-close-002', 'TP-prwatch-plan-close-005',
  ]);
});

test('TP-planclose-030: bullet-form cases are read too — a table is not the only way plans are written', () => {
  // A plan written entirely in bullets read as "no automated cases" and was
  // therefore permanently unclosable, which is the exact failure this module exists
  // to remove.
  const body = `# T

- TP-server-tz-001 (automated): posts a date
- TP-server-tz-006 (automated, regression): existing server suites stay green
- TP-server-tz-007 (manual, deferred — needs the live VM): container run
`;
  assert.deepEqual(automatedCaseIds(body), ['TP-server-tz-001', 'TP-server-tz-006']);
  // The manual bullet is excluded from coverage AND still holds the plan.
  const v = closureVerdict({ body, covered: ['TP-server-tz-001', 'TP-server-tz-006'] });
  assert.equal(v.action, 'hold');
});

test('TP-planclose-036: a list introduced as automated carries the mode for its bold-ID bullets', () => {
  // Live failure (2026-08-18): `hub-conversation-archive-api-2026-08-17` declared the
  // mode once per list and bolded each ID, so the closer reported "no automated case
  // IDs" while all ten of its cases were green — unclosable for the same reason the
  // bullet form above was added.
  const body = `# T

## Cases

Server suite (\`server/test/x.test.js\`) — all \`automated\`:

- **TP-lead-001** — happy path
- **TP-lead-002** — role validation: unknown role -> 400, limit 500 respected

Manual cases: **none** — everything above is machine-checkable.

## Fixtures

- **TP-lead-009** — prose after a heading claims nothing, so it is not automated
`;
  // The 400/500 in a description are prose, never citations: read as bare local
  // citations they would invent TP-lead-400/500 and hold the plan forever.
  assert.deepEqual(automatedRows(body), [
    { id: 'TP-lead-001', cites: [] },
    { id: 'TP-lead-002', cites: [] },
  ]);
  assert.equal(closureVerdict({ body, covered: ['TP-lead-001', 'TP-lead-002'] }).action, 'close');
});

test('TP-planclose-037: a manual lead-in never becomes coverage, and an explicit row mode beats the list', () => {
  const body = `# T

Manual cases — all \`manual\`:

- **TP-lead-003** — the CEO signs in on the live VM
- **TP-lead-004** (automated): actually covered by a test despite the list

Automated cases, all \`automated\`:

- **TP-lead-005** (manual): the row's own word wins over the list
- **TP-lead-006** — plain member of an automated list
`;
  assert.deepEqual(automatedCaseIds(body), ['TP-lead-004', 'TP-lead-006']);
});

test('TP-planclose-031: the rendered plan header is stripped before any write — headers must not stack', async () => {
  // Real corruption: planGet returns the rendered `# slug | kind | status | …`
  // banner, planSet stores what it is given, so a read-modify-write baked the
  // banner into the body and the next read rendered another on top. Repeated
  // leading headers are all removed, which self-heals already-stacked plans.
  const stacked = '# my-plan | test-plan | active | 2026-07-31 | Title\n\n'
    + '# my-plan | test-plan | active | 2026-07-30 | Title\n\n'
    + CLEAN_PLAN;
  assert.equal(stripPlanHeader(stacked), CLEAN_PLAN);
  assert.equal(stripPlanHeader(CLEAN_PLAN), CLEAN_PLAN); // a real H1 is never eaten

  const { deps, sets } = fakePlans(
    [{ slug: 'p-held', repo: 'workspace', status: 'active' }],
    { 'p-held': `# p-held | test-plan | active | 2026-07-31 | T\n\n${HELD_PLAN}` },
  );
  await sweepClosures({
    repo: 'workspace', covered: ['TP-demo-001', 'TP-demo-002'], plans: deps, log: fakeLog().fn,
  });
  assert.ok(!/^#\s+p-held\s+\|/m.test(sets[0].fields.body));
});

test('TP-planclose-032: a wrapped colloquial ask is read whole, not truncated at the first line', () => {
  const body = `# T

## Needs the CEO

- TP-demo-003 — open the Stations page and check the new control-plane checks
  actually show up there. Nothing changed on the ho-nexus side, so this is just
  confirming the generic renderer picked them up.

## Cases

| ID | Case | Coverage |
|---|---|---|
| TP-demo-003 | eyeball it | manual (needs Hector) |
`;
  const ask = authoredAsks(body).get('TP-demo-003') || '';
  assert.match(ask, /generic renderer picked them up/);
  assert.ok(!ask.includes('\n'));
});

test('TP-planclose-015: the sweep closes an eligible plan and writes one `done` line', async () => {
  const { deps, sets } = fakePlans(
    [{ slug: 'p-clean', repo: 'workspace', status: 'active' }],
    { 'p-clean': CLEAN_PLAN },
  );
  const log = fakeLog();
  const out = await sweepClosures({
    repo: 'workspace', covered: ['TP-clean-001', 'TP-clean-002'], plans: deps, log: log.fn,
  });
  assert.deepEqual(out.closed, ['p-clean']);
  assert.equal(sets[0].fields.status, 'done');
  assert.equal(log.lines.length, 1);
  assert.equal(log.lines[0].status, 'done');
  assert.equal(log.lines[0].agent, CLOSE_AGENT);
});

test('TP-planclose-016: the sweep pins the block on a held plan and writes one `blocked` line naming the ask', async () => {
  const { deps, sets } = fakePlans(
    [{ slug: 'p-held', repo: 'workspace', status: 'active' }],
    { 'p-held': HELD_PLAN },
  );
  const log = fakeLog();
  const out = await sweepClosures({
    repo: 'workspace', covered: ['TP-demo-001', 'TP-demo-002'], plans: deps, log: log.fn,
  });
  assert.deepEqual(out.held, ['p-held']);
  // Derived, never literal: hardcoding the operator's name here is what made a
  // CEO rename fail the suite — and since ci-guard gates every sync, that meant
  // the rename commit could not land at all (audit 2026-08-01).
  assert.match(sets[0].fields.body, new RegExp(`${ceoName()}, I need you to`));
  assert.equal(sets[0].fields.status, undefined); // held, never closed
  assert.equal(log.lines[0].status, 'blocked');
  assert.match(log.lines[0].message, /red main/);
});

test('TP-planclose-033: a hold logs ONCE, not on every sweep — an unchanged block writes no duplicate line', async () => {
  // Observed live: the same `blocked` line landed on every sync (4 identical
  // copies in two days), burying the real signal in the surface meant to carry it.
  const held = pinCeoBlock(HELD_PLAN, ceoAsks(HELD_PLAN));
  const { deps, sets } = fakePlans(
    [{ slug: 'p-held', repo: 'workspace', status: 'active' }],
    { 'p-held': held }, // already carrying an up-to-date block
  );
  const log = fakeLog();
  const out = await sweepClosures({
    repo: 'workspace', covered: ['TP-demo-001', 'TP-demo-002'], plans: deps, log: log.fn,
  });
  assert.deepEqual(out.held, ['p-held'], 'still reported as held');
  assert.equal(sets.length, 0, 'no rewrite when the block is unchanged');
  assert.equal(log.lines.length, 0, 'and no duplicate line');
  assert.match(out.notes[0], /still held, unchanged/);
});

test('TP-planclose-034: a CHANGED ask does log again — a new thing to do must still reach the CEO', async () => {
  // The other half of 033: silence is only correct while nothing changed.
  const stale = pinCeoBlock(HELD_PLAN, ['something that is no longer the ask']);
  const { deps, sets } = fakePlans(
    [{ slug: 'p-held', repo: 'workspace', status: 'active' }],
    { 'p-held': stale },
  );
  const log = fakeLog();
  await sweepClosures({
    repo: 'workspace', covered: ['TP-demo-001', 'TP-demo-002'], plans: deps, log: log.fn,
  });
  assert.equal(sets.length, 1, 'block rewritten to the current ask');
  assert.equal(log.lines.length, 1);
  assert.equal(log.lines[0].status, 'blocked');
  assert.match(log.lines[0].message, /red main/);
});

test('TP-planclose-017: closing strips a stale CEO block — no plan is archived carrying an "I need you to" banner', async () => {
  const stale = pinCeoBlock(CLEAN_PLAN, ['do something that is now done']);
  const { deps, sets } = fakePlans(
    [{ slug: 'p-stale', repo: 'workspace', status: 'active' }],
    { 'p-stale': stale },
  );
  const out = await sweepClosures({
    repo: 'workspace', covered: ['TP-clean-001', 'TP-clean-002'], plans: deps, log: fakeLog().fn,
  });
  assert.deepEqual(out.closed, ['p-stale']);
  assert.equal(sets[0].fields.body, CLEAN_PLAN);
  assert.ok(!sets[0].fields.body.includes('ceo-block'));
});

test('TP-planclose-018: the sweep touches only plans of the given repo; a null repo counts as workspace (prwatch\'s default)', async () => {
  const { deps, sets } = fakePlans(
    [
      { slug: 'p-other-repo', repo: 'ho-nexus', status: 'active' },
      { slug: 'p-null-repo', repo: null, status: 'active' },
      { slug: 'p-mine', repo: 'workspace', status: 'active' },
    ],
    { 'p-other-repo': CLEAN_PLAN, 'p-null-repo': CLEAN_PLAN, 'p-mine': CLEAN_PLAN },
  );
  await sweepClosures({
    repo: 'workspace', covered: ['TP-clean-001', 'TP-clean-002'], plans: deps, log: fakeLog().fn,
  });
  assert.deepEqual(sets.map((s) => s.slug).sort(), ['p-mine', 'p-null-repo']);
});

test('TP-planclose-025: the list response envelope is unwrapped, and terminal statuses are excluded SERVER-side', async () => {
  // Regression for a real bug: the API returns `{ok, count, plans}`, and reading
  // it as a bare array made the sweep throw before touching a single plan —
  // closing nothing, forever, while every unit test using an array fake passed.
  /** @type {any} */
  let sawOpts;
  const { deps, sets } = fakePlans(
    [{ slug: 'p-mine', repo: 'workspace', status: 'active' }],
    { 'p-mine': CLEAN_PLAN },
    {
      list: async (/** @type {any} */ opts) => {
        sawOpts = opts;
        return JSON.stringify({ ok: true, count: 1, plans: [{ slug: 'p-mine', repo: 'workspace' }] });
      },
    },
  );
  await sweepClosures({
    repo: 'workspace', covered: ['TP-clean-001', 'TP-clean-002'], plans: deps, log: fakeLog().fn,
  });
  assert.equal(sawOpts.exclude, 'done,archived');
  assert.equal(sawOpts.kind, 'test-plan');
  assert.deepEqual(sets.map((s) => s.slug), ['p-mine']);
});

test('TP-planclose-019: a plan-list failure writes ONE `failed` line — a stranded sweep never looks healthy', async () => {
  const { deps } = fakePlans([], {}, { list: async () => { throw new Error('API down'); } });
  const log = fakeLog();
  const out = await sweepClosures({ repo: 'workspace', covered: [], plans: deps, log: log.fn });
  assert.deepEqual(out.closed, []);
  assert.equal(log.lines.length, 1);
  assert.equal(log.lines[0].status, 'failed');
});

test('TP-planclose-020: a plan-set failure on close writes ONE `failed` line naming the plan (no retry is coming)', async () => {
  const { deps } = fakePlans(
    [{ slug: 'p-clean', repo: 'workspace', status: 'active' }],
    { 'p-clean': CLEAN_PLAN },
    { set: async () => { throw new Error('write refused'); } },
  );
  const log = fakeLog();
  const out = await sweepClosures({
    repo: 'workspace', covered: ['TP-clean-001', 'TP-clean-002'], plans: deps, log: log.fn,
  });
  assert.deepEqual(out.closed, []);
  assert.equal(log.lines[0].status, 'failed');
  assert.match(log.lines[0].message, /p-clean/);
});

test('TP-planclose-021: a per-plan get failure degrades to a note, never a line and never a throw', async () => {
  const { deps } = fakePlans(
    [{ slug: 'p-bad', repo: 'workspace', status: 'active' }],
    {},
    { get: async () => { throw new Error('gone'); } },
  );
  const log = fakeLog();
  const out = await sweepClosures({ repo: 'workspace', covered: [], plans: deps, log: log.fn });
  assert.equal(log.lines.length, 0);
  assert.match(out.notes[0], /plan get failed/);
});

test('TP-planclose-022: a throwing log never breaks the sweep — the push has already landed', async () => {
  const { deps } = fakePlans(
    [{ slug: 'p-clean', repo: 'workspace', status: 'active' }],
    { 'p-clean': CLEAN_PLAN },
  );
  // The sink MUST be redirected. A throwing log is exactly the path `audit()`
  // persists to `<WS_DATA_DIR>/fallback/audit-failures.md` — the disaster-recovery
  // re-import file — so without this the suite appended a FABRICATED
  // "test-plan p-clean closed" line to it on every run, on every station, via
  // every ci-guard-gated `ws sync` (audit 2026-08-01, reproduced 8→9 lines).
  // A test must never write to a real recovery artifact.
  const dir = mkdtempSync(path.join(tmpdir(), 'ws-audit-'));
  const sink = path.join(dir, 'audit-failures.md');
  try {
    const out = await sweepClosures({
      repo: 'workspace',
      covered: ['TP-clean-001', 'TP-clean-002'],
      plans: deps,
      log: async () => { throw new Error('log down'); },
      sink,
    });
    assert.deepEqual(out.closed, ['p-clean']);
    // …and the failure IS still recorded — never-silent is the whole point of audit().
    assert.match(readFileSync(sink, 'utf8'), /p-clean/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('TP-planclose-035: the sweep writes its audit failures to the injected sink, never to the real recovery file', async () => {
  // Guard for the defect above: if `sink` ever stops being threaded through
  // sweepClosures, this fails instead of silently polluting the DR file again.
  const dir = mkdtempSync(path.join(tmpdir(), 'ws-audit-'));
  const sink = path.join(dir, 'nested', 'audit-failures.md');
  try {
    const { deps } = fakePlans(
      [{ slug: 'p-held', repo: 'workspace', status: 'active' }],
      { 'p-held': HELD_PLAN },
    );
    await sweepClosures({
      repo: 'workspace',
      covered: ['TP-demo-001', 'TP-demo-002'],
      plans: deps,
      log: async () => { throw new Error('log down'); },
      sink,
    });
    assert.ok(existsSync(sink), 'the injected sink received the line');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('TP-planclose-023: wiring — `ws sync` feeds the sweep the case IDs its green suite tallies carry', async () => {
  // The contract between ciguard's suiteRuns (baseline.tallyFromOutput shape) and
  // this sweep: `cases` on a green tally IS the covered set. Asserting the shape
  // here keeps a rename on either side from silently closing nothing forever.
  const { tallyFromOutput } = await import('../util/baseline.js');
  const tally = tallyFromOutput('✔ TP-clean-001: a (1ms)\n✔ TP-clean-002: b (1ms)\nℹ pass 2\nℹ fail 0');
  const covered = new Set(Object.values({ cli: tally }).flatMap((r) => r.cases || []));
  const v = closureVerdict({ body: CLEAN_PLAN, covered });
  assert.equal(v.action, 'close');
});

test('TP-plan-integrity-020: a plan closes and the audit write throws — never silent (loud diagnostic + durable line)', async () => {
  // backlog 42: these lines used to be `await log({...}).catch(() => {})`, so a
  // plan could close with no audit line and nothing anywhere said so.
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-planclose-audit-'));
  const prev = process.env.WS_DATA_DIR;
  process.env.WS_DATA_DIR = dataDir;
  const realErr = console.error;
  /** @type {string[]} */
  const errs = [];
  console.error = (/** @type {any[]} */ ...a) => { errs.push(a.join(' ')); };
  try {
    const { deps } = fakePlans(
      [{ slug: 'p-clean', repo: 'workspace', status: 'active' }],
      { 'p-clean': CLEAN_PLAN },
    );
    const out = await sweepClosures({
      repo: 'workspace',
      covered: ['TP-clean-001', 'TP-clean-002'],
      plans: deps,
      log: async () => { throw new Error('log down'); },
    });
    assert.deepEqual(out.closed, ['p-clean']); // the close itself still happened
    assert.ok(errs.some((l) => /AUDIT WRITE FAILED/.test(l) && /p-clean/.test(l)), errs.join('\n'));
    const sink = path.join(dataDir, 'fallback', 'audit-failures.md');
    assert.match(fs.readFileSync(sink, 'utf8'), /\| plan-close \| done \| test-plan p-clean closed/);
  } finally {
    console.error = realErr;
    if (prev === undefined) delete process.env.WS_DATA_DIR; else process.env.WS_DATA_DIR = prev;
  }
});

// --- case-ID suffix grammar (duplicate resolution, plan test-plan-case-id-suffix) ---

test('TP-caseid-005: suffixed row IDs parse in table and bullet form; citations resolve suffixed, never inventing the bare ID', () => {
  const body = `# Test plan - suffixed

| ID | Case | Coverage |
|---|---|---|
| TP-mix-001 | first claimant stays bare | automated |
| TP-mix-001_2 | second claimant, suffixed | automated |
| TP-mix-002 | regression cell citing a suffixed case | automated (TP-mix-001_2 kept green) |
| TP-mix-003 | bare-number citation with suffix | automated (001_2 covers it) |

- TP-mix-004_2 (automated): bullet-form suffixed case
`;
  const rows = automatedRows(body);
  assert.deepEqual(rows.map((r) => r.id),
    ['TP-mix-001', 'TP-mix-001_2', 'TP-mix-002', 'TP-mix-003', 'TP-mix-004_2']);
  assert.deepEqual(rows.find((r) => r.id === 'TP-mix-002')?.cites, ['TP-mix-001_2']);
  // `001_2` cites the SUFFIXED case — a bare `TP-mix-001` must not be invented
  // out of it (that is the silent false-close this grammar exists to prevent).
  assert.deepEqual(rows.find((r) => r.id === 'TP-mix-003')?.cites, ['TP-mix-001_2']);
});

test('TP-caseid-006: the closer treats bare and suffixed as distinct — bare coverage never satisfies the suffixed case', () => {
  const body = `# Test plan - distinct

| ID | Case | Coverage |
|---|---|---|
| TP-demo-010 | first claimant | automated |
| TP-demo-010_2 | second claimant | automated |
`;
  const partial = closureVerdict({ body, covered: ['TP-demo-010'] });
  assert.equal(partial.action, 'skip');
  assert.deepEqual(partial.missing, ['TP-demo-010_2']);
  const full = closureVerdict({ body, covered: ['TP-demo-010', 'TP-demo-010_2'] });
  assert.equal(full.action, 'close');
});

// --- cadence-driven closure on the pull tick (plan pull-tick-plan-close-2026-08-27) ---
//
// The stranding this section guards against: a main-direct plan CREATED after its
// landing sync's plan-close sweep (dist-phase2-rulings-2026-08-26 — plan revision
// 631, baseline advance for the same sync at 629) had no trigger left until some
// unrelated future push. sweepFromBaseline reads the covered set out of the STORED
// baseline plan and runs the same sweep on every `ws pull` tick.

/** @param {string[]} cases */
function baselineBody(cases) {
  return renderBaseline({
    repo: 'workspace',
    updated: '2026-08-27',
    suites: { cli: { commit: 'abc1234', pass: cases.length, fail: 0, cases: [...cases].sort(), date: '2026-08-27' } },
  });
}

test('TP-planclose-pull-001: a plan stranded by trigger ordering closes on a later pull tick with no new push — the stored baseline is the evidence', async () => {
  const { deps, sets } = fakePlans(
    [{ slug: 'p-stranded', repo: 'workspace', status: 'active' }],
    { 'p-stranded': CLEAN_PLAN },
  );
  const log = fakeLog();
  const out = await sweepFromBaseline({
    repo: 'workspace',
    getBaseline: async () => baselineBody(['TP-clean-001', 'TP-clean-002']),
    plans: deps,
    log: log.fn,
  });
  assert.deepEqual(out.closed, ['p-stranded']);
  assert.equal(sets[0].fields.status, 'done');
  assert.equal(log.lines.length, 1);
  assert.equal(log.lines[0].status, 'done');
  assert.equal(log.lines[0].agent, CLOSE_AGENT);
  assert.match(out.summary, /p-stranded/);
});

test('TP-planclose-pull-002: a repeated tick after a close is silent — the closed plan is out of the active list, zero writes, zero lines', async () => {
  /** @type {Array<{slug: string, repo: string, status: string}>} */
  const rows = [{ slug: 'p-once', repo: 'workspace', status: 'active' }];
  /** @type {any[]} */
  const sets = [];
  /** @type {any} */
  const deps = {
    // Server-side exclude, like the real API: a done plan drops out of the list.
    list: async () => JSON.stringify({ ok: true, plans: rows.filter((r) => r.status === 'active') }),
    get: async () => CLEAN_PLAN,
    /** @param {string} slug @param {any} fields */
    set: async (slug, fields) => {
      sets.push({ slug, fields });
      if (fields.status) rows[0].status = fields.status;
    },
  };
  const log = fakeLog();
  const tick = () => sweepFromBaseline({
    repo: 'workspace',
    getBaseline: async () => baselineBody(['TP-clean-001', 'TP-clean-002']),
    plans: deps,
    log: log.fn,
  });
  const first = await tick();
  assert.deepEqual(first.closed, ['p-once']);
  assert.equal(sets.length, 1);
  assert.equal(log.lines.length, 1);
  const second = await tick();
  assert.deepEqual(second.closed, []);
  assert.equal(sets.length, 1, 'no second plan write');
  assert.equal(log.lines.length, 1, 'no duplicate audit line on the repeat tick');
});

test('TP-planclose-pull-003: an unchanged hold across ticks logs `blocked` on the TRANSITION only — the pinned CEO block is the state', async () => {
  const bodies = { 'p-held': HELD_PLAN };
  /** @type {any[]} */
  const sets = [];
  /** @type {any} */
  const deps = {
    list: async () => JSON.stringify({ ok: true, plans: [{ slug: 'p-held', repo: 'workspace', status: 'active' }] }),
    /** @param {string} slug */
    get: async (slug) => bodies[/** @type {'p-held'} */ (slug)],
    /** @param {string} slug @param {any} fields */
    set: async (slug, fields) => {
      sets.push({ slug, fields });
      if (fields.body) bodies[/** @type {'p-held'} */ (slug)] = fields.body; // the pin persists, like the real DB
    },
  };
  const log = fakeLog();
  const tick = () => sweepFromBaseline({
    repo: 'workspace',
    getBaseline: async () => baselineBody(['TP-demo-001', 'TP-demo-002']),
    plans: deps,
    log: log.fn,
  });
  const first = await tick();
  assert.deepEqual(first.held, ['p-held']);
  assert.equal(sets.length, 1, 'the pin is written once');
  assert.equal(log.lines.length, 1);
  assert.equal(log.lines[0].status, 'blocked');
  const second = await tick();
  assert.deepEqual(second.held, ['p-held']);
  assert.equal(sets.length, 1, 'an unchanged hold is not re-pinned');
  assert.equal(log.lines.length, 1, 'pulls run every 15 min on every station — a chatty hold would flood the log');
  assert.ok(second.notes.some((n) => /still held, unchanged/.test(n)));
});

test('TP-planclose-pull-004: an absent, unparseable, or unreachable baseline is a QUIET skip — no plan reads, no audit line, retried next tick', async () => {
  for (const getBaseline of [
    async () => 'no json fence in this body', // unparseable = absent
    async () => { throw new Error('API down'); }, // unreachable = quiet, NOT a loud line every 15 min
  ]) {
    let listed = false;
    /** @type {any} */
    const deps = {
      list: async () => { listed = true; return JSON.stringify({ ok: true, plans: [] }); },
      get: async () => CLEAN_PLAN,
      set: async () => {},
    };
    const log = fakeLog();
    const out = await sweepFromBaseline({ repo: 'workspace', getBaseline, plans: deps, log: log.fn });
    assert.deepEqual(out.closed, []);
    assert.match(out.summary, /skipped/);
    assert.equal(listed, false, 'no baseline means nothing to judge against, so no plan list call');
    assert.equal(log.lines.length, 0, 'an outage must not queue a failed line per tick');
  }
});

test('TP-planclose-pull-005: a plan-list failure AFTER a healthy baseline read still writes the ONE loud `failed` line (backlog-48b through the new entry point)', async () => {
  /** @type {any} */
  const deps = {
    list: async () => { throw new Error('list down'); },
    get: async () => CLEAN_PLAN,
    set: async () => {},
  };
  const log = fakeLog();
  const out = await sweepFromBaseline({
    repo: 'workspace',
    getBaseline: async () => baselineBody(['TP-clean-001', 'TP-clean-002']),
    plans: deps,
    log: log.fn,
  });
  assert.deepEqual(out.closed, []);
  assert.equal(log.lines.length, 1);
  assert.equal(log.lines[0].status, 'failed');
  assert.equal(log.lines[0].agent, CLOSE_AGENT);
});

test('TP-planclose-pull-006: wiring — `ws pull` runs the baseline sweep after pr-watch, before the status-sweep, inside a degrade-only try/catch', () => {
  const src = readFileSync(new URL('../ws.js', import.meta.url), 'utf8');
  const pullAt = src.indexOf('async pull()');
  const prwatchAt = src.indexOf("import('./util/prwatch.js')", pullAt);
  const sweepAt = src.indexOf('sweepFromBaseline', pullAt);
  const statusAt = src.indexOf("import('./util/statussweep.js')", pullAt);
  assert.ok(pullAt > -1 && prwatchAt > -1 && statusAt > -1, 'the pull tick and its sweeps exist');
  assert.ok(sweepAt > prwatchAt, 'the plan-close sweep runs after pr-watch (which may close PR-repo plans first)');
  assert.ok(sweepAt < statusAt, 'and before the status-sweep, so a close this tick resolves blocked lines in the same tick');
  assert.ok(src.includes('ws pull: plan-close skipped'), 'a sweep failure degrades to a note — never fails the pull');
});

test('TP-planclose-pull-007: a baseline with zero covered case IDs is a quiet skip — nothing to judge, no plan reads', async () => {
  let listed = false;
  /** @type {any} */
  const deps = {
    list: async () => { listed = true; return JSON.stringify({ ok: true, plans: [] }); },
    get: async () => CLEAN_PLAN,
    set: async () => {},
  };
  const log = fakeLog();
  const out = await sweepFromBaseline({
    repo: 'workspace',
    getBaseline: async () => baselineBody([]),
    plans: deps,
    log: log.fn,
  });
  assert.match(out.summary, /skipped/);
  assert.equal(listed, false);
  assert.equal(log.lines.length, 0);
});
