'use strict';

// Plans API suite. Absorbs the EJS-era plans / plans-six-kinds / plans-repo-filter
// suites (their TP IDs are kept on the corresponding cases): same filter and
// normalization semantics, JSON surface (central-DB test plan
// hn-test-plan-2026-07-26-react-refactor + predecessors).

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const request = require('supertest');
const { makeApp } = require('./helpers');

const API_KEY = 'stub-api-key';

// Deliberately NOT sorted newest-first: the app must sort by updated_at desc itself.
const PLANS = [
  { slug: 'p-legacy', title: 'Legacy row', status: 'active', repo: null, updated_at: '2026-07-18T10:00:00Z', body_length: 10 },
  { slug: 'p-active', title: 'Active plan', status: 'active', kind: 'plan', repo: null, updated_at: '2026-07-23T10:00:00Z', body_length: 10 },
  { slug: 'p-test-plan', title: 'A hub test plan', status: 'active', kind: 'test-plan', repo: 'hub', updated_at: '2026-07-21T10:00:00Z', body_length: 10 },
  { slug: 'p-draft', title: 'Draft design', status: 'draft', kind: 'design', repo: null, updated_at: '2026-07-22T10:00:00Z', body_length: 10 },
  { slug: 'p-done', title: 'Done plan', status: 'done', kind: 'plan', repo: null, updated_at: '2026-07-20T10:00:00Z', body_length: 10 },
  { slug: 'p-archived', title: 'Archived audit', status: 'archived', kind: 'audit', repo: 'hub', updated_at: '2026-07-19T10:00:00Z', body_length: 10 },
];

const BODIES = Object.fromEntries(PLANS.map((p) => [p.slug, { ...p, body: `# ${p.title}\n\nBody with **bold**.\n` }]));

/**
 * Stub log API: GET /plan (?status= / ?exclude=) + GET /plan/:slug. `envelope`
 * lets TP-plans-page-012 exercise the tolerated list keys; `honorExclude:false`
 * simulates a pre-?exclude= API for the app-side backstop case.
 */
function startStubApi({ plans = PLANS, bodies = BODIES, envelope = 'entries', honorExclude = true, bareDetail = false } = {}) {
  const seen = [];
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    seen.push({ method: req.method, path: u.pathname, query: Object.fromEntries(u.searchParams), key: req.headers['x-api-key'] });
    res.setHeader('Content-Type', 'application/json');
    const m = u.pathname.match(/^\/plan\/([^/]+)$/);
    if (m) {
      const p = bodies[decodeURIComponent(m[1])];
      if (!p) { res.statusCode = 404; return res.end(JSON.stringify({ ok: false, error: 'not found' })); }
      return res.end(JSON.stringify(bareDetail ? p : { ok: true, plan: p }));
    }
    if (u.pathname === '/plan') {
      let rows = plans;
      const s = u.searchParams.get('status');
      const exclude = (u.searchParams.get('exclude') || '').split(',').filter(Boolean);
      if (s) rows = rows.filter((p) => p.status === s);
      else if (honorExclude && exclude.length) rows = rows.filter((p) => !exclude.includes(p.status));
      return res.end(JSON.stringify({ ok: true, count: rows.length, [envelope]: rows }));
    }
    res.statusCode = 404;
    res.end(JSON.stringify({ ok: false }));
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ url: `http://127.0.0.1:${server.address().port}`, seen, close: () => server.close() }));
  });
}

const appFor = (stubUrl, overrides = {}) =>
  makeApp({ authBypass: true, logApiUrl: stubUrl, logApiKey: API_KEY, ...overrides });

const slugs = (body) => body.plans.map((p) => p.slug);

test('TP-plans-page-001 / TP-plan-exclude-001: default list hides done/archived, sorted newest updated first', async () => {
  const stub = await startStubApi();
  try {
    const res = await request(appFor(stub.url)).get('/api/plans');
    assert.equal(res.status, 200);
    assert.deepEqual(slugs(res.body), ['p-active', 'p-draft', 'p-test-plan', 'p-legacy'], 'sorted by updated_at desc');
    const listCall = stub.seen.find((r) => r.path === '/plan');
    assert.equal(listCall.query.exclude, 'done,archived', 'exclude also sent server-side');
  } finally {
    stub.close();
  }
});

