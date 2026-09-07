'use strict';

// Tier-2 widget layer (design hub-home-custom-pages-design "Tier semantics",
// phase 3; central-DB test plan hub-pages-tier2-widgets-2026-08-29): the
// index.json layout parse, the widget catalog's server-side composition
// against a local log-API stub, and every degrade state — unknown widget,
// bad parameter, malformed layout, erroring data source, unconfigured API.
// The one law under test: user content and upstream failures are ALWAYS
// in-page card states inside a 200, never a 5xx, never a crash.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const request = require('supertest');
const { makeApp, BASE_CONFIG } = require('./helpers');
const { mintPageToken } = require('../src/lib/pages');

/** ---- local log-API stub (deterministic; per-endpoint one-shot 500s) ------ */

const PLAN_ROWS = [
  {
    slug: 'alpha-plan', title: 'Alpha plan', status: 'active', kind: 'plan',
    repo: null, updated_at: '2026-02-03T10:00:00Z',
    // Hostile body: the sanitizer regression target for plan-view (TP-widg-008).
    body: '# Alpha\n\nBody **bold**.\n\n<script>alert(1)</script>\n\n[j](javascript:x())\n',
  },
  {
    slug: 'beta-test-plan', title: 'Beta test plan', status: 'active', kind: 'test-plan',
    repo: 'hub', updated_at: '2026-02-02T10:00:00Z', body: '# Beta\n\nCases.\n',
  },
  {
    slug: 'done-plan', title: 'Done plan', status: 'done', kind: 'plan',
    repo: 'hub', updated_at: '2026-02-01T10:00:00Z', body: 'shipped',
  },
];

const DIGEST_ROWS = [
  { id: 1, ref: '2026-02-01', subject: 'First digest' },
  { id: 2, ref: '2026-02-02-daily-digest', subject: 'Second digest' },
  { id: 3, ref: '2026-02-03-daily-digest', subject: 'Quiet day' },
];

// A future/unknown cell state ('glowing') on purpose: verdicts are echoed
// verbatim, never validated into a known set (TP-widg-009).
const FEATURE_FEED = {
  ok: true, stale_minutes: 45, schedule_owner: 'st-a', stations: ['st-a', 'st-b'],
  features: [
    { id: 'feat-one', title: 'Feature One', description: 'd', kind: 'tool', scope: 'all', measured: true,
      cells: { 'st-a': { state: 'ready', secret_blob: { nope: true } }, 'st-b': { state: 'glowing' } } },
    { id: 'feat-two', title: 'Feature Two', description: 'd', kind: 'tool', scope: 'all', measured: true,
      cells: { 'st-a': { state: 'missing' } } },
  ],
};

const STATION_FEED = {
  ok: true, stale_minutes: 45, never_reported: ['s4'],
  stations: [
    { env: 's1', ok: true, stale: false, configured: true, age_minutes: 5, report: { results: [] } },
    { env: 's2', ok: false, stale: false, configured: true, age_minutes: 5, report: { results: [] } },
    { env: 's3', ok: true, stale: true, configured: true, age_minutes: 100, report: { results: [] } },
    { env: 'rogue', ok: true, stale: false, configured: false, age_minutes: 5, report: { results: [] } },
  ],
};

function startStub() {
  const state = { fail: new Set() }; // endpoint names armed to answer 500 once
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    const send = (code, payload) => {
      res.statusCode = code;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(payload));
    };
    const failed = (name) => (state.fail.delete(name) ? (send(500, { ok: false, error: 'stub: forced' }), true) : false);
    if (u.pathname === '/message' && u.searchParams.get('kind') === 'daily-digest') {
      if (failed('message')) return;
      return send(200, { ok: true, count: DIGEST_ROWS.length, entries: DIGEST_ROWS });
    }
    if (u.pathname === '/plan') {
      if (failed('plan')) return;
      const exclude = (u.searchParams.get('exclude') || '').split(',').filter(Boolean);
      const rows = PLAN_ROWS.filter((r) => !exclude.includes(r.status)).map(({ body, ...r }) => r);
      return send(200, { ok: true, count: rows.length, entries: rows });
    }
    const m = u.pathname.match(/^\/plan\/([^/?]+)$/);
    if (m) {
      const row = PLAN_ROWS.find((r) => r.slug === decodeURIComponent(m[1]));
      if (!row) return send(404, { ok: false, error: 'not found' });
      return send(200, { plan: row });
    }
    if (u.pathname === '/feature') {
      if (failed('feature')) return;
      return send(200, FEATURE_FEED);
    }
    if (u.pathname === '/station') {
      if (failed('station')) return;
      return send(200, STATION_FEED);
    }
    send(404, { ok: false, error: `no stub route for ${u.pathname}` });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () =>
      resolve({ url: `http://127.0.0.1:${server.address().port}`, state, close: () => server.close() })
    );
  });
}

