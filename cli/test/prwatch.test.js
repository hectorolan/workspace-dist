// TP-pr-watch: sweepPRs transition detection, dedupe, dependabot tagging, and
// non-fatal degradation (see ws plan get test-plan-pr-watch).
// TP-prwatch-plan-close: test-plan auto-close on merge + follow-up flagging
// (see ws plan get test-plan-prwatch-plan-close).
// All gh + log-API + plan-API traffic is faked — no network, no real writes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sweepPRs, hasOpenFollowUps, WATCH_AGENT , resweepReleasedHolds
} from '../util/prwatch.js';

/** @typedef {{number: number, title: string, url?: string, author?: {login?: string}}} FakePR */

/**
 * Fake `gh` serving repo list / pr list (open and closed) / pr view from canned data.
 * `closed` feeds the catch-up window (`gh pr list --state closed`); rows carry a
 * `state` of MERGED or CLOSED exactly as gh reports it.
 * @param {{repos?: string[], prs?: Record<string, FakePR[]>, closed?: Record<string, Array<{number: number, title: string, url?: string, state?: string}>>, views?: Record<string, {state: string, title?: string}>, fail?: string[]}} data
 */
function fakeGh({ repos = ['hectorolan/ho-nexus', 'hectorolan/workspace'], prs = {}, closed = {}, views = {}, fail = [] }) {
  return (/** @type {string[]} */ args) => {
    const cmd = args.slice(0, 2).join(' ');
    if (fail.includes(cmd)) throw new Error(`fake gh failure: ${cmd}`);
    if (cmd === 'repo list') return JSON.stringify(repos.map((nameWithOwner) => ({ nameWithOwner })));
    if (cmd === 'pr list') {
      const nameWithOwner = args[args.indexOf('-R') + 1];
      const state = args[args.indexOf('--state') + 1];
      if (state === 'closed') {
        if (fail.includes(`pr list closed ${nameWithOwner}`)) throw new Error('fake pr list --state closed failure');
        return JSON.stringify((closed[nameWithOwner] || []).map((p) => ({ state: 'MERGED', ...p })));
      }
      if (fail.includes(`pr list ${nameWithOwner}`)) throw new Error('fake pr list failure');
      return JSON.stringify(prs[nameWithOwner] || []);
    }
    if (cmd === 'pr view') {
      const key = `${args[args.indexOf('-R') + 1]}#${args[2]}`;
      if (fail.includes(`pr view ${key}`)) throw new Error('fake pr view failure');
      return JSON.stringify(views[key] || { state: 'MERGED', title: 'unknown' });
    }
    throw new Error(`fake gh: unexpected argv ${args.join(' ')}`);
  };
}

/**
 * In-memory log store implementing the slice of the /log contract the watcher
 * uses (status filter, id order, format=json) and capturing writes.
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
      // /log orders by id DESC, applies LIMIT, then reverses — so a limit keeps
      // the NEWEST rows, returned oldest-first.
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
 * In-memory plan store implementing the slice of the plan API the watcher uses
 * (planList format=json index with exclude, planGet text body, planSet upsert).
 * @param {Array<{slug: string, repo?: string|null, kind?: string, status?: string, title?: string, body?: string}>} seed
 */
function fakePlans(seed = []) {
  const rows = seed.map((p) => ({ repo: null, kind: 'test-plan', status: 'active', title: 't', body: '', ...p }));
  /** @type {Array<Record<string, unknown>>} */
  const sets = [];
  /** @type {Array<Record<string, unknown>>} */
  const listCalls = [];
  return {
    rows,
    sets,
    listCalls,
    /** @type {typeof import('../util/apiclient.js').planList} */
    list: async (params = {}) => {
      listCalls.push(params);
      const excluded = String(params.exclude || '').split(',').map((s) => s.trim()).filter(Boolean);
      const out = rows.filter((r) => (!params.kind || r.kind === params.kind) && !excluded.includes(r.status));
      return JSON.stringify({ ok: true, count: out.length, plans: out.map(({ body, ...p }) => ({ ...p, body_length: body.length })) });
    },
    /** @type {typeof import('../util/apiclient.js').planGet} */
    get: async (slug) => {
      const r = rows.find((x) => x.slug === slug);
      if (!r) throw new Error(`plan not found: ${slug}`);
      return `# ${r.slug} | ${r.kind} | ${r.status} | 2026-07-25 | ${r.title}\n\n${r.body}\n`;
    },
    /** @type {typeof import('../util/apiclient.js').planSet} */
    set: async (slug, fields = {}) => {
      const r = rows.find((x) => x.slug === slug);
      if (!r) throw new Error(`plan not found: ${slug}`);
      Object.assign(r, fields);
      sets.push({ slug, ...fields });
      return { line: '', created: false };
    },
  };
}

const HO = 'hectorolan/ho-nexus';
const WS = 'hectorolan/workspace';