test('TP-plan-exclude-002: app-side backstop holds even when the API ignores ?exclude=', async () => {
  const stub = await startStubApi({ honorExclude: false });
  try {
    const res = await request(appFor(stub.url)).get('/api/plans');
    assert.equal(res.status, 200);
    assert.ok(!slugs(res.body).includes('p-done'), 'done hidden app-side');
    assert.ok(!slugs(res.body).includes('p-archived'), 'archived hidden app-side');
  } finally {
    stub.close();
  }
});

test('TP-plans-page-002: explicit ?status= overrides the default exclude (done/archived reachable)', async () => {
  const stub = await startStubApi();
  try {
    const done = await request(appFor(stub.url)).get('/api/plans?status=done');
    assert.deepEqual(slugs(done.body), ['p-done']);
    assert.equal(done.body.status, 'done', 'the applied filter is echoed for the UI');
    const archived = await request(appFor(stub.url)).get('/api/plans?status=archived');
    assert.deepEqual(slugs(archived.body), ['p-archived']);
  } finally {
    stub.close();
  }
});

test('TP-plans-page-003: unknown ?status= is ignored (injection guard)', async () => {
  const stub = await startStubApi();
  try {
    const res = await request(appFor(stub.url)).get('/api/plans?status=%2Fetc%2Fpasswd');
    assert.equal(res.status, 200);
    assert.equal(res.body.status, '', 'unknown status falls back to the default view');
    assert.deepEqual(slugs(res.body), ['p-active', 'p-draft', 'p-test-plan', 'p-legacy']);
  } finally {
    stub.close();
  }
});

test('TP-audit-remediation-008 / TP-plans-six-kinds: ?kind= filters app-side; unknown ignored; combines with status; missing kind normalizes to plan', async () => {
  const stub = await startStubApi();
  try {
    const app = appFor(stub.url);
    const design = await request(app).get('/api/plans?kind=design');
    assert.deepEqual(slugs(design.body), ['p-draft']);
    const unknown = await request(app).get('/api/plans?kind=%2Fetc%2Fpasswd');
    assert.deepEqual(slugs(unknown.body), ['p-active', 'p-draft', 'p-test-plan', 'p-legacy'], 'unknown kind ignored');
    // kind=plan includes rows without the field (legacy normalization) and combines with status.
    const plans = await request(app).get('/api/plans?status=active&kind=plan');
    assert.deepEqual(slugs(plans.body), ['p-active', 'p-legacy']);
    const legacy = plans.body.plans.find((p) => p.slug === 'p-legacy');
    assert.equal(legacy.kind, 'plan', 'missing kind must normalize to plan');
    // The six plan kinds + the conversation view ride along for the filter UI
    // (document-threads N2 added the `conversation` chip; the `history` kind
    // retired 2026-08-02 — archived rows keep their real kind instead;
    // `baseline` joined the roster with the Documents subtabs).
    assert.deepEqual(plans.body.kinds, ['plan', 'audit', 'design', 'test-plan', 'doc', 'baseline', 'conversation']);
  } finally {
    stub.close();
  }
});

test('TP-hist-rm-001: ?kind=history is no longer recognized — ignored like any unknown kind', async () => {
  const stub = await startStubApi();
  try {
    const res = await request(appFor(stub.url)).get('/api/plans?kind=history');
    assert.equal(res.status, 200);
    assert.equal(res.body.kind, '', 'retired kind falls back to the default view');
    assert.deepEqual(slugs(res.body), ['p-active', 'p-draft', 'p-test-plan', 'p-legacy']);
  } finally {
    stub.close();
  }
});