/** Pages root with ONE widgets page (`board/index.json` = the given layout). */
function makeBoardRoot(layout) {
  const root = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'hub-widg-')), 'pages');
  fs.mkdirSync(path.join(root, 'board'), { recursive: true });
  fs.writeFileSync(
    path.join(root, 'board', 'index.json'),
    typeof layout === 'string' ? layout : JSON.stringify(layout)
  );
  return root;
}

const FULL_LAYOUT = {
  title: 'The Board',
  widgets: [
    { widget: 'digest-list', params: { limit: 2 } },
    { widget: 'plan-list', title: 'Open work', params: { limit: 10 } },
    { widget: 'plan-view', params: { slug: 'alpha-plan' } },
    { widget: 'feature-cells', params: { features: ['feat-one', 'feat-two'] } },
    { widget: 'stat-tiles', params: { tiles: [{ source: 'open-plans' }, { source: 'latest-digest' }, { source: 'stations-ok' }] } },
  ],
};

let stub;
test.before(async () => {
  stub = await startStub();
});
test.after(() => stub.close());

const owner = (root, extra = {}) =>
  makeApp({ authBypass: true, pagesDir: root, pagesScanTtlMs: 0, logApiUrl: stub.url, logApiKey: 'SECRET-KEY-123', ...extra });

async function getBoard(app) {
  const res = await request(app).get('/api/pages/board');
  assert.equal(res.status, 200);
  return res.body.page;
}

// @plan:hub-pages-tier2-widgets-2026-08-29 @promote
test('TP-widg-001: a valid layout composes every catalog widget server-side, in layout order', async () => {
  const page = await getBoard(owner(makeBoardRoot(FULL_LAYOUT)));
  assert.equal(page.tier, 'widgets');
  assert.equal(page.layoutError, undefined);
  assert.deepEqual(page.widgets.map((w) => [w.widget, w.state]), [
    ['digest-list', 'ok'],
    ['plan-list', 'ok'],
    ['plan-view', 'ok'],
    ['feature-cells', 'ok'],
    ['stat-tiles', 'ok'],
  ]);
  const [digest, planList, planView, cells, tiles] = page.widgets;
  // digest-list: newest first, ref/subject-derived dates, capped at limit.
  assert.deepEqual(digest.data.rows, [
    { date: '2026-02-03', title: 'Quiet day' },
    { date: '2026-02-02', title: 'Second digest' },
  ]);
  // plan-list: the default open view (done/archived excluded), newest updated first.
  assert.deepEqual(planList.data.rows.map((r) => r.slug), ['alpha-plan', 'beta-test-plan']);
  assert.deepEqual(planList.data.rows[0], {
    slug: 'alpha-plan', title: 'Alpha plan', status: 'active', kind: 'plan', repo: 'workspace', updated: '2026-02-03',
  });
  // plan-view: the document body, sanitized (fully asserted in TP-widg-008).
  assert.equal(planView.data.slug, 'alpha-plan');
  assert.match(planView.data.html, /<strong>bold<\/strong>/);
  // feature-cells + stat-tiles fully asserted in TP-widg-009.
  assert.deepEqual(cells.data.stations, ['st-a', 'st-b']);
  assert.equal(tiles.data.tiles.length, 3);
});

// @plan:hub-pages-tier2-widgets-2026-08-29 @promote
test('TP-widg-002: titles — layout title overrides the document title, per-widget titles override card titles, defaults otherwise', async () => {
  const page = await getBoard(owner(makeBoardRoot(FULL_LAYOUT)));
  assert.equal(page.title, 'The Board'); // layout title, like tier 1's `# ` heading
  assert.equal(page.widgets[0].title, 'Recent digests'); // catalog default
  assert.equal(page.widgets[1].title, 'Open work'); // entry override
  // Oversized/wrong-typed titles are ignored — the scan's title holds.
  const page2 = await getBoard(owner(makeBoardRoot({ title: 'x'.repeat(200), widgets: [{ widget: 'digest-list', title: 42 }] })));
  assert.equal(page2.title, 'Board'); // humanized folder name
  assert.equal(page2.widgets[0].title, 'Recent digests');
});

