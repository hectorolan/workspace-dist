'use strict';

// Digests API suite (central-DB test plans hn-test-plan-2026-07-24-digests-db +
// hn-test-plan-2026-07-26-react-refactor + test-plan-digest-index). The surface
// is /api/digests JSON: an INDEX of two-line rows (backlog item 70 — date,
// title from the stored subject with the `Daily Digest — <date>` fallback,
// thread-entry count joined best-effort) plus a slim {date, html} detail. The
// browser half (index rows, row click, deep links) is the Playwright suite.

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const request = require('supertest');
const { makeApp, startDigestStub, digestStubHandler, DIGEST_ENTRIES } = require('./helpers');
const { configFromEnv } = require('../src/config');

const API_KEY = 'stub-api-key';
const appFor = (stubUrl, overrides = {}) =>
  makeApp({ authBypass: true, logApiUrl: stubUrl, logApiKey: API_KEY, ...overrides });

test('TP-remove-digests-dir-001: config carries no digestsDir; DIGESTS_DIR env is inert', () => {
  const base = { BASE_URL: 'http://localhost:8080', SESSION_SECRET: 'fixed-for-compare' };
  const cfg = configFromEnv(base);
  assert.ok(!('digestsDir' in cfg), 'configFromEnv must not expose digestsDir');
  const withEnv = configFromEnv({ ...base, DIGESTS_DIR: '/tmp/some/legacy/path' });
  assert.deepEqual(withEnv, cfg, 'DIGESTS_DIR in the env must not change the config');
});

test('TP-digest-index-001: /api/digests lists index rows newest first; the title is the stored subject verbatim', async () => {
  const stub = await startDigestStub();
  try {
    const res = await request(appFor(stub.url)).get('/api/digests');
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.digests.map((d) => d.date), ['2026-01-03', '2026-01-02', '2026-01-01']);
    assert.deepEqual(
      res.body.digests.map((d) => d.title),
      ['Daily Digest — 2026-01-03', 'Daily Digest — 2026-01-02', 'Daily Digest — 2026-01-01']
    );
    assert.ok(stub.seen.some((r) => r.kind === 'daily-digest'), 'must read the daily-digest index');
  } finally {
    stub.close();
  }
});

test('TP-digest-index-002: a missing or blank subject falls back to "Daily Digest — <date>"; a composed subject rides as-is', async () => {
  const entries = [
    { id: 1, date: '2099-01-01', kind: 'daily-digest', subject: null, ref: '2026-04-01' },
    { id: 2, date: '2099-01-02', kind: 'daily-digest', subject: '   ', ref: '2026-04-02-daily-digest' },
    // The item-72 shape: a composed headline stored as the message subject.
    { id: 3, date: '2099-01-03', kind: 'daily-digest', subject: 'Quiet markets, loud agents', ref: '2026-04-03-daily-digest' },
  ];
  const stub = await startDigestStub({ entries, bodies: { 1: '# a', 2: '# b', 3: '# c' } });
  try {
    const res = await request(appFor(stub.url)).get('/api/digests');
    assert.equal(res.status, 200);
    assert.deepEqual(
      res.body.digests.map((d) => d.title),
      ['Quiet markets, loud agents', 'Daily Digest — 2026-04-02', 'Daily Digest — 2026-04-01']
    );
  } finally {
    stub.close();
  }
});

test('TP-digest-index-006: empty message list → ok with an empty index (client shows the quiet empty line)', async () => {
  const stub = await startDigestStub({ entries: [] });
  try {
    const res = await request(appFor(stub.url)).get('/api/digests');
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.digests, []);
  } finally {
    stub.close();
  }
});