test('TP-hist-rm-002: archived rows carry their REAL kind — the archived audit stays an audit', async () => {
  const stub = await startStubApi();
  try {
    const res = await request(appFor(stub.url)).get('/api/plans?status=archived');
    assert.equal(res.status, 200);
    const archived = res.body.plans.find((p) => p.slug === 'p-archived');
    assert.equal(archived.kind, 'audit', 'archiving must never obscure the original kind');
  } finally {
    stub.close();
  }
});

test('TP-plans-repo-filter-001..006: repo options derived from rows; ?repo= filters; unknown repo ignored; null folds to workspace', async () => {
  const stub = await startStubApi();
  try {
    const app = appFor(stub.url);
    const all = await request(app).get('/api/plans');
    assert.deepEqual(all.body.repos, ['workspace', 'hub'], 'workspace first, others alphabetical');
    const hubRepo = await request(app).get('/api/plans?repo=hub');
    assert.deepEqual(slugs(hubRepo.body), ['p-test-plan']);
    assert.equal(hubRepo.body.repo, 'hub');
    const workspace = await request(app).get('/api/plans?repo=workspace');
    assert.deepEqual(slugs(workspace.body), ['p-active', 'p-draft', 'p-legacy'], 'null repo folds to workspace');
    const unknown = await request(app).get('/api/plans?repo=%2Fetc%2Fpasswd');
    assert.equal(unknown.body.repo, '', 'unknown repo ignored (injection guard)');
    assert.deepEqual(slugs(unknown.body), ['p-active', 'p-draft', 'p-test-plan', 'p-legacy']);
  } finally {
    stub.close();
  }
});

test('TP-plans-page-004: detail returns meta + sanitized html; raw body stays server-side', async () => {
  const stub = await startStubApi();
  try {
    const res = await request(appFor(stub.url)).get('/api/plans/p-active');
    assert.equal(res.status, 200);
    const p = res.body.plan;
    assert.equal(p.slug, 'p-active');
    assert.equal(p.title, 'Active plan');
    assert.equal(p.status, 'active');
    assert.equal(p.kind, 'plan');
    assert.equal(p.repo, 'workspace');
    assert.match(p.html, /<strong>bold<\/strong>/);
    assert.ok(!('body' in p), 'raw markdown never ships to the browser');
  } finally {
    stub.close();
  }
});

test('TP-plans-page-011: bare-row detail envelope tolerated', async () => {
  const stub = await startStubApi({ bareDetail: true });
  try {
    const res = await request(appFor(stub.url)).get('/api/plans/p-active');
    assert.equal(res.status, 200);
    assert.equal(res.body.plan.slug, 'p-active');
  } finally {
    stub.close();
  }
});

test('TP-plans-page-005: unknown slug → 404 JSON', async () => {
  const stub = await startStubApi();
  try {
    const res = await request(appFor(stub.url)).get('/api/plans/no-such-plan');
    assert.equal(res.status, 404);
    assert.equal(res.body.ok, false);
    assert.match(res.body.error, /not found/i);
  } finally {
    stub.close();
  }
});

test('TP-plans-page-006: path-shaped slug rejected before any API call', async () => {
  const stub = await startStubApi();
  try {
    const res = await request(appFor(stub.url)).get('/api/plans/..%2F..%2Fetc');
    assert.equal(res.status, 404);
    assert.equal(stub.seen.length, 0, 'slug guard must reject before any log API request');
  } finally {
    stub.close();
  }
});

test('TP-plans-page-007: log API down → 502; unset LOG_API_URL → 503', async () => {
  const stub = await startStubApi();
  stub.close();
  const down = await request(appFor(stub.url)).get('/api/plans');
  assert.equal(down.status, 502);
  const unconfigured = await request(makeApp({ authBypass: true, logApiUrl: '' })).get('/api/plans');
  assert.equal(unconfigured.status, 503);
  assert.match(unconfigured.body.error, /not configured/i);
});

test('TP-plans-page-012: list envelope tolerance — `plans` and `rows` keys accepted', async () => {
  for (const envelope of ['plans', 'rows']) {
    const stub = await startStubApi({ envelope });
    try {
      const res = await request(appFor(stub.url)).get('/api/plans');
      assert.equal(res.status, 200);
      assert.ok(res.body.plans.length > 0, `envelope key "${envelope}" tolerated`);
    } finally {
      stub.close();
    }
  }
});

