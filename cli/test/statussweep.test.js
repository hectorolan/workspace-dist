// TP-status-sweep: stale-status sweep — resolves (repo, area) pairs whose newest
// log line is non-terminal (PR-open/blocked/deployed-staging) but whose work is
// provably finished; leaves everything else alone (see ws plan get
// test-plan-status-sweep). All gh + log-API + plan-API traffic is faked — no
// network, no real writes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sweepStaleStatus, SWEEP_AGENT } from '../util/statussweep.js';

/**
 * Fake `gh` serving repo list / pr view from canned data.
 * @param {{repos?: string[], views?: Record<string, {state: string, title?: string}>, fail?: string[]}} data
 */
function fakeGh({ repos = ['hectorolan/ho-nexus', 'hectorolan/workspace'], views = {}, fail = [] }) {
  return (/** @type {string[]} */ args) => {
    const cmd = args.slice(0, 2).join(' ');
    if (fail.includes(cmd)) throw new Error(`fake gh failure: ${cmd}`);
    if (cmd === 'repo list') return JSON.stringify(repos.map((nameWithOwner) => ({ nameWithOwner })));
    if (cmd === 'pr view') {
      const key = `${args[args.indexOf('-R') + 1]}#${args[2]}`;
      if (fail.includes(`pr view ${key}`)) throw new Error('fake pr view failure');
      const view = views[key];
      if (!view) throw new Error(`fake gh: no view for ${key}`);
      return JSON.stringify(view);
    }
    throw new Error(`fake gh: unexpected argv ${args.join(' ')}`);
  };
}

/**
 * In-memory log store implementing the slice of the /log contract the sweep uses
 * (status/repo/area filters, id order, limit keeps newest) and capturing writes.
 * @param {Array<{repo: string, area: string, status: string, agent?: string|null, message?: string}>} seed
 */
function fakeStore(seed = []) {
  let id = 0;
  const entries = seed.map((e) => ({ agent: null, message: '', ...e, id: ++id }));
  /** @type {typeof entries} */
  const written = [];
  return {
    entries,
    written,
    /** @type {typeof import('../util/apiclient.js').query} */
    query: async ({ params = {} }) => {
      let rows = entries.filter((e) =>
        (!params.status || e.status === params.status)
        && (!params.repo || e.repo === params.repo)
        && (!params.area || e.area === params.area));
      // /log orders by id DESC, applies LIMIT, then reverses — a limit keeps the
      // NEWEST rows, returned oldest-first.
      const limit = Number(params.limit || 50);
      if (rows.length > limit) rows = rows.slice(rows.length - limit);
      return JSON.stringify({ ok: true, entries: rows });
    },
    /** @type {typeof import('../util/apiclient.js').log} */
    log: async ({ repo = 'workspace', area, status, message, agent = '' }) => {
      const entry = { repo, area, status, message, agent, id: ++id };
      entries.push(entry);
      written.push(entry);
      return { ok: true, line: `${repo} | ${area} | ${status} | ${message}` };
    },
  };
}

/**
 * Fake planList: the JSON index (bodies elided) the sweep reads statuses from.
 * @param {Array<{slug: string, status?: string, kind?: string, repo?: string|null}>} seed
 */
function fakePlanList(seed = []) {
  const rows = seed.map((p) => ({ kind: 'test-plan', status: 'active', repo: null, ...p }));
  /** @type {typeof import('../util/apiclient.js').planList} */
  const list = async () => JSON.stringify({ ok: true, count: rows.length, plans: rows });
  return list;
}

const HO = 'hectorolan/ho-nexus';