test('TP-digest-index-003/-004: the index joins per-date thread counts, zero silent; a failing listing degrades to no counts', async () => {
  // Compose the digest stub with a /thread anchor listing so one server answers both.
  const makeStub = (failThreadList) => new Promise((resolve) => {
    const digests = digestStubHandler();
    const server = http.createServer((req, res) => {
      const u = new URL(req.url, 'http://x');
      if (digests(req, res, u)) return;
      res.setHeader('Content-Type', 'application/json');
      if (u.pathname === '/thread') {
        if (failThreadList) { res.statusCode = 500; return res.end(JSON.stringify({ ok: false })); }
        return res.end(JSON.stringify({ ok: true, threads: [
          { doc_kind: 'digest', doc_ref: '2026-01-02', entries: 2, first: '2026-01-02T08:30:00Z', last: '2026-01-02T08:45:00Z', subject: 'Page comment: Digest 2026-01-02 (digests/2026-01-02)' },
        ] }));
      }
      res.statusCode = 404;
      res.end(JSON.stringify({ ok: false }));
    });
    server.listen(0, '127.0.0.1', () => resolve({ url: `http://127.0.0.1:${server.address().port}`, close: () => server.close() }));
  });

  const stub = await makeStub(false);
  try {
    const res = await request(appFor(stub.url)).get('/api/digests');
    assert.equal(res.status, 200);
    const byDate = Object.fromEntries(res.body.digests.map((d) => [d.date, d]));
    assert.equal(byDate['2026-01-02'].comments, 2);
    assert.ok(!('comments' in byDate['2026-01-03']), 'zero is silent — no comments field');
    assert.ok(!('comments' in byDate['2026-01-01']), 'zero is silent — no comments field');
  } finally {
    stub.close();
  }

  const failing = await makeStub(true);
  try {
    const res = await request(appFor(failing.url)).get('/api/digests');
    assert.equal(res.status, 200, 'the index never breaks on the count join');
    assert.deepEqual(res.body.digests.map((d) => d.date), ['2026-01-03', '2026-01-02', '2026-01-01']);
    assert.ok(res.body.digests.every((d) => !('comments' in d)), 'best-effort join degrades to no counts');
  } finally {
    failing.close();
  }
});

test('TP-digests-db-003: bare and -daily-digest refs both resolve; a row with no derivable date is skipped', async () => {
  const entries = [
    { id: 1, date: '2099-01-01', kind: 'daily-digest', subject: 'Daily Digest — 2026-02-01', ref: '2026-02-01' },
    { id: 2, date: '2099-01-02', kind: 'daily-digest', subject: 'runner digest', ref: '2026-02-02-daily-digest' },
    { id: 3, date: '2099-01-03', kind: 'daily-digest', subject: 'weekly rollup, no date', ref: 'no-date-here' },
  ];
  const bodies = { 1: '# body one', 2: '# body two', 3: '# body three' };
  const stub = await startDigestStub({ entries, bodies });
  try {
    // Both datable rows appear in the index; the row's `date` column is never used.
    const res = await request(appFor(stub.url)).get('/api/digests');
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.digests.map((d) => d.date), ['2026-02-02', '2026-02-01']);
    // The undatable row (id 3) never becomes a date, so it cannot be reached.
    const gone = await request(appFor(stub.url)).get('/api/digests/2099-01-03');
    assert.equal(gone.status, 404);
  } finally {
    stub.close();
  }
});

test('TP-digests-db-004 / TP-digest-index-007: duplicate dates (re-stored digest) keep the highest message id — body AND title', async () => {
  const entries = [
    { id: 5, date: '2026-03-01', kind: 'daily-digest', subject: 'first store', ref: '2026-03-01' },
    { id: 9, date: '2026-03-01', kind: 'daily-digest', subject: 'restored', ref: '2026-03-01-daily-digest' },
  ];
  const bodies = { 5: '# OLD version', 9: '# NEW version' };
  const stub = await startDigestStub({ entries, bodies });
  try {
    const index = await request(appFor(stub.url)).get('/api/digests');
    assert.equal(index.status, 200);
    assert.deepEqual(index.body.digests.map((d) => d.date), ['2026-03-01'], 'the date appears once');
    assert.equal(index.body.digests[0].title, 'restored', 'the winning row supplies the title too');
    const res = await request(appFor(stub.url)).get('/api/digests/2026-03-01');
    assert.equal(res.status, 200);
    assert.match(res.body.digest.html, /NEW version/);
    assert.doesNotMatch(res.body.digest.html, /OLD version/, 'the latest stored version (highest id) wins');
  } finally {
    stub.close();
  }
});

test('TP-digests-db-005: detail html is rendered + sanitized; the API index-line header is stripped; raw markdown never ships', async () => {
  const stub = await startDigestStub();
  try {
    const res = await request(appFor(stub.url)).get('/api/digests/2026-01-02');
    assert.equal(res.status, 200);
    const d = res.body.digest;
    assert.match(d.html, /<h1[^>]*>Daily Digest — 2026-01-02<\/h1>/);
    assert.match(d.html, /<h2[^>]*>World brief<\/h2>/);
    assert.match(d.html, /<a href="https:\/\/example.com\/story"/);
    assert.match(d.html, /<strong>Something happened<\/strong>/);
    assert.doesNotMatch(d.html, /daily-digest \|/, 'the msgLine header must be stripped');
    assert.ok(!('markdown' in d), 'raw markdown stays server-side (assumption 1)');
  } finally {
    stub.close();
  }
});