test('TP-plans-page-013: every plan API call carries X-Api-Key; the key never appears in a response', async () => {
  const stub = await startStubApi();
  try {
    const app = appFor(stub.url);
    const list = await request(app).get('/api/plans');
    const detail = await request(app).get('/api/plans/p-active');
    for (const r of stub.seen) assert.equal(r.key, API_KEY);
    for (const res of [list, detail]) assert.ok(!res.text.includes(API_KEY));
  } finally {
    stub.close();
  }
});

// ---- Documents subtab views (hn-documents-subtabs-2026-08-15) ---------------
// Display-layer grouping only: the workspace /plan API sees plain fetches, the
// stored kinds/statuses are untouched. Extra rows exercise the partition:
// a HELD test-plan (body opens with the pinned CEO blockquote), a closed one,
// a baseline record, and a kind the app has never heard of (the catch-all).

const VIEW_PLANS = [
  ...PLANS,
  { slug: 'p-held-test', title: 'Held test plan', status: 'active', kind: 'test-plan', repo: null, updated_at: '2026-07-10T10:00:00Z', body_length: 40 },
  { slug: 'p-closed-test', title: 'Closed test plan', status: 'done', kind: 'test-plan', repo: 'hub', updated_at: '2026-07-24T10:00:00Z', body_length: 10 },
  { slug: 'p-baseline', title: 'Workspace baseline', status: 'active', kind: 'baseline', repo: null, updated_at: '2026-07-25T10:00:00Z', body_length: 10 },
  { slug: 'p-mystery', title: 'Future-kind record', status: 'active', kind: 'memo', repo: null, updated_at: '2026-07-09T10:00:00Z', body_length: 10 },
];

const VIEW_BODIES = {
  ...Object.fromEntries(VIEW_PLANS.map((p) => [p.slug, { ...p, body: `# ${p.title}\n\nBody.\n` }])),
  // plan-close pins the CEO block as a blockquote at the very top of the body.
  'p-held-test': {
    ...VIEW_PLANS.find((p) => p.slug === 'p-held-test'),
    body: '> **Needs the CEO**\n> - TP-x-013 — flip the DNS switch\n\n# Held test plan\n\nCases.\n',
  },
};

const viewStub = (opts = {}) => startStubApi({ plans: VIEW_PLANS, bodies: VIEW_BODIES, ...opts });

// @plan:hn-documents-subtabs-2026-08-15 @promote
test('TP-docsub-010: view=tests splits open/closed, flags the held plan and sorts it first', async () => {
  const stub = await viewStub();
  try {
    const res = await request(appFor(stub.url)).get('/api/plans?view=tests');
    assert.equal(res.status, 200);
    assert.equal(res.body.view, 'tests');
    // Open: held first despite being the older row; activity order otherwise.
    assert.deepEqual(slugs(res.body), ['p-held-test', 'p-test-plan']);
    assert.equal(res.body.plans[0].needsCeo, true, 'blockquote-topped body = pinned CEO block');
    assert.ok(!('needsCeo' in res.body.plans[1]), 'unheld rows carry no flag');
    // Closed: done/archived test-plans only, never mixed into the open list.
    assert.deepEqual(res.body.closed.map((p) => p.slug), ['p-closed-test']);
    // The upstream fetch must NOT carry the default exclude (closed rows are needed).
    const listCall = stub.seen.find((r) => r.path === '/plan');
    assert.equal(listCall.query.exclude, undefined, 'view fetches all statuses');
  } finally {
    stub.close();
  }
});