// @plan:hub-pages-tier2-widgets-2026-08-29 @promote
test('TP-widg-003: malformed layouts are a visible layout-error card, never a 5xx', async () => {
  for (const layout of ['{ not valid json at all', '"just a string"', '[]', '{}', '{"widgets": []}', '{"widgets": "nope"}']) {
    const res = await request(owner(makeBoardRoot(layout))).get('/api/pages/board');
    assert.equal(res.status, 200, layout);
    assert.equal(res.body.page.tier, 'widgets');
    assert.ok(res.body.page.layoutError, `layoutError for ${layout}`);
    assert.deepEqual(res.body.page.widgets, []);
  }
});

// @plan:hub-pages-tier2-widgets-2026-08-29 @promote
test('TP-widg-004: an unknown widget is a named placeholder; surrounding widgets still render', async () => {
  const page = await getBoard(owner(makeBoardRoot({
    widgets: [{ widget: 'digest-list' }, { widget: 'crystal-ball' }, 'not-an-object', { widget: 'digest-list' }],
  })));
  assert.deepEqual(page.widgets.map((w) => w.state), ['ok', 'unknown', 'invalid', 'ok']);
  assert.match(page.widgets[1].message, /crystal-ball/);
  assert.match(page.widgets[1].message, /catalog/);
});

// @plan:hub-pages-tier2-widgets-2026-08-29 @promote
test('TP-widg-005: parameters — safe params clamp/default, missing required params are a visible invalid card, arrays truncate at their caps', async () => {
  const page = await getBoard(owner(makeBoardRoot({
    widgets: [
      { widget: 'digest-list', params: { limit: 999 } }, // clamped to 20 (3 rows exist)
      { widget: 'digest-list', params: { limit: '5', bogus: true } }, // wrong type -> default 5; unknown param ignored
      { widget: 'plan-view', params: {} }, // required slug missing
      { widget: 'feature-cells', params: { features: [] } }, // required list empty
      { widget: 'stat-tiles', params: { tiles: [{ source: 'lottery-numbers' }] } }, // unknown source -> per-tile error
      { widget: 'stat-tiles', params: { tiles: Array.from({ length: 12 }, () => ({ source: 'latest-digest' })) } },
    ],
  })));
  const [clamped, defaulted, noSlug, noFeatures, badSource, manyTiles] = page.widgets;
  assert.equal(clamped.state, 'ok');
  assert.equal(clamped.data.rows.length, 3);
  assert.equal(defaulted.state, 'ok');
  assert.equal(noSlug.state, 'invalid');
  assert.match(noSlug.message, /slug/);
  assert.equal(noFeatures.state, 'invalid');
  assert.match(noFeatures.message, /features/);
  assert.equal(badSource.state, 'ok'); // the widget renders; the TILE degrades
  assert.match(badSource.data.tiles[0].error, /lottery-numbers/);
  assert.equal(manyTiles.data.tiles.length, 8); // MAX_TILES cap
  // The widgets array itself caps at 24, with a visible truncation note.
  const big = await getBoard(owner(makeBoardRoot({
    widgets: Array.from({ length: 30 }, () => ({ widget: 'digest-list' })),
  })));
  assert.equal(big.widgets.length, 25);
  assert.equal(big.widgets[24].state, 'invalid');
  assert.match(big.widgets[24].message, /24/);
});

// @plan:hub-pages-tier2-widgets-2026-08-29 @promote
test('TP-widg-006: a failing data source degrades ONLY its widget — safe message, others ok, response 200', async () => {
  stub.state.fail.add('feature');
  const page = await getBoard(owner(makeBoardRoot(FULL_LAYOUT)));
  const byWidget = Object.fromEntries(page.widgets.map((w) => [w.widget, w]));
  assert.equal(byWidget['feature-cells'].state, 'error');
  // The message is authored here — never the upstream body, URL, or status.
  assert.doesNotMatch(byWidget['feature-cells'].message, /500|stub|127\.0\.0\.1/);
  assert.equal(byWidget['digest-list'].state, 'ok');
  assert.equal(byWidget['plan-view'].state, 'ok');
});

// @plan:hub-pages-tier2-widgets-2026-08-29 @promote
test('TP-widg-007: no LOG_API_URL — every data widget renders the unconfigured card, 200', async () => {
  const page = await getBoard(owner(makeBoardRoot(FULL_LAYOUT), { logApiUrl: '' }));
  for (const w of page.widgets) {
    assert.equal(w.state, 'unconfigured', w.widget);
    assert.match(w.message, /LOG_API_URL/);
  }
});