test('TP-status-sweep-001: dangling PR-open citing a merged PR resolves with one done line in the same area', async () => {
  const store = fakeStore([
    { repo: 'ho-nexus', area: 'feat/x', status: 'PR-open', agent: 'implementer', message: 'shipped, PR #23, test plan tp-x' },
  ]);
  const gh = fakeGh({ views: { [`${HO}#23`]: { state: 'MERGED', title: 'x' } } });
  const r = await sweepStaleStatus({ gh, query: store.query, log: store.log, planList: fakePlanList() });
  assert.equal(store.written.length, 1);
  const w = store.written[0];
  assert.equal(w.repo, 'ho-nexus');
  assert.equal(w.area, 'feat/x');
  assert.equal(w.status, 'done');
  assert.equal(w.agent, SWEEP_AGENT);
  assert.match(w.message, /PR #23 merged/);
  assert.match(r.summary, /resolved 1/);
});

test('TP-status-sweep-002: cited PR still open is left alone', async () => {
  const store = fakeStore([
    { repo: 'ho-nexus', area: 'feat/y', status: 'PR-open', agent: 'implementer', message: 'PR #30 open for review' },
  ]);
  const gh = fakeGh({ views: { [`${HO}#30`]: { state: 'OPEN' } } });
  await sweepStaleStatus({ gh, query: store.query, log: store.log, planList: fakePlanList() });
  assert.equal(store.written.length, 0);
});

test('TP-status-sweep-003: PR-open with no PR citation is left alone', async () => {
  const store = fakeStore([
    { repo: 'ho-nexus', area: 'feat/z', status: 'PR-open', agent: 'implementer', message: 'branch pushed, review pending' },
  ]);
  const r = await sweepStaleStatus({ gh: fakeGh({}), query: store.query, log: store.log, planList: fakePlanList() });
  assert.equal(store.written.length, 0);
  const d = r.decisions.find((x) => x.area === 'feat/z');
  assert.equal(d?.action, 'leave');
  assert.match(d?.reason || '', /no PR citation/);
});

test('TP-status-sweep-004: gh pr view failure leaves the line (missing evidence is never finished)', async () => {
  const store = fakeStore([
    { repo: 'ho-nexus', area: 'feat/x', status: 'PR-open', agent: 'implementer', message: 'PR #23' },
  ]);
  const gh = fakeGh({ fail: [`pr view ${HO}#23`] });
  await sweepStaleStatus({ gh, query: store.query, log: store.log, planList: fakePlanList() });
  assert.equal(store.written.length, 0);
});

test('TP-status-sweep-005: pr-watch\'s own PR-open lines are never touched even when merged', async () => {
  const store = fakeStore([
    { repo: 'workspace', area: 'pr-12', status: 'PR-open', agent: 'pr-watch', message: 'PR #12 open — "bump" — https://github.com/hectorolan/workspace/pull/12' },
  ]);
  const gh = fakeGh({ views: { 'hectorolan/workspace#12': { state: 'MERGED' } } });
  const r = await sweepStaleStatus({ gh, query: store.query, log: store.log, planList: fakePlanList() });
  assert.equal(store.written.length, 0);
  assert.match(r.decisions[0]?.reason || '', /pr-watch owns/);
});

test('TP-status-sweep-006: idempotence — the second sweep writes nothing', async () => {
  const store = fakeStore([
    { repo: 'ho-nexus', area: 'feat/x', status: 'PR-open', agent: 'implementer', message: 'PR #23' },
  ]);
  const gh = fakeGh({ views: { [`${HO}#23`]: { state: 'MERGED' } } });
  await sweepStaleStatus({ gh, query: store.query, log: store.log, planList: fakePlanList() });
  assert.equal(store.written.length, 1);
  const r2 = await sweepStaleStatus({ gh, query: store.query, log: store.log, planList: fakePlanList() });
  assert.equal(store.written.length, 1); // nothing new
  assert.doesNotMatch(r2.summary, /resolved [1-9]/);
});

test('TP-status-sweep-007: an entry no longer newest in its area is silently skipped (no back-logging)', async () => {
  const store = fakeStore([
    { repo: 'ho-nexus', area: 'feat/x', status: 'PR-open', agent: 'implementer', message: 'PR #23' },
    { repo: 'ho-nexus', area: 'feat/x', status: 'done', agent: 'implementer', message: 'wrapped up by hand' },
  ]);
  const gh = fakeGh({ views: { [`${HO}#23`]: { state: 'MERGED' } } });
  const r = await sweepStaleStatus({ gh, query: store.query, log: store.log, planList: fakePlanList() });
  assert.equal(store.written.length, 0);
  assert.equal(r.decisions.length, 0); // not even a decision — nothing was dangling
});

test('TP-status-sweep-008: blocked citing a now-done test-plan resolves with one done line', async () => {
  const store = fakeStore([
    { repo: 'ho-nexus', area: 'pr-20', status: 'blocked', agent: 'pr-watch', message: 'test-plan hn-tp-skills-origin left active after PR #20 merge — needs review' },
  ]);
  const planList = fakePlanList([{ slug: 'hn-tp-skills-origin', status: 'done' }]);
  const r = await sweepStaleStatus({ gh: fakeGh({}), query: store.query, log: store.log, planList });
  assert.equal(store.written.length, 1);
  assert.equal(store.written[0].status, 'done');
  assert.equal(store.written[0].area, 'pr-20');
  assert.equal(store.written[0].agent, SWEEP_AGENT);
  assert.match(store.written[0].message, /hn-tp-skills-origin/);
  assert.match(r.summary, /resolved 1/);
});

test('TP-status-sweep-009: blocked citing a still-active plan is left alone', async () => {
  const store = fakeStore([
    { repo: 'ho-nexus', area: 'pr-21', status: 'blocked', agent: 'pr-watch', message: 'test-plan hn-tp-live left active — needs review' },
  ]);
  const planList = fakePlanList([{ slug: 'hn-tp-live', status: 'active' }]);
  await sweepStaleStatus({ gh: fakeGh({}), query: store.query, log: store.log, planList });
  assert.equal(store.written.length, 0);
});

test('TP-status-sweep-010: blocked with no slug citation is left alone', async () => {
  const store = fakeStore([
    { repo: 'ho-nexus', area: 'auth', status: 'blocked', agent: 'implementer', message: 'awaiting answers: oauth scopes' },
  ]);
  const r = await sweepStaleStatus({ gh: fakeGh({}), query: store.query, log: store.log, planList: fakePlanList() });
  assert.equal(store.written.length, 0);
  assert.match(r.decisions[0]?.reason || '', /no test-plan citation/);
});

test('TP-status-sweep-011: blocked citing an unknown slug is left alone (a mis-parse must never resolve)', async () => {
  const store = fakeStore([
    { repo: 'ho-nexus', area: 'pr-22', status: 'blocked', agent: 'pr-watch', message: 'test-plan needs another look' },
  ]);
  const planList = fakePlanList([{ slug: 'some-other-plan', status: 'done' }]);
  await sweepStaleStatus({ gh: fakeGh({}), query: store.query, log: store.log, planList });
  assert.equal(store.written.length, 0);
});

test('TP-status-sweep-012: multiple PR citations are conjunctive — one open holds, all closed resolves', async () => {
  const store = fakeStore([
    { repo: 'ho-nexus', area: 'feat/a', status: 'PR-open', agent: 'implementer', message: 'PR #21 superseded, follow-up PR #22' },
    { repo: 'ho-nexus', area: 'feat/b', status: 'PR-open', agent: 'implementer', message: 'PR #24 and PR #25 both up' },
  ]);
  const gh = fakeGh({ views: {
    [`${HO}#21`]: { state: 'MERGED' }, [`${HO}#22`]: { state: 'OPEN' },
    [`${HO}#24`]: { state: 'MERGED' }, [`${HO}#25`]: { state: 'CLOSED' },
  } });
  await sweepStaleStatus({ gh, query: store.query, log: store.log, planList: fakePlanList() });
  assert.equal(store.written.length, 1);
  assert.equal(store.written[0].area, 'feat/b');
});

test('TP-status-sweep-013: deployed-staging is always left, with an explicit deliberate reason', async () => {
  const store = fakeStore([
    { repo: 'ho-nexus', area: 'deploy', status: 'deployed-staging', agent: 'devops', message: 'staging build 1f6e718 up' },
  ]);
  const r = await sweepStaleStatus({ gh: fakeGh({}), query: store.query, log: store.log, planList: fakePlanList() });
  assert.equal(store.written.length, 0);
  const d = r.decisions[0];
  assert.equal(d?.action, 'leave');
  assert.match(d?.reason || '', /no .*signal|deliberately/i);
});

test('TP-status-sweep-014: log API query failure skips the whole sweep — zero writes', async () => {
  const store = fakeStore([]);
  const r = await sweepStaleStatus({
    gh: fakeGh({}),
    query: async () => { throw new Error('api down'); },
    log: store.log,
    planList: fakePlanList(),
  });
  assert.equal(store.written.length, 0);
  assert.match(r.summary, /skipped/);
});

test('TP-status-sweep-015: plan-list failure leaves blocked candidates; PR-open path still works', async () => {
  const store = fakeStore([
    { repo: 'ho-nexus', area: 'pr-20', status: 'blocked', agent: 'pr-watch', message: 'test-plan hn-tp-skills-origin left active' },
    { repo: 'ho-nexus', area: 'feat/x', status: 'PR-open', agent: 'implementer', message: 'PR #23' },
  ]);
  const gh = fakeGh({ views: { [`${HO}#23`]: { state: 'MERGED' } } });
  await sweepStaleStatus({
    gh, query: store.query, log: store.log,
    planList: async () => { throw new Error('plan api down'); },
  });
  assert.equal(store.written.length, 1);
  assert.equal(store.written[0].area, 'feat/x');
});

test('TP-status-sweep-016: a foreign repo\'s /pull/<n> URL is not a citation', async () => {
  const store = fakeStore([
    { repo: 'ho-nexus', area: 'feat/x', status: 'PR-open', agent: 'implementer', message: 'see https://github.com/hectorolan/workspace/pull/9' },
  ]);
  const gh = fakeGh({ views: { 'hectorolan/workspace#9': { state: 'MERGED' } } });
  const r = await sweepStaleStatus({ gh, query: store.query, log: store.log, planList: fakePlanList() });
  assert.equal(store.written.length, 0);
  assert.match(r.decisions[0]?.reason || '', /no PR citation/);
});

test('TP-status-sweep-017: closed-without-merge counts as finished and says so', async () => {
  const store = fakeStore([
    { repo: 'ho-nexus', area: 'feat/x', status: 'PR-open', agent: 'implementer', message: 'PR #23' },
  ]);
  const gh = fakeGh({ views: { [`${HO}#23`]: { state: 'CLOSED' } } });
  await sweepStaleStatus({ gh, query: store.query, log: store.log, planList: fakePlanList() });
  assert.equal(store.written.length, 1);
  assert.match(store.written[0].message, /closed without merge/);
});

test('TP-status-sweep-018: never throws even when everything fails', async () => {
  const r = await sweepStaleStatus({
    gh: () => { throw new Error('gh gone'); },
    query: async () => { throw new Error('api gone'); },
    log: async () => { throw new Error('log gone'); },
    planList: async () => { throw new Error('plans gone'); },
  });
  assert.match(r.summary, /skipped/);
});

test('TP-status-sweep-019: dry-run returns the full decision list and writes nothing', async () => {
  const store = fakeStore([
    { repo: 'ho-nexus', area: 'feat/x', status: 'PR-open', agent: 'implementer', message: 'PR #23' },
    { repo: 'ho-nexus', area: 'auth', status: 'blocked', agent: 'implementer', message: 'awaiting answers' },
  ]);
  const gh = fakeGh({ views: { [`${HO}#23`]: { state: 'MERGED' } } });
  const r = await sweepStaleStatus({ gh, query: store.query, log: store.log, planList: fakePlanList(), dryRun: true });
  assert.equal(store.written.length, 0);
  assert.equal(r.decisions.filter((d) => d.action === 'resolve').length, 1);
  assert.equal(r.decisions.filter((d) => d.action === 'leave').length, 1);
  assert.match(r.summary, /dry-run/);
});

test('TP-status-sweep-020: gh repo list failure leaves PR-open candidates; blocked path still works', async () => {
  const store = fakeStore([
    { repo: 'ho-nexus', area: 'feat/x', status: 'PR-open', agent: 'implementer', message: 'PR #23' },
    { repo: 'ho-nexus', area: 'pr-20', status: 'blocked', agent: 'pr-watch', message: 'test-plan hn-tp-skills-origin left active' },
  ]);
  const gh = fakeGh({ fail: ['repo list'], views: { [`${HO}#23`]: { state: 'MERGED' } } });
  const planList = fakePlanList([{ slug: 'hn-tp-skills-origin', status: 'archived' }]);
  await sweepStaleStatus({ gh, query: store.query, log: store.log, planList });
  assert.equal(store.written.length, 1);
  assert.equal(store.written[0].area, 'pr-20');
});