// @plan:hn-documents-subtabs-2026-08-15 @promote
test('TP-docsub-010_2: a failed body check degrades to no held flag — never a 500', async () => {
  // Bodies map without the held row: its detail fetch 404s, the flag is dropped.
  const { 'p-held-test': _gone, ...bodies } = VIEW_BODIES;
  const stub = await startStubApi({ plans: VIEW_PLANS, bodies });
  try {
    const res = await request(appFor(stub.url)).get('/api/plans?view=tests');
    assert.equal(res.status, 200);
    assert.ok(res.body.plans.every((p) => !p.needsCeo), 'no flag without a readable body');
    // Still listed — the check is a decoration, not a gate.
    assert.ok(slugs(res.body).includes('p-held-test'));
  } finally {
    stub.close();
  }
});

// @plan:hn-documents-subtabs-2026-08-15 @promote
test('TP-docsub-011_2 / TP-docsub-013: view=records merges the non-plan kinds, done visible, archived only with ?archived=1', async () => {
  const stub = await viewStub();
  try {
    const app = appFor(stub.url);
    const def = await request(app).get('/api/plans?view=records');
    assert.equal(def.status, 200);
    assert.equal(def.body.view, 'records');
    // design + baseline + the unknown kind (catch-all); plan/test-plan never;
    // the archived audit hidden by default. Newest activity first.
    assert.deepEqual(slugs(def.body), ['p-baseline', 'p-draft', 'p-mystery']);
    assert.equal(def.body.archived, false);
    assert.deepEqual(def.body.kinds, ['design', 'baseline', 'memo'], 'chip roster derived from rows, preferred order first');
    // The toggle: the archived audit joins, wearing its REAL kind (TP-hist-rm lineage).
    const arch = await request(app).get('/api/plans?view=records&archived=1');
    assert.deepEqual(slugs(arch.body), ['p-baseline', 'p-draft', 'p-archived', 'p-mystery']);
    assert.equal(arch.body.archived, true);
    assert.equal(arch.body.plans.find((p) => p.slug === 'p-archived').kind, 'audit');
    assert.ok(arch.body.kinds.includes('audit'));
  } finally {
    stub.close();
  }
});

// @plan:hn-documents-subtabs-2026-08-15 @promote
test('TP-docsub-014: view=records ?kind= narrows (validated), catch-all kinds reachable, ?repo= composes', async () => {
  const stub = await viewStub();
  try {
    const app = appFor(stub.url);
    const audit = await request(app).get('/api/plans?view=records&archived=1&kind=audit');
    assert.deepEqual(slugs(audit.body), ['p-archived']);
    assert.equal(audit.body.kind, 'audit');
    // A kind the app never declared still narrows — records is the catch-all.
    const memo = await request(app).get('/api/plans?view=records&kind=memo');
    assert.deepEqual(slugs(memo.body), ['p-mystery']);
    // Unknown/injection values fall back to the merged view.
    const unknown = await request(app).get('/api/plans?view=records&kind=%2Fetc%2Fpasswd');
    assert.equal(unknown.body.kind, '');
    assert.deepEqual(slugs(unknown.body), ['p-baseline', 'p-draft', 'p-mystery']);
    // Repo chips: the archived audit is the only hub record.
    const repo = await request(app).get('/api/plans?view=records&archived=1&repo=hub');
    assert.deepEqual(slugs(repo.body), ['p-archived']);
    assert.equal(repo.body.repo, 'hub');
  } finally {
    stub.close();
  }
});

// @plan:hn-documents-subtabs-2026-08-15 @promote
test('TP-docsub-018: no ?view= keeps the legacy contract — filters, envelope and sort unchanged by the subtabs', async () => {
  const stub = await viewStub();
  try {
    const app = appFor(stub.url);
    const res = await request(app).get('/api/plans');
    // Default exclude still hides done/archived; every open kind still lists.
    assert.deepEqual(slugs(res.body), ['p-baseline', 'p-active', 'p-draft', 'p-test-plan', 'p-legacy', 'p-held-test', 'p-mystery']);
    assert.equal(res.body.view, undefined, 'legacy envelope carries no view key');
    // An unknown ?view= is ignored, not an error.
    const bogus = await request(app).get('/api/plans?view=%2Fetc%2Fpasswd');
    assert.equal(bogus.status, 200);
    assert.deepEqual(slugs(bogus.body), slugs(res.body));
  } finally {
    stub.close();
  }
});