test('TP-digest-index-005: the detail payload is {date, html} only — the index navigates, not the detail', async () => {
  const stub = await startDigestStub();
  try {
    const res = await request(appFor(stub.url)).get('/api/digests/2026-01-02');
    assert.equal(res.status, 200);
    assert.deepEqual(Object.keys(res.body.digest).sort(), ['date', 'html'], 'no dates/prev/next/counts ride the detail');
    assert.equal(res.body.digest.date, '2026-01-02');
  } finally {
    stub.close();
  }
});

test('TP-digests-db-007: unknown date → 404 JSON', async () => {
  const stub = await startDigestStub();
  try {
    const res = await request(appFor(stub.url)).get('/api/digests/9999-12-31');
    assert.equal(res.status, 404);
    assert.equal(res.body.ok, false);
    assert.match(res.body.error, /not found/i);
  } finally {
    stub.close();
  }
});

test('TP-digests-db-008: malformed/path-shaped date rejected 404 with ZERO API calls (guard before fetch)', async () => {
  const stub = await startDigestStub();
  try {
    const app = appFor(stub.url);
    for (const bad of ['..%2F..%2Fsecret', 'foo', '2026-1-1', '2026-01-01.md', '....']) {
      const res = await request(app).get(`/api/digests/${bad}`);
      assert.equal(res.status, 404, `expected 404 for ${bad}, got ${res.status}`);
      assert.equal(res.body.ok, false);
    }
    assert.equal(stub.seen.length, 0, 'the date guard must reject before any log API request');
  } finally {
    stub.close();
  }
});

test('TP-digests-db-009: log API unreachable → 502 on index and detail; /healthz still 200', async () => {
  const stub = await startDigestStub();
  stub.close(); // connection refused from now on
  const app = appFor(stub.url);
  const index = await request(app).get('/api/digests');
  assert.equal(index.status, 502);
  assert.match(index.body.error, /unreachable|reached/i);
  const detail = await request(app).get('/api/digests/2026-01-02');
  assert.equal(detail.status, 502);
  const health = await request(app).get('/healthz');
  assert.equal(health.status, 200);
});

test('TP-digests-db-010: unset LOG_API_URL → 503 not-configured JSON', async () => {
  const res = await request(makeApp({ authBypass: true, logApiUrl: '', logApiKey: '' })).get('/api/digests');
  assert.equal(res.status, 503);
  assert.match(res.body.error, /not configured/i);
});

test('TP-digests-db-011: every digest API call carries X-Api-Key; the key never appears in a response', async () => {
  const stub = await startDigestStub();
  try {
    const app = appFor(stub.url);
    const index = await request(app).get('/api/digests');
    const detail = await request(app).get('/api/digests/2026-01-02');
    assert.ok(stub.seen.length >= 2, 'the API was called');
    for (const r of stub.seen) assert.equal(r.key, API_KEY, 'every call carries the key');
    for (const res of [index, detail]) assert.ok(!res.text.includes(API_KEY), 'key must never reach the browser');
  } finally {
    stub.close();
  }
});

test('TP-digests-db-012: no caching — a digest stored between two index loads appears on the second load', async () => {
  const entries = DIGEST_ENTRIES.map((e) => ({ ...e }));
  const stub = await startDigestStub({ entries });
  try {
    const app = appFor(stub.url);
    const first = await request(app).get('/api/digests');
    assert.equal(first.body.digests[0].date, '2026-01-03');
    entries.push({ id: 200, date: '2026-01-04', kind: 'daily-digest', subject: 'Daily Digest — 2026-01-04', ref: '2026-01-04-daily-digest' });
    const second = await request(app).get('/api/digests');
    assert.equal(second.body.digests[0].date, '2026-01-04', 'the new digest is visible immediately, no cache');
  } finally {
    stub.close();
  }
});

test('TP-digests-db-011b: unauthenticated /api/digests hits the auth wall before any API call', async () => {
  const stub = await startDigestStub();
  try {
    const res = await request(makeApp({ logApiUrl: stub.url, logApiKey: API_KEY })).get('/api/digests'); // bypass OFF
    assert.equal(res.status, 401);
    assert.equal(stub.seen.length, 0, 'no digest API call before auth');
  } finally {
    stub.close();
  }
});

test('TP-digest-viewer-016: /healthz is public and returns 200', async () => {
  const res = await request(makeApp()).get('/healthz'); // bypass OFF
  assert.equal(res.status, 200);
});