test('TP-pr-watch-001: new open PR logs one PR-open line with number/title/author', async () => {
  const store = fakeStore();
  const gh = fakeGh({ prs: { [HO]: [{ number: 5, title: 'feat: dashboard', url: 'u5', author: { login: 'hectorolan' } }] } });
  const summary = await sweepPRs({ gh, query: store.query, log: store.log, plans: fakePlans() });
  assert.equal(store.written.length, 1);
  const line = store.written[0];
  assert.equal(line.repo, 'ho-nexus');
  assert.equal(line.area, 'pr-5');
  assert.equal(line.status, 'PR-open');
  assert.equal(line.agent, WATCH_AGENT);
  assert.match(line.message, /PR #5 open — "feat: dashboard" by hectorolan/);
  assert.match(summary, /logged 1 transition\(s\): ho-nexus#5 open/);
});

test('TP-pr-watch-002: dependabot PR is tagged, human PR is not', async () => {
  const store = fakeStore();
  const gh = fakeGh({
    prs: {
      [WS]: [{ number: 9, title: 'chore(deps): bump x', url: 'u9', author: { login: 'app/dependabot' } }],
      [HO]: [{ number: 5, title: 'feat: dashboard', url: 'u5', author: { login: 'hectorolan' } }],
    },
  });
  await sweepPRs({ gh, query: store.query, log: store.log, plans: fakePlans() });
  const byArea = new Map(store.written.map((w) => [`${w.repo}/${w.area}`, w.message]));
  assert.match(byArea.get('workspace/pr-9') || '', /by app\/dependabot \[dependabot\]/);
  assert.doesNotMatch(byArea.get('ho-nexus/pr-5') || '', /\[dependabot\]/);
});

test('TP-pr-watch-003: already-logged open PR writes nothing (dedupe)', async () => {
  const store = fakeStore([
    { repo: 'ho-nexus', area: 'pr-5', status: 'PR-open', agent: WATCH_AGENT },
  ]);
  const gh = fakeGh({ prs: { [HO]: [{ number: 5, title: 't', url: 'u', author: { login: 'hectorolan' } }] } });
  const summary = await sweepPRs({ gh, query: store.query, log: store.log, plans: fakePlans() });
  assert.equal(store.written.length, 0);
  assert.match(summary, /no transitions \(1 open PR\(s\) across 2 repos\)/);
});

test('TP-pr-watch-004: merged PR closes out with one done line', async () => {
  const store = fakeStore([
    { repo: 'ho-nexus', area: 'pr-5', status: 'PR-open', agent: WATCH_AGENT },
  ]);
  const gh = fakeGh({ prs: {}, views: { [`${HO}#5`]: { state: 'MERGED', title: 'feat: dashboard' } } });
  const summary = await sweepPRs({ gh, query: store.query, log: store.log, plans: fakePlans() });
  assert.equal(store.written.length, 1);
  assert.equal(store.written[0].status, 'done');
  assert.equal(store.written[0].area, 'pr-5');
  assert.match(store.written[0].message, /PR #5 merged — "feat: dashboard"/);
  assert.match(summary, /ho-nexus#5 merged/);
});

test('TP-pr-watch-005: closed-without-merge wording', async () => {
  const store = fakeStore([
    { repo: 'ho-nexus', area: 'pr-6', status: 'PR-open', agent: WATCH_AGENT },
  ]);
  const gh = fakeGh({ prs: {}, views: { [`${HO}#6`]: { state: 'CLOSED', title: 'wip' } } });
  await sweepPRs({ gh, query: store.query, log: store.log, plans: fakePlans() });
  assert.equal(store.written.length, 1);
  assert.match(store.written[0].message, /PR #6 closed without merge — "wip"/);
});

test('TP-pr-watch-006: already-closed-out PR stays silent on later sweeps', async () => {
  const store = fakeStore([
    { repo: 'ho-nexus', area: 'pr-5', status: 'PR-open', agent: WATCH_AGENT },
    { repo: 'ho-nexus', area: 'pr-5', status: 'done', agent: WATCH_AGENT },
  ]);
  const gh = fakeGh({ prs: {} });
  const summary = await sweepPRs({ gh, query: store.query, log: store.log, plans: fakePlans() });
  assert.equal(store.written.length, 0);
  assert.match(summary, /no transitions/);
});

test('TP-pr-watch-007: reopened PR (done newest, open again on GitHub) re-logs PR-open', async () => {
  const store = fakeStore([
    { repo: 'ho-nexus', area: 'pr-5', status: 'PR-open', agent: WATCH_AGENT },
    { repo: 'ho-nexus', area: 'pr-5', status: 'done', agent: WATCH_AGENT },
  ]);
  const gh = fakeGh({ prs: { [HO]: [{ number: 5, title: 't', url: 'u', author: { login: 'hectorolan' } }] } });
  await sweepPRs({ gh, query: store.query, log: store.log, plans: fakePlans() });
  assert.equal(store.written.length, 1);
  assert.equal(store.written[0].status, 'PR-open');
});

test('TP-pr-watch-008: gh repo list failure skips the sweep, zero writes, no throw', async () => {
  const store = fakeStore();
  const gh = fakeGh({ fail: ['repo list'] });
  const summary = await sweepPRs({ gh, query: store.query, log: store.log, plans: fakePlans() });
  assert.match(summary, /skipped \(gh repo list failed/);
  assert.equal(store.written.length, 0);
});

test('TP-pr-watch-009: gh pr list failure for one repo skips the whole sweep (no false closures)', async () => {
  const store = fakeStore([
    { repo: 'ho-nexus', area: 'pr-5', status: 'PR-open', agent: WATCH_AGENT },
  ]);
  const gh = fakeGh({ prs: { [WS]: [] }, fail: [`pr list ${HO}`] });
  const summary = await sweepPRs({ gh, query: store.query, log: store.log, plans: fakePlans() });
  assert.match(summary, /skipped \(gh pr list failed/);
  assert.equal(store.written.length, 0);
});

test('TP-pr-watch-010: log API query failure skips the sweep, zero writes', async () => {
  const store = fakeStore();
  const gh = fakeGh({ prs: {} });
  const summary = await sweepPRs({
    gh,
    query: async () => { throw new Error('ECONNREFUSED'); },
    log: store.log,
    plans: fakePlans(),
  });
  assert.match(summary, /skipped \(log API query failed\)/);
  assert.equal(store.written.length, 0);
});

test('TP-pr-watch-011: manual agent lines (branch areas / foreign agents) are ignored', async () => {
  const store = fakeStore([
    { repo: 'ho-nexus', area: 'feat/conversations-viewer', status: 'PR-open', agent: 'implementer' },
    { repo: 'ho-nexus', area: 'pr-4', status: 'PR-open', agent: 'implementer' },
  ]);
  const gh = fakeGh({ prs: {} });
  const summary = await sweepPRs({ gh, query: store.query, log: store.log, plans: fakePlans() });
  // Neither line belongs to the watcher → no closure is inferred from them.
  assert.equal(store.written.length, 0);
  assert.match(summary, /no transitions/);
});

test('TP-pr-watch-012: gh pr view reporting OPEN (listing race) defers the closure', async () => {
  const store = fakeStore([
    { repo: 'ho-nexus', area: 'pr-5', status: 'PR-open', agent: WATCH_AGENT },
  ]);
  const gh = fakeGh({ prs: {}, views: { [`${HO}#5`]: { state: 'OPEN' } } });
  const summary = await sweepPRs({ gh, query: store.query, log: store.log, plans: fakePlans() });
  assert.equal(store.written.length, 0);
  assert.match(summary, /no transitions/);
});

test('TP-pr-watch-013: watched PR in a repo no longer listed is closed out gracefully', async () => {
  const store = fakeStore([
    { repo: 'archived-repo', area: 'pr-2', status: 'PR-open', agent: WATCH_AGENT },
  ]);
  const gh = fakeGh({ prs: {} }); // gh repo list --no-archived drops it
  const summary = await sweepPRs({ gh, query: store.query, log: store.log, plans: fakePlans() });
  assert.equal(store.written.length, 1);
  assert.equal(store.written[0].status, 'done');
  assert.match(store.written[0].message, /repo no longer listed/);
  assert.match(summary, /archived-repo#2 closed/);
});

test('TP-pr-watch-014: sweepPRs never throws even when everything fails', async () => {
  const boom = () => { throw new Error('boom'); };
  const summary = await sweepPRs({
    gh: boom,
    query: async () => { throw new Error('boom'); },
    log: async () => { throw new Error('boom'); },
    plans: fakePlans(),
  });
  assert.equal(typeof summary, 'string');
  assert.match(summary, /skipped/);
});

// ---- TP-prwatch-plan-close: test-plan auto-close on merge ----

/** Store + gh where ho-nexus PR #7 was watched open and is now merged. */
function mergedPR7() {
  const store = fakeStore([
    { repo: 'ho-nexus', area: 'pr-7', status: 'PR-open', agent: WATCH_AGENT },
  ]);
  const gh = fakeGh({ prs: {}, views: { [`${HO}#7`]: { state: 'MERGED', title: 'feat: comments' } } });
  return { store, gh };
}

test('TP-prwatch-plan-close-001: merged PR closes the matching active test-plan and logs one audit line', async () => {
  const { store, gh } = mergedPR7();
  const plans = fakePlans([
    { slug: 'hn-test-plan-page-comments', repo: 'ho-nexus', body: 'Covers PR #7 end to end.' },
  ]);
  const summary = await sweepPRs({ gh, query: store.query, log: store.log, plans });
  assert.deepEqual(plans.sets, [{ slug: 'hn-test-plan-page-comments', status: 'done', agent: WATCH_AGENT }]);
  const closes = store.written.filter((w) => /test-plan hn-test-plan-page-comments closed/.test(w.message || ''));
  assert.equal(closes.length, 1);
  assert.equal(closes[0].status, 'done');
  assert.equal(closes[0].area, 'pr-7');
  assert.equal(closes[0].agent, WATCH_AGENT);
  assert.match(summary, /test-plan hn-test-plan-page-comments closed/);
});

test('TP-prwatch-plan-close-002: unchecked checkbox blocks the close — one blocked flag line, no planSet', async () => {
  const { store, gh } = mergedPR7();
  const plans = fakePlans([
    { slug: 'hn-test-plan-page-comments', repo: 'ho-nexus', body: 'Covers PR #7.\n\n- [x] shipped\n- [ ] live e2e still pending' },
  ]);
  const summary = await sweepPRs({ gh, query: store.query, log: store.log, plans });
  assert.equal(plans.sets.length, 0);
  const flags = store.written.filter((w) => w.status === 'blocked');
  assert.equal(flags.length, 1);
  assert.equal(flags[0].area, 'pr-7');
  assert.equal(flags[0].agent, WATCH_AGENT);
  assert.match(flags[0].message, /test-plan hn-test-plan-page-comments left active after PR #7 merge — open follow-ups/);
  assert.match(summary, /flagged \(open follow-ups\)/);
});

test('TP-prwatch-plan-close-003: a Follow-ups/Pending heading with content blocks the close', async () => {
  const { store, gh } = mergedPR7();
  const plans = fakePlans([
    { slug: 'hn-test-plan-page-comments', repo: 'ho-nexus', body: 'Covers PR #7.\n\n## Follow-ups\n\nVerify the live e2e once Hector comments.' },
  ]);
  await sweepPRs({ gh, query: store.query, log: store.log, plans });
  assert.equal(plans.sets.length, 0);
  assert.equal(store.written.filter((w) => w.status === 'blocked').length, 1);
});

test('TP-prwatch-plan-close-004: an EMPTY Follow-ups heading does not block the close', async () => {
  const { store, gh } = mergedPR7();
  const plans = fakePlans([
    { slug: 'hn-test-plan-page-comments', repo: 'ho-nexus', body: 'Covers PR #7.\n\n## Follow-ups\n\n\n## Cases\n\n- TP-x-001 done' },
  ]);
  await sweepPRs({ gh, query: store.query, log: store.log, plans });
  assert.equal(plans.sets.length, 1);
  assert.equal(store.written.filter((w) => w.status === 'blocked').length, 0);
});

test('TP-prwatch-plan-close-005: closed-without-merge touches no plans (log only)', async () => {
  const store = fakeStore([
    { repo: 'ho-nexus', area: 'pr-7', status: 'PR-open', agent: WATCH_AGENT },
  ]);
  const gh = fakeGh({ prs: {}, views: { [`${HO}#7`]: { state: 'CLOSED', title: 'wip' } } });
  const plans = fakePlans([
    { slug: 'hn-test-plan-page-comments', repo: 'ho-nexus', body: 'Covers PR #7.' },
  ]);
  await sweepPRs({ gh, query: store.query, log: store.log, plans });
  assert.equal(plans.listCalls.length, 0);
  assert.equal(plans.sets.length, 0);
  assert.equal(store.written.length, 1);
  assert.match(store.written[0].message, /closed without merge/);
});

test('TP-prwatch-plan-close-006: slug pr-<n> segment matches without any body mention', async () => {
  const { store, gh } = mergedPR7();
  const plans = fakePlans([
    { slug: 'hn-test-plan-pr-7-comments', repo: 'ho-nexus', body: 'No numeric reference in prose.' },
  ]);
  await sweepPRs({ gh, query: store.query, log: store.log, plans });
  assert.equal(plans.sets.length, 1);
  assert.equal(plans.sets[0].slug, 'hn-test-plan-pr-7-comments');
});

test('TP-prwatch-plan-close-007: same PR number in another repo\'s plan is untouched (null repo folds to workspace)', async () => {
  const { store, gh } = mergedPR7();
  const plans = fakePlans([
    { slug: 'test-plan-ws-thing', repo: null, body: 'Covers PR #7 of the workspace.' },
    { slug: 'test-plan-ws-explicit', repo: 'workspace', body: 'Also PR #7.' },
  ]);
  await sweepPRs({ gh, query: store.query, log: store.log, plans });
  assert.equal(plans.sets.length, 0);
  assert.equal(store.written.filter((w) => w.status === 'blocked').length, 0);
});

test('TP-prwatch-plan-close-008: candidates come from kind=test-plan exclude=done,archived format=json', async () => {
  const { store, gh } = mergedPR7();
  const plans = fakePlans([
    { slug: 'hn-test-plan-old', repo: 'ho-nexus', status: 'done', body: 'PR #7' },
    { slug: 'hn-test-plan-gone', repo: 'ho-nexus', status: 'archived', body: 'PR #7' },
  ]);
  await sweepPRs({ gh, query: store.query, log: store.log, plans });
  assert.equal(plans.listCalls.length, 1);
  assert.deepEqual(plans.listCalls[0], { kind: 'test-plan', exclude: 'done,archived', format: 'json' });
  assert.equal(plans.sets.length, 0); // done/archived are never candidates
});

test('TP-prwatch-plan-close-009 + TP-obs48b-001: plan list failure logs ONE failed line — PR done line still logged', async () => {
  const { store, gh } = mergedPR7();
  const plans = fakePlans();
  plans.list = async () => { throw new Error('ECONNREFUSED'); };
  const summary = await sweepPRs({ gh, query: store.query, log: store.log, plans });
  // The merge marks the PR seen, so this sweep never retries: without a line the
  // stranded plan would look identical to a missed one (backlog 48b).
  assert.equal(store.written.length, 2);
  assert.equal(store.written[0].status, 'done');
  assert.match(store.written[0].message, /PR #7 merged/);
  const fails = store.written.filter((w) => w.status === 'failed');
  assert.equal(fails.length, 1);
  assert.equal(fails[0].area, 'pr-7');
  assert.equal(fails[0].agent, WATCH_AGENT);
  assert.match(fails[0].message, /test-plan sweep for merged PR #7 could not run \(plan API list failed\)/);
  assert.match(summary, /test-plan sweep skipped for pr-7/);
});

test('TP-prwatch-plan-close-010: repo-scoped PR URL matches; a foreign repo\'s /pull/<n> URL does not', async () => {
  const { store, gh } = mergedPR7();
  const plans = fakePlans([
    { slug: 'hn-test-plan-url', repo: 'ho-nexus', body: 'See https://github.com/hectorolan/ho-nexus/pull/7 for scope.' },
    { slug: 'hn-test-plan-foreign-url', repo: 'ho-nexus', body: 'Context: https://github.com/hectorolan/other-repo/pull/7 only.' },
  ]);
  await sweepPRs({ gh, query: store.query, log: store.log, plans });
  assert.deepEqual(plans.sets.map((s) => s.slug), ['hn-test-plan-url']);
});

test('TP-prwatch-plan-close-011: two matching plans both close, one audit line each', async () => {
  const { store, gh } = mergedPR7();
  const plans = fakePlans([
    { slug: 'hn-test-plan-a', repo: 'ho-nexus', body: 'PR #7 part one.' },
    { slug: 'hn-test-plan-b', repo: 'ho-nexus', body: 'PR#7 part two.' },
  ]);
  await sweepPRs({ gh, query: store.query, log: store.log, plans });
  assert.deepEqual(plans.sets.map((s) => s.slug).sort(), ['hn-test-plan-a', 'hn-test-plan-b']);
  assert.equal(store.written.filter((w) => /test-plan hn-test-plan-[ab] closed/.test(w.message || '')).length, 2);
});

test('TP-prwatch-plan-close-012: planGet failure for one candidate skips it, others still close', async () => {
  const { store, gh } = mergedPR7();
  const plans = fakePlans([
    { slug: 'hn-test-plan-a', repo: 'ho-nexus', body: 'PR #7 part one.' },
    { slug: 'hn-test-plan-b', repo: 'ho-nexus', body: 'PR #7 part two.' },
  ]);
  const realGet = plans.get;
  plans.get = async (slug) => {
    if (slug === 'hn-test-plan-a') throw new Error('boom');
    return realGet(slug);
  };
  const summary = await sweepPRs({ gh, query: store.query, log: store.log, plans });
  assert.deepEqual(plans.sets.map((s) => s.slug), ['hn-test-plan-b']);
  assert.match(summary, /hn-test-plan-a skipped/);
});

test('TP-prwatch-plan-close-014: hasOpenFollowUps truth table', () => {
  assert.equal(hasOpenFollowUps('- [ ] pending item'), true);
  assert.equal(hasOpenFollowUps('  * [ ] starred pending'), true);
  assert.equal(hasOpenFollowUps('- [x] done item\n- [X] also done'), false);
  assert.equal(hasOpenFollowUps('## Follow-ups\ncontent here'), true);
  assert.equal(hasOpenFollowUps('### Follow ups\ncontent'), true);
  assert.equal(hasOpenFollowUps('## Followup\nsomething left'), true);
  assert.equal(hasOpenFollowUps('## PENDING\nitems remain'), true);
  assert.equal(hasOpenFollowUps('## Pending items\nstill open'), true);
  assert.equal(hasOpenFollowUps('## Follow-ups\n\n## Next\nunrelated'), false); // window ends at next heading
  assert.equal(hasOpenFollowUps('plain body, no markers'), false);
  assert.equal(hasOpenFollowUps('prose mentioning follow-ups inline, not a heading'), false);
});

// ---- TP-prwatch-manual-hold: unperformed manual/deferred test cases hold the
// plan open (see ws plan get test-plan-prwatch-manual-case-hold). Fixture units
// are lifted VERBATIM from the real DB plan bodies studied on 2026-07-25.

test('TP-prwatch-manual-hold-001: unexecuted manual table rows hold (real held-plan rows)', () => {
  // hn-test-plan-2026-07-23-plans-page TP-plans-page-014
  assert.equal(hasOpenFollowUps(
    '| TP-plans-page-014 | Production smoke after deploy: real login → index lists the migrated plans (income-pipeline, mobile-nexus, …) → detail renders one; then `ws plan set` an update and reload to see it immediately | manual — needs the merged deploy plus the workspace-side `/plan` endpoints live on the VM |'
  ), true);
  // hn-test-plan-2026-07-17-conversations-viewer TP-conversations-viewer-012
  assert.equal(hasOpenFollowUps(
    '| TP-conversations-viewer-012 | Production smoke after deploy: real login → list shows backfilled history → thread renders a real exchange | manual — needs the merged deploy, VM env vars, and the one-time backfill |'
  ), true);
  // hn-test-plan-2026-07-22-agents-skills-pages TP-agents-skills-016/017
  assert.equal(hasOpenFollowUps(
    '| TP-agents-skills-016 | Production smoke after deploy: real login → Agents/Skills/Knowledge pages show the live workspace files via the `workspace_sources` volume | manual — needs the merged deploy + `WORKSPACE_CLAUDE_DIR` set on the VM |\n'
    + '| TP-agents-skills-017 | Mobile layout: sections readable on a narrow viewport (shared responsive shell) | manual — visual check; the shell\'s media query is shared with existing sections |'
  ), true);
});

test('TP-prwatch-manual-hold-002: (manual, deferred) bullet with wrapped continuation holds', () => {
  // hn-test-plan-2026-07-24-plans-repo-filter TP-plans-repo-filter-011
  assert.equal(hasOpenFollowUps(
    '- TP-plans-repo-filter-011 (manual, deferred): live visual check on the Azure VM behind\n'
    + '  Google auth after devops deploys — deferred (requires OAuth browser session; smoke only).'
  ), true);
});

test('TP-prwatch-manual-hold-003: deferred-to-Hector holds ("to be performed" is not evidence); executed manual alone closes', () => {
  // hn-test-plan-2026-07-16-digest-viewer TP-digest-viewer-015 — the reason the plan is held
  const tp015 = '- **TP-digest-viewer-015** (deferred — requires Hector\'s browser/Google account) — Full live\n'
    + '  OAuth round-trip: real Google consent, callback, session established, digest list shown.\n'
    + '  Reason: Testing-mode consent requires the owner\'s own account; cannot be automated here.\n'
    + '  To be performed by Hector on first local run / after deploy.';
  assert.equal(hasOpenFollowUps(tp015), true);
  // TP-digest-viewer-017 alone (manual but verified) must NOT hold
  assert.equal(hasOpenFollowUps(
    '- **TP-digest-viewer-017** (manual — verified below) — `docker compose up` serves on\n'
    + '  `localhost:8080`, real digests from the mounted workspace dir render, and an\n'
    + '  unauthenticated curl is redirected toward Google sign-in.'
  ), false);
});

test('TP-prwatch-manual-hold-004: "checked once by Hector on merge" is execution evidence (real closed row)', () => {
  // hn-test-plan-2026-07-23-page-comments TP-page-comments-016 — closed by today's sweep
  assert.equal(hasOpenFollowUps(
    '| TP-page-comments-016 | Modal interaction: submit pre-fills the modal with the typed text, cancel closes without any network call, only confirm sends, modal edits are what get sent, and on failure the (edited) text is still in the main textarea | manual — browser-JS behavior; the suite has no headless browser (checked once by Hector on merge; the script is static inline JS asserted present by 001) |'
  ), false);
});

test('TP-prwatch-manual-hold-005: "verified via" in the coverage cell is evidence (real closed row)', () => {
  // hn-test-plan-2026-07-24-digests-db TP-digests-db-013 — closed by today's sweep
  assert.equal(hasOpenFollowUps(
    '| TP-digests-db-013 | Production compose points at the VM log API and the page shows the latest digest | manual (devops smoke at deploy; PC/local verified via `npm start` against the live API) |'
  ), false);
});

test('TP-prwatch-manual-hold-006: executed manual case + system-event deferred case both close (prwatch plan body shape)', () => {
  // test-plan-prwatch-plan-close TP-015 (Executed record) and TP-016 (deferred to the
  // next organic merge, no human actor) — this plan must still auto-close.
  assert.equal(hasOpenFollowUps(
    '- TP-prwatch-plan-close-015 (manual, backfill): run the one-shot backfill; verify with\n'
    + '  `ws query --repo ho-nexus` that the 9 stale areas each gained a `done` transition.\n'
    + '  Manual because it mutates the live central DB exactly once by design.\n'
    + '  **Executed 2026-07-25**: all 9 PRs verified MERGED via `gh pr view`, 9 `done`\n'
    + '  lines written, and the summary\'s ho-nexus attention list is empty.\n'
    + '- TP-prwatch-plan-close-016 (deferred): live end-to-end (real merge observed by a real\n'
    + '  `ws pull` tick closing a real test-plan) — deferred to the next organic PR merge;\n'
    + '  the fake-store contract mirrors the live API shapes used.'
  ), false);
});

test('TP-prwatch-manual-hold-007: "covered by the … automated suite" is delegation evidence (real closed bullet)', () => {
  // hn-test-plan-2026-07-24-remove-digests-dir TP-remove-digests-dir-004 — closed today
  assert.equal(hasOpenFollowUps(
    '- TP-remove-digests-dir-004 (manual/deferred): `docker compose up --build` serves digests\n'
    + '  from the DB with no digests bind-mount. Deferred — Docker Desktop may be off; covered by the\n'
    + '  DB-stub automated suite and reviewed by devops at deploy. Prod compose mount removed by\n'
    + '  devops on next deploy (safe: container no longer reads those files).'
  ), false);
});

test('TP-prwatch-manual-hold-008: marker must LEAD the coverage cell; unexecuted manual smoke still holds', () => {
  // hn-test-plan-2026-07-24-audit-remediation TP-011: cell starts "automated" — the
  // trailing "manual per TP-page-comments-016" cross-reference must not flag it.
  assert.equal(hasOpenFollowUps(
    '| TP-audit-remediation-011 | Comment-box script disables Send/Confirm while the fetch is in flight and re-enables on success and on failure | automated (source-level assertions on the partial, same approach as TP-page-comments-001); interactive behavior manual per TP-page-comments-016 |'
  ), false);
  // TP-013: genuinely unexecuted manual smoke → held (conservative by design; devops
  // closed the live plan by judgment — see the test plan, assumption 1).
  assert.equal(hasOpenFollowUps(
    '| TP-audit-remediation-013 | Production smoke after deploy: open a real digest/conversation and confirm no rendering regressions | manual — needs the merged deploy |'
  ), true);
});

test('TP-prwatch-manual-hold-009: prose and headings mentioning "manual" never hold', () => {
  // Real prose + heading from hn-test-plan-2026-07-16-digest-viewer
  assert.equal(hasOpenFollowUps(
    'Automated tests use a temp fixture digests directory. Manual verification uses the real\n'
    + 'mounted `../workspace/reports/digests`.\n\n'
    + '## Manual verification record (TP-digest-viewer-017)\n\n'
    + 'Performed 2026-07-16 on the Windows PC.'
  ), false);
});

test('TP-prwatch-manual-hold-010: merged PR with an unperformed manual case → blocked flag, no close', async () => {
  const { store, gh } = mergedPR7();
  const plans = fakePlans([
    {
      slug: 'hn-test-plan-smoke',
      repo: 'ho-nexus',
      body: 'Covers PR #7.\n\n| TP-smoke-001 | Production smoke after deploy | manual — needs the merged deploy |',
    },
  ]);
  const summary = await sweepPRs({ gh, query: store.query, log: store.log, plans });
  assert.equal(plans.sets.length, 0);
  const flags = store.written.filter((w) => w.status === 'blocked');
  assert.equal(flags.length, 1);
  assert.match(flags[0].message, /left active after PR #7 merge — open follow-ups/);
  assert.match(summary, /flagged \(open follow-ups\)/);
});

test('TP-prwatch-manual-hold-011: merged PR whose manual case is recorded executed closes normally', async () => {
  const { store, gh } = mergedPR7();
  const plans = fakePlans([
    {
      slug: 'hn-test-plan-smoked',
      repo: 'ho-nexus',
      body: 'Covers PR #7.\n\n| TP-smoked-001 | Production smoke | manual — verified 2026-07-25 on the VM |',
    },
  ]);
  await sweepPRs({ gh, query: store.query, log: store.log, plans });
  assert.deepEqual(plans.sets, [{ slug: 'hn-test-plan-smoked', status: 'done', agent: WATCH_AGENT }]);
  assert.equal(store.written.filter((w) => w.status === 'blocked').length, 0);
});

test('TP-pr-watch-003/006 combined: a full open→merge lifecycle logs exactly two lines over four sweeps', async () => {
  const store = fakeStore();
  const withPR = fakeGh({ prs: { [HO]: [{ number: 7, title: 't7', url: 'u7', author: { login: 'hectorolan' } }] } });
  const withoutPR = fakeGh({ prs: {}, views: { [`${HO}#7`]: { state: 'MERGED', title: 't7' } } });
  await sweepPRs({ gh: withPR, query: store.query, log: store.log, plans: fakePlans() });   // opens
  await sweepPRs({ gh: withPR, query: store.query, log: store.log, plans: fakePlans() });   // dedupe
  await sweepPRs({ gh: withoutPR, query: store.query, log: store.log, plans: fakePlans() }); // merges
  await sweepPRs({ gh: withoutPR, query: store.query, log: store.log, plans: fakePlans() }); // silent
  assert.deepEqual(store.written.map((w) => w.status), ['PR-open', 'done']);
});

// ---- TP-jest-edge-prw: failure-edge expansion (skills-integration Phase 1b,
// jest-skill methodology on node:test — see ws plan get
// test-plan-jest-skill-edge-coverage). Every case asserts behavior prwatch.js
// actually implements: degradation to a summary string, never a throw.

test('TP-jest-edge-prw-001: malformed gh repo list JSON skips the sweep, zero writes', async () => {
  const store = fakeStore();
  const gh = (/** @type {string[]} */ args) => {
    if (args.slice(0, 2).join(' ') === 'repo list') return '<!DOCTYPE html><title>502</title>';
    throw new Error('unexpected');
  };
  const summary = await sweepPRs({ gh, query: store.query, log: store.log, plans: fakePlans() });
  assert.match(summary, /skipped \(gh repo list failed/);
  assert.equal(store.written.length, 0);
});

test('TP-jest-edge-prw-002: malformed gh pr list JSON for one repo skips the whole sweep', async () => {
  const store = fakeStore([
    { repo: 'ho-nexus', area: 'pr-5', status: 'PR-open', agent: WATCH_AGENT },
  ]);
  const base = fakeGh({ prs: { [WS]: [] } });
  const gh = (/** @type {string[]} */ args) => {
    if (args.slice(0, 2).join(' ') === 'pr list' && args.includes(HO)) return '{"truncated":';
    return base(args);
  };
  const summary = await sweepPRs({ gh, query: store.query, log: store.log, plans: fakePlans() });
  assert.match(summary, /skipped \(gh pr list failed/);
  assert.equal(store.written.length, 0, 'partial data must not fake a closure of pr-5');
});

test('TP-jest-edge-prw-003: malformed log API query response skips the sweep', async () => {
  const store = fakeStore();
  const gh = fakeGh({ prs: {} });
  const summary = await sweepPRs({
    gh,
    query: async () => 'Bad Gateway',
    log: store.log,
    plans: fakePlans(),
  });
  assert.match(summary, /skipped \(log API query failed\)/);
  assert.equal(store.written.length, 0);
});

test('TP-jest-edge-prw-004: log API response without entries (incomplete) skips the sweep', async () => {
  const store = fakeStore();
  const gh = fakeGh({ prs: {} });
  const summary = await sweepPRs({
    gh,
    query: async () => JSON.stringify({ ok: true }),
    log: store.log,
    plans: fakePlans(),
  });
  assert.match(summary, /skipped \(log API query failed\)/);
  assert.equal(store.written.length, 0);
});

test('TP-jest-edge-prw-005: PR rows missing author/login log as "unknown", never dependabot-tagged', async () => {
  const store = fakeStore();
  const gh = fakeGh({
    prs: {
      [HO]: [{ number: 5, title: 'no author field', url: 'u5' }],
      [WS]: [{ number: 9, title: 'author without login', url: 'u9', author: {} }],
    },
  });
  await sweepPRs({ gh, query: store.query, log: store.log, plans: fakePlans() });
  assert.equal(store.written.length, 2);
  for (const line of store.written) {
    assert.match(line.message || '', /by unknown/);
    assert.doesNotMatch(line.message || '', /\[dependabot\]/);
  }
});

test('TP-jest-edge-prw-006: gh pr view failure degrades to a generic "final state unknown" closure', async () => {
  const store = fakeStore([
    { repo: 'ho-nexus', area: 'pr-5', status: 'PR-open', agent: WATCH_AGENT },
  ]);
  const gh = fakeGh({ prs: {}, fail: [`pr view ${HO}#5`] });
  const summary = await sweepPRs({ gh, query: store.query, log: store.log, plans: fakePlans() });
  assert.equal(store.written.length, 1);
  assert.equal(store.written[0].status, 'done');
  assert.match(store.written[0].message, /PR #5 closed — final state unknown \(gh pr view failed\)/);
  assert.match(summary, /ho-nexus#5 closed/, 'unknown outcome is labeled closed, not merged');
});

test('TP-jest-edge-prw-007: malformed gh pr view JSON takes the same generic-closure path', async () => {
  const store = fakeStore([
    { repo: 'ho-nexus', area: 'pr-5', status: 'PR-open', agent: WATCH_AGENT },
  ]);
  const base = fakeGh({ prs: {} });
  const gh = (/** @type {string[]} */ args) => {
    if (args.slice(0, 2).join(' ') === 'pr view') return 'HTTP 500: Internal Server Error';
    return base(args);
  };
  await sweepPRs({ gh, query: store.query, log: store.log, plans: fakePlans() });
  assert.equal(store.written.length, 1);
  assert.match(store.written[0].message, /final state unknown \(gh pr view failed\)/);
});

test('TP-jest-edge-prw-008: log write failure mid-sweep reports "interrupted after 1 transition(s)"', async () => {
  const store = fakeStore();
  let writes = 0;
  /** @type {typeof store.log} */
  const flakyLog = async (entry) => {
    if (++writes > 1) throw new Error('ECONNRESET');
    return store.log(entry);
  };
  const gh = fakeGh({
    prs: {
      [HO]: [{ number: 5, title: 'a', url: 'u5', author: { login: 'hectorolan' } }],
      [WS]: [{ number: 9, title: 'b', url: 'u9', author: { login: 'hectorolan' } }],
    },
  });
  const summary = await sweepPRs({ gh, query: store.query, log: flakyLog, plans: fakePlans() });
  assert.match(summary, /interrupted after 1 transition\(s\): ho-nexus#5 open/);
  assert.equal(store.written.length, 1, 'the write that landed before the failure is kept');
});

test('TP-jest-edge-prw-009 + TP-obs48b-002: planSet failure logs ONE failed line naming the slug, no close audit line', async () => {
  const { store, gh } = mergedPR7();
  const plans = fakePlans([
    { slug: 'hn-test-plan-page-comments', repo: 'ho-nexus', body: 'Covers PR #7.' },
  ]);
  plans.set = async () => { throw new Error('ECONNREFUSED'); };
  const summary = await sweepPRs({ gh, query: store.query, log: store.log, plans });
  assert.match(summary, /test-plan hn-test-plan-page-comments close FAILED \(plan API set failed\)/);
  assert.equal(store.written.length, 2, 'PR closure line + the stranded-plan failed line (backlog 48b)');
  assert.match(store.written[0].message, /PR #7 merged/);
  const fails = store.written.filter((w) => w.status === 'failed');
  assert.equal(fails.length, 1);
  assert.equal(fails[0].area, 'pr-7');
  assert.equal(fails[0].agent, WATCH_AGENT);
  assert.match(fails[0].message, /test-plan hn-test-plan-page-comments close FAILED .* left active after PR #7 merge/);
  assert.equal(store.written.filter((w) => /test-plan .* closed/.test(w.message || '')).length, 0);
});

test('TP-jest-edge-prw-010: watcher-state queries pass the explicit window (limit 500, format json, status filter)', async () => {
  /** @type {Array<Record<string, unknown>>} */
  const calls = [];
  /** @type {typeof import('../util/apiclient.js').query} */
  const query = async ({ params = {} }) => {
    calls.push(params);
    return JSON.stringify({ ok: true, entries: [] });
  };
  const gh = fakeGh({ prs: {} });
  await sweepPRs({ gh, query, log: fakeStore().log, plans: fakePlans() });
  assert.deepEqual(calls, [
    { status: 'PR-open', limit: 500, format: 'json' },
    { status: 'done', limit: 500, format: 'json' },
  ]);
});

test('TP-jest-edge-prw-011: empty repo list yields a zero-repos summary and never calls pr list', async () => {
  const store = fakeStore();
  /** @type {string[]} */
  const cmds = [];
  const base = fakeGh({ repos: [], prs: {} });
  const gh = (/** @type {string[]} */ args) => {
    cmds.push(args.slice(0, 2).join(' '));
    return base(args);
  };
  const summary = await sweepPRs({ gh, query: store.query, log: store.log, plans: fakePlans() });
  assert.match(summary, /no transitions \(0 open PR\(s\) across 0 repos\)/);
  assert.deepEqual(cmds, ['repo list']);
  assert.equal(store.written.length, 0);
});

// --- TP-prwatch-catchup: PRs that open and close between two sweeps ---------
// Live regression 2026-07-26: ho-nexus PR #16 was created 08:07:18Z and merged
// 08:09:55Z — 2m37s, entirely between the container's 08:07:00 and 08:22:00 ticks.
// The watcher never logged it open, so knownOpen-based closure could never fire:
// no merge line, no test-plan close. These cover the catch-up reconciliation.

/** The exact shape of the PR #16 miss: implementer PR-open line + active test plan. */
const pr16Seed = () => fakeStore([
  { repo: 'ho-nexus', area: 'feat/skill-upstream-source', status: 'PR-open', agent: 'implementer',
    message: 'Skills page shows GitHub source for external skills, PR #16, test plan hn-tp-16' },
]);
const pr16Closed = { [HO]: [{ number: 16, title: 'feat(skills): upstream source', state: 'MERGED', url: 'u16' }] };

test('TP-prwatch-catchup-001: PR merged between sweeps is reconciled — pr-N done line, foreign area resolved, plan closed', async () => {
  const store = pr16Seed();
  const plans = fakePlans([{ slug: 'hn-tp-16', repo: 'ho-nexus', body: 'Covers PR #16. All cases verified.' }]);
  const gh = fakeGh({ prs: {}, closed: pr16Closed });
  const summary = await sweepPRs({ gh, query: store.query, log: store.log, plans });

  const pr = store.written.find((w) => w.area === 'pr-16');
  assert.ok(pr, 'expected a pr-16 transition line');
  assert.equal(pr.status, 'done');
  assert.equal(pr.agent, WATCH_AGENT);
  assert.match(pr.message, /PR #16 merged/);
  assert.match(pr.message, /never saw it open/);
  // the implementer's dangling PR-open area is closed out too
  const area = store.written.find((w) => w.area === 'feat/skill-upstream-source');
  assert.ok(area, 'expected the foreign PR-open area to be resolved');
  assert.equal(area.status, 'done');
  // and the linked test plan is closed by the script, never by an agent
  assert.deepEqual(plans.sets, [{ slug: 'hn-tp-16', status: 'done', agent: WATCH_AGENT }]);
  assert.match(summary, /ho-nexus#16 merged \(catch-up\)/);
});

test('TP-prwatch-catchup-002: reconciliation runs exactly once — the second sweep is silent', async () => {
  const store = pr16Seed();
  const plans = fakePlans([{ slug: 'hn-tp-16', repo: 'ho-nexus', body: 'Covers PR #16. Verified.' }]);
  const gh = fakeGh({ prs: {}, closed: pr16Closed });
  await sweepPRs({ gh, query: store.query, log: store.log, plans });
  const afterFirst = store.written.length;
  assert.ok(afterFirst > 0);
  const summary = await sweepPRs({ gh, query: store.query, log: store.log, plans });
  assert.equal(store.written.length, afterFirst, 'second sweep must write nothing');
  assert.match(summary, /no transitions/);
});

test('TP-prwatch-catchup-003: closed PR with nothing dangling is left alone (no back-logging of history)', async () => {
  const store = fakeStore();
  const gh = fakeGh({ prs: {}, closed: pr16Closed });
  const summary = await sweepPRs({ gh, query: store.query, log: store.log, plans: fakePlans() });
  assert.equal(store.written.length, 0);
  assert.match(summary, /no transitions/);
});

test('TP-prwatch-catchup-004: a PR the watcher already handled is never reconciled again', async () => {
  const store = fakeStore([
    { repo: 'ho-nexus', area: 'pr-16', status: 'PR-open', agent: WATCH_AGENT, message: 'PR #16 open' },
    { repo: 'ho-nexus', area: 'pr-16', status: 'done', agent: WATCH_AGENT, message: 'PR #16 merged' },
    { repo: 'ho-nexus', area: 'feat/x', status: 'PR-open', agent: 'implementer', message: 'work, PR #16' },
  ]);
  const gh = fakeGh({ prs: {}, closed: pr16Closed });
  const summary = await sweepPRs({ gh, query: store.query, log: store.log, plans: fakePlans() });
  assert.equal(store.written.length, 0);
  assert.match(summary, /no transitions/);
});

test('TP-prwatch-catchup-005: a resolved foreign area does not re-trigger reconciliation', async () => {
  // implementer opened, then something already logged a later line in that area
  const store = fakeStore([
    { repo: 'ho-nexus', area: 'feat/x', status: 'PR-open', agent: 'implementer', message: 'work, PR #16' },
    { repo: 'ho-nexus', area: 'feat/x', status: 'done', agent: 'implementer', message: 'landed' },
  ]);
  const gh = fakeGh({ prs: {}, closed: pr16Closed });
  const summary = await sweepPRs({ gh, query: store.query, log: store.log, plans: fakePlans() });
  assert.equal(store.written.length, 0);
  assert.match(summary, /no transitions/);
});

test('TP-prwatch-catchup-006: closed-without-merge is reconciled but never closes a test plan', async () => {
  const store = pr16Seed();
  const plans = fakePlans([{ slug: 'hn-tp-16', repo: 'ho-nexus', body: 'Covers PR #16. Verified.' }]);
  const gh = fakeGh({ prs: {}, closed: { [HO]: [{ number: 16, title: 'wip', state: 'CLOSED', url: 'u' }] } });
  await sweepPRs({ gh, query: store.query, log: store.log, plans });
  const pr = store.written.find((w) => w.area === 'pr-16');
  assert.ok(pr);
  assert.match(pr.message, /closed without merge/);
  assert.deepEqual(plans.sets, [], 'closed-without-merge must not touch plans');
});

test('TP-prwatch-catchup-007: a merged PR with only a test plan (no log line) still closes the plan', async () => {
  const store = fakeStore();
  const plans = fakePlans([{ slug: 'hn-tp-16', repo: 'ho-nexus', body: 'Covers PR #16. Verified.' }]);
  const gh = fakeGh({ prs: {}, closed: pr16Closed });
  await sweepPRs({ gh, query: store.query, log: store.log, plans });
  assert.deepEqual(plans.sets, [{ slug: 'hn-tp-16', status: 'done', agent: WATCH_AGENT }]);
});

test('TP-prwatch-catchup-008: open follow-ups keep the plan active and flag it blocked', async () => {
  const store = pr16Seed();
  const plans = fakePlans([{ slug: 'hn-tp-16', repo: 'ho-nexus', body: 'Covers PR #16.\n\n- [ ] manual smoke' }]);
  const gh = fakeGh({ prs: {}, closed: pr16Closed });
  await sweepPRs({ gh, query: store.query, log: store.log, plans });
  assert.deepEqual(plans.sets, [], 'plan with open follow-ups must stay active');
  assert.ok(store.written.some((w) => w.status === 'blocked' && /left active/.test(w.message)));
});

test('TP-prwatch-catchup-009: a cross-repo PR citation never resolves another repo\'s area', async () => {
  const store = fakeStore([
    { repo: 'workspace', area: 'feat/y', status: 'PR-open', agent: 'implementer',
      message: 'see https://github.com/hectorolan/ho-nexus/pull/16 for context' },
  ]);
  const gh = fakeGh({ prs: {}, closed: pr16Closed });
  await sweepPRs({ gh, query: store.query, log: store.log, plans: fakePlans() });
  assert.equal(store.written.length, 0, 'a workspace area must not be closed by an ho-nexus PR');
});

test('TP-prwatch-catchup-010: gh pr list --state closed failure skips the whole sweep (fail closed)', async () => {
  const store = pr16Seed();
  const gh = fakeGh({ prs: {}, fail: [`pr list closed ${HO}`] });
  const summary = await sweepPRs({ gh, query: store.query, log: store.log, plans: fakePlans() });
  assert.match(summary, /skipped \(gh pr list --state closed failed/);
  assert.equal(store.written.length, 0);
});

test('TP-prwatch-catchup-011: plan API list failure defers catch-up instead of half-reconciling', async () => {
  const store = pr16Seed();
  const plans = fakePlans();
  plans.list = async () => { throw new Error('plan API down'); };
  const gh = fakeGh({ prs: {}, closed: pr16Closed });
  const summary = await sweepPRs({ gh, query: store.query, log: store.log, plans });
  assert.match(summary, /catch-up deferred \(plan API list failed\)/);
  assert.equal(store.written.length, 0, 'nothing may be written on a deferred catch-up');
});

test('TP-prwatch-catchup-012: a PR still open is not reconciled even if it appears in the closed window', async () => {
  const store = fakeStore();
  const gh = fakeGh({
    prs: { [HO]: [{ number: 16, title: 'feat', url: 'u16', author: { login: 'hectorolan' } }] },
    closed: pr16Closed, // stale/racing listing
  });
  await sweepPRs({ gh, query: store.query, log: store.log, plans: fakePlans() });
  const lines = store.written.filter((w) => w.area === 'pr-16');
  assert.equal(lines.length, 1, 'exactly one line: the PR-open transition');
  assert.equal(lines[0].status, 'PR-open');
});

test('TP-plan-integrity-021: the plan closed but its audit write threw — loud, durable, and the sweep still finishes', async () => {
  // backlog 42: planSet had already set the plan done, the PR was already "seen",
  // and a failed log() left no line and no retry — a closed plan indistinguishable
  // from a healthy one. The write is now never silent, and never aborts the sweep.
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-prwatch-audit-'));
  const prev = process.env.WS_DATA_DIR;
  process.env.WS_DATA_DIR = dataDir;
  const realErr = console.error;
  /** @type {string[]} */
  const errs = [];
  console.error = (/** @type {any[]} */ ...a) => { errs.push(a.join(' ')); };
  try {
    const { store, gh } = mergedPR7();
    const plans = fakePlans([
      { slug: 'hn-test-plan-page-comments', repo: 'ho-nexus', body: 'Covers PR #7 end to end.' },
    ]);
    /** @type {typeof store.log} */
    const log = async (entry) => {
      if (/test-plan .* closed/.test(entry.message || '')) throw new Error('ECONNRESET');
      return store.log(entry);
    };
    const summary = await sweepPRs({ gh, query: store.query, log, plans });
    // The merge transition still landed and the sweep ran to completion.
    assert.doesNotMatch(summary, /interrupted/);
    assert.match(summary, /ho-nexus#7 merged/);
    assert.deepEqual(plans.sets, [{ slug: 'hn-test-plan-page-comments', status: 'done', agent: WATCH_AGENT }]);
    assert.ok(errs.some((l) => /AUDIT WRITE FAILED/.test(l) && /hn-test-plan-page-comments/.test(l)), errs.join('\n'));
    const sink = path.join(dataDir, 'fallback', 'audit-failures.md');
    assert.match(fs.readFileSync(sink, 'utf8'), /\| pr-7 \| done \| test-plan hn-test-plan-page-comments closed/);
  } finally {
    console.error = realErr;
    if (prev === undefined) delete process.env.WS_DATA_DIR; else process.env.WS_DATA_DIR = prev;
  }
});


test('TP-prwatch-plan-close-017: a deferred case that was WAITING ON A JUDGEMENT closes by being answered', () => {
  // Found live 2026-08-01: two cases parked on "awaiting CEO answer" were answered
  // (both NO, with the reasoning recorded) and the plan still would not close,
  // because no doing-word in EVIDENCE_WORDS described what had happened. A
  // judgement IS the completion for a case that had nothing to perform.
  const head = [
    '# T',
    '',
    '| ID | Case | Coverage |',
    '|---|---|---|',
  ];
  /** @param {string} row */
  const plan = (row) => [...head, row, ''].join('\n');

  const answered = plan(
    '| TP-x-001 | collapse bodies on mobile? | manual — **answered NO 2026-08-01** by the CEO, reasoning recorded |');
  assert.equal(hasOpenFollowUps(answered), false, 'a DATE-STAMPED answer closes it');
  assert.equal(hasOpenFollowUps(answered.replace('answered NO', 'decided AGAINST')), false, 'a date-stamped decision closes it too');

  // …but a case still WAITING on a judgement must keep holding. The last three
  // rows are the audit-H1 repro shapes (2026-08-01): bare past tense and
  // conditional perfects read as evidence when answered|decided sat in
  // EVIDENCE_WORDS, silently closing open cases — the worst an UNPERFORMED
  // manual case. A judgement now counts only with an ISO date, and pending
  // phrasings are stripped first so a deadline date cannot sneak one through.
  for (const row of [
    '| TP-x-001 | collapse bodies? | manual — deferred, awaiting the CEO |',
    '| TP-x-001 | collapse bodies? | manual — to be decided by the CEO |',
    '| TP-x-001 | collapse bodies? | manual — will be answered on the PR |',
    '| TP-x-001 | pricing? | deferred — the CEO decided to postpone until Phase 7 |',
    '| TP-x-001 | pricing? | deferred until the CEO has decided on the pricing model |',
    '| TP-x-001 | licensing? | manual — to be performed once the CEO has answered the licensing question |',
    '| TP-x-001 | pricing? | deferred — will be decided by the CEO by 2026-08-15 |',
    '| TP-x-001 | pricing? | deferred — the CEO answered NO (reasoning in backlog 12) |',
  ]) {
    assert.equal(hasOpenFollowUps(plan(row)), true, `still open: ${row}`);
  }
});

test('TP-prwatch-plan-close-018: a plan HELD at merge closes on a later sweep once its hold is released', async () => {
  // Found live 2026-08-01, the day the machinery shipped: closeTestPlans runs on the
  // merge TRANSITION, so a plan holding follow-ups then gets a `blocked` line and is
  // never revisited. When the CEO later performs the manual case the hold releases —
  // and nothing is left to close the plan. Two plans reached that state.
  const merged = [{ number: 7, title: "t", url: "u", state: "MERGED", repo: "ho-nexus", nameWithOwner: "o/ho-nexus" }];
  const released = [
    '# T',
    '| ID | Case | Coverage |',
    '|---|---|---|',
    '| TP-x-001 | eyeball it | manual — performed 2026-08-01, evidence recorded |',
    'Closes PR #7.',
  ].join('\n');

  /** @type {any[]} */
  const sets = [];
  /** @type {any} */
  const plans = {
    list: async () => JSON.stringify({ ok: true, plans: [{ slug: 'p-held', repo: 'ho-nexus' }] }),
    get: async () => released,
    set: async (/** @type {string} */ slug, /** @type {any} */ fields) => { sets.push({ slug, fields }); },
  };
  /** @type {any[]} */
  const lines = [];
  /** @type {any} */
  const log = async (/** @type {any} */ l) => { lines.push(l); };

  // The merge-time blocked line is the anchor the re-sweep now requires (019).
  /** @type {any} */
  const query = async () => JSON.stringify({ entries: [{ id: 1, repo: 'ho-nexus', area: 'pr-7', status: 'blocked', agent: 'pr-watch', message: 'test-plan p-held left active after PR #7 merge' }] });
  const notes = await resweepReleasedHolds({ closed: new Map(merged.map((p) => [`${p.repo}#${p.number}`, p])), plans, log, query });
  assert.deepEqual(sets.map((s) => s.fields.status), ['done'], 'the released plan closes');
  assert.match(notes.join(' '), /released hold/);
  assert.equal(lines[0].status, 'done');

  // …and a plan STILL held is left exactly where it is — the gate is unchanged.
  const stillHeld = released.replace('performed 2026-08-01, evidence recorded', 'awaiting the CEO');
  /** @type {any[]} */
  const sets2 = [];
  /** @type {any} */
  const plans2 = { ...plans, get: async () => stillHeld, set: async (/** @type {string} */ s, /** @type {any} */ f) => { sets2.push({ s, f }); } };
  await resweepReleasedHolds({ closed: new Map(merged.map((p) => [`${p.repo}#${p.number}`, p])), plans: plans2, log, query });
  assert.equal(sets2.length, 0, 'a genuine hold is never swept');
});

test('TP-prwatch-plan-close-019: the release re-sweep closes ONLY plans the merge actually flagged held', async () => {
  // Reproduced live 2026-08-02: a brand-new plan whose body said "Builds on
  // PR #33" (CONTEXT, not ownership) matched merged #33 and was closed while
  // its own PR was still open. The anchor: closeTestPlans writes a `blocked`
  // line (area pr-<n>, agent pr-watch, slug in the message) for every plan it
  // holds at merge — the re-sweep now requires that proof before closing.
  const merged = new Map([["ho-nexus#33", { number: 33, title: "t", url: "u", state: "MERGED", repo: "ho-nexus", nameWithOwner: "o/ho-nexus" }]]);
  const released = [
    '# T',
    '| ID | Case | Coverage |',
    '|---|---|---|',
    '| TP-x-001 | checked 2026-08-02 | automated |',
    'Builds on PR #33 (context citation).',
  ].join('\n');
  /** @type {any[]} */
  const sets = [];
  /** @type {any} */
  const plans = {
    list: async () => JSON.stringify({ ok: true, plans: [{ slug: 'p-new', repo: 'ho-nexus' }] }),
    get: async () => released,
    set: async (/** @type {string} */ slug, /** @type {any} */ f) => { sets.push({ slug, f }); },
  };
  /** @type {any} */
  const log = async () => {};

  // No blocked line for p-new at pr-33 -> the context citation must NOT close it.
  /** @type {any} */
  const queryNoFlag = async () => JSON.stringify({ entries: [] });
  const notes1 = await resweepReleasedHolds({ closed: merged, plans, log, query: queryNoFlag });
  assert.equal(sets.length, 0, 'context citation never closes');
  assert.match(notes1.join(' '), /never flagged held/);

  // WITH the merge-time blocked line naming the slug -> it closes.
  /** @type {any} */
  const queryFlagged = async () => JSON.stringify({ entries: [{ id: 1, repo: 'ho-nexus', area: 'pr-33', status: 'blocked', agent: 'pr-watch', message: 'test-plan p-new left active after PR #33 merge' }] });
  const notes2 = await resweepReleasedHolds({ closed: merged, plans, log, query: queryFlagged });
  assert.deepEqual(sets.map((s) => s.f.status), ['done']);
  assert.match(notes2.join(' '), /released hold/);

  // Evidence-fetch failure -> left alone (never close on doubt).
  sets.length = 0;
  /** @type {any} */
  const queryDown = async () => { throw new Error('log API down'); };
  const notes3 = await resweepReleasedHolds({ closed: merged, plans, log, query: queryDown });
  assert.equal(sets.length, 0);
  assert.match(notes3.join(' '), /left alone/);
});

// --- case-ID suffix grammar (duplicate resolution, plan test-plan-case-id-suffix) ---

test('TP-caseid-007: a manual case with a suffixed ID is held and NAMED by its full suffixed ID', async () => {
  const { unperformedCases } = await import('../util/prwatch.js');
  const { authoredAsks, ceoAsks } = await import('../util/planclose.js');
  const body = `# Test plan - suffixed manual

## Needs the CEO

- TP-demo-005_2 — eyeball the second claimant's page once on the live VM.

## Cases

| ID | Case | Coverage |
|---|---|---|
| TP-demo-005 | first claimant | automated |
| TP-demo-005_2 | second claimant, live check | manual (needs the CEO) |
`;
  const held = unperformedCases(body);
  assert.deepEqual(held.map((u) => u.id), ['TP-demo-005_2']);
  assert.equal(authoredAsks(body).has('TP-demo-005_2'), true);
  assert.match(ceoAsks(body)[0], /TP-demo-005_2/);
});

test('TP-prwatch-plan-close-020: a missed merge-close recovers via the PR-open OWNERSHIP declaration', async () => {
  // 2026-08-02, hours after the blocked-line anchor landed: three plans whose
  // merge-time close silently missed (citations unrecognized at the consumed
  // transition) were stranded — no blocked line exists for a close that never
  // flagged. The implementer convention logs "… PR #<n>, test plan <slug>" at
  // PR-open: a prior ownership declaration body prose cannot fake.
  const merged = new Map([["ho-nexus#37", { number: 37, title: "t", url: "u", state: "MERGED", repo: "ho-nexus", nameWithOwner: "o/ho-nexus" }]]);
  const body = [
    '# T',
    '| ID | Case | Coverage |',
    '|---|---|---|',
    '| TP-x-001 | checked 2026-08-02 | automated |',
    'Replicates the pattern from PR #34.',  // context citation to ANOTHER merged PR
  ].join('\n');
  /** @type {any[]} */
  const sets = [];
  /** @type {any} */
  const plans = {
    list: async () => JSON.stringify({ ok: true, plans: [{ slug: 'p-n3', repo: 'ho-nexus' }] }),
    get: async () => body,
    set: async (/** @type {string} */ slug, /** @type {any} */ f) => { sets.push({ slug, f }); },
  };
  /** @type {any} */
  const log = async () => {};

  // Ownership declared for #37 -> closes even with no blocked line.
  /** @type {any} */
  const query = async (/** @type {any} */ { params }) => {
    if (params.status === 'blocked') return JSON.stringify({ entries: [] });
    if (params.status === 'PR-open') return JSON.stringify({ entries: [
      { id: 9, repo: 'ho-nexus', area: 'feat/n3', status: 'PR-open', agent: 'implementer', message: 'threads N3 … PR #37, test plan p-n3' },
    ] });
    return JSON.stringify({ entries: [] });
  };
  const withBody = { ...plans, get: async () => body };
  const bodyOwned = body + '\nCloses PR #37.';  // the plan must reference #37 to be a candidate at all
  /** @type {any} */
  const plansOwned = { ...plans, get: async () => bodyOwned };
  const notes = await resweepReleasedHolds({ closed: merged, plans: plansOwned, log, query });
  assert.deepEqual(sets.map((s) => s.f.status), ['done'], 'ownership recovers the missed close');

  // Without the ownership line (and no blocked line), a context citation still never closes.
  sets.length = 0;
  /** @type {any} */
  const queryNone = async () => JSON.stringify({ entries: [] });
  const notes2 = await resweepReleasedHolds({ closed: merged, plans: plansOwned, log, query: queryNone });
  assert.equal(sets.length, 0);
  assert.match(notes2.join(' '), /never flagged held nor declared its owner/);
});