// @plan:hub-pages-tier2-widgets-2026-08-29 @promote
test('TP-widg-008: plan-view html rides the one sanitization pipeline; no secret-shaped value reaches the response', async () => {
  const root = makeBoardRoot(FULL_LAYOUT);
  const res = await request(owner(root)).get('/api/pages/board');
  const planView = res.body.page.widgets.find((w) => w.widget === 'plan-view');
  assert.ok(!/<script/i.test(planView.data.html), 'no script tags');
  assert.ok(!/javascript:/i.test(planView.data.html), 'no javascript: hrefs');
  const raw = JSON.stringify(res.body);
  assert.ok(!raw.includes('SECRET-KEY-123'), 'the API key never reaches the browser');
  assert.ok(!raw.includes(stub.url), 'the log API URL never reaches the browser');
  assert.ok(!raw.includes(root.replaceAll('\\', '\\\\')), 'no filesystem paths in the response');
});

// @plan:hub-pages-tier2-widgets-2026-08-29 @promote
test('TP-widg-009: the control plane judges — cell states echo verbatim, tiles count feeds without recomputing health', async () => {
  const page = await getBoard(owner(makeBoardRoot({
    widgets: [
      { widget: 'feature-cells', params: { features: ['feat-one', 'feat-two', 'ghost-feature'] } },
      { widget: 'feature-cells', params: { features: ['feat-one'], stations: ['st-b'] } },
      { widget: 'feature-cells', params: { features: ['feat-one'], stations: ['typo-station'] } },
      { widget: 'stat-tiles', params: { tiles: [
        { source: 'open-plans' }, { source: 'open-plans', repo: 'hub', label: 'Hub docs' },
        { source: 'latest-digest' }, { source: 'stations-ok' },
      ] } },
    ],
  })));
  const [cells, filtered, typo, tiles] = page.widgets;
  // Verdicts verbatim — including a state string this build has never seen.
  const rows = Object.fromEntries(cells.data.features.map((f) => [f.id, f]));
  assert.equal(rows['feat-one'].cells['st-a'].state, 'ready');
  assert.equal(rows['feat-one'].cells['st-b'].state, 'glowing');
  // A missing cell folds to unmeasured — never fake liveness.
  assert.equal(rows['feat-two'].cells['st-b'].state, 'unmeasured');
  // An unknown id is a visible empty row, not a dropped one.
  assert.equal(rows['ghost-feature'].missing, true);
  // The trim is a whitelist: a cell carries state only (no feed extras).
  assert.deepEqual(Object.keys(rows['feat-one'].cells['st-a']), ['state']);
  // stations filters to roster members; a filter that empties falls back to the roster.
  assert.deepEqual(filtered.data.stations, ['st-b']);
  assert.deepEqual(typo.data.stations, ['st-a', 'st-b']);
  // Tiles: counts of the feeds' own rows/verdicts.
  const [open, openHub, latest, stationsOk] = tiles.data.tiles;
  assert.equal(open.value, '2'); // active rows in the default open view
  assert.deepEqual([openHub.label, openHub.value], ['Hub docs', '1']);
  assert.equal(latest.value, '2026-02-03');
  assert.equal(latest.href, '/digests/2026-02-03');
  assert.equal(stationsOk.value, '1/4'); // ok&fresh s1 of configured s1-s3 + never-reported s4; rogue excluded
});

// @plan:hub-pages-tier2-widgets-2026-08-29 @promote
test('TP-widg-010: the phase-2 posture holds — roster tier, auth wall, and the tier-3-only pages-view path unchanged', async () => {
  const root = makeBoardRoot(FULL_LAYOUT);
  // Roster still reports the tier; no widget data leaks into the roster.
  const roster = await request(owner(root)).get('/api/pages');
  assert.deepEqual(roster.body.pages.map((p) => [p.slug, p.tier]), [['board', 'widgets']]);
  // The detail stays behind the auth wall.
  const anon = makeApp({ pagesDir: root, pagesScanTtlMs: 0, logApiUrl: stub.url });
  assert.equal((await request(anon).get('/api/pages/board')).status, 401);
  // /pages-view NEVER serves a widgets page — even with a validly-minted token.
  const token = mintPageToken({ sessionSecret: BASE_CONFIG.sessionSecret }, 'board');
  const view = await request(owner(root)).get(`/pages-view/${token}/board/index.json`);
  assert.equal(view.status, 404);
});
