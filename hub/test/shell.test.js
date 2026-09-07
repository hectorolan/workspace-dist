'use strict';

// SPA shell serving (new with the React refactor — central-DB test plan
// hn-test-plan-2026-07-26-react-refactor, TP-react-006/007).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const request = require('supertest');
const { makeApp, DIST_INDEX_MARKER } = require('./helpers');

const asOwner = (overrides = {}) => makeApp({ authBypass: true, ...overrides });

test('TP-react-007a: every gated GET app path serves the SPA shell with 200', async () => {
  const app = asOwner();
  for (const url of ['/', '/digests/2026-01-01', '/plans', '/plans/some-slug', '/conversations/7', '/agents/alpha', '/skills/x', '/knowledge/claude-md', '/definitely/not/a/route']) {
    const res = await request(app).get(url);
    assert.equal(res.status, 200, `${url} must serve the shell`);
    assert.ok(res.text.includes(DIST_INDEX_MARKER), `${url} must serve dist/index.html`);
  }
});

test('TP-react-007b: unknown /api path is 404 JSON, never the shell', async () => {
  const app = asOwner();
  for (const url of ['/api/nope', '/api/digests/extra/deep', '/api']) {
    const res = await request(app).get(url);
    assert.equal(res.status, 404, `${url} must 404`);
    assert.match(res.headers['content-type'], /application\/json/, `${url} must be JSON`);
    assert.ok(!res.text.includes(DIST_INDEX_MARKER), 'no shell on API paths');
  }
});

test('TP-react-007c: non-GET on an app path is 404 JSON (no method-blind shell)', async () => {
  const res = await request(asOwner()).post('/plans/some-slug').send({});
  assert.equal(res.status, 404);
  assert.match(res.headers['content-type'], /application\/json/);
});

test('TP-react-007d: missing build → clear 503, not a stack trace', async () => {
  const emptyDist = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-nodist-'));
  const res = await request(asOwner({ distDir: emptyDist })).get('/');
  assert.equal(res.status, 503);
  assert.match(res.text, /npm run build/i, 'the message says how to fix it');
});

test('TP-react-006: the shell and static assets sit behind the auth wall', async () => {
  const app = makeApp(); // bypass OFF
  const res = await request(app).get('/');
  assert.equal(res.status, 302, 'unauthenticated shell request redirects to Google');
  const asset = await request(app).get('/assets/index-abc123.js');
  assert.equal(asset.status, 302, 'assets are gated too');
});

test('TP-react-006b: the terminal-page stylesheet is public (auth-failure pages must style without a session)', async () => {
  const res = await request(makeApp()).get('/public/base.css');
  assert.equal(res.status, 200);
  assert.match(res.headers['content-type'], /text\/css/);
});
