'use strict';

// Custom pages framework core (design hub-home-custom-pages-design Part 2,
// phase 2; central-DB test plan hub-pages-framework-core-2026-08-29): the
// HUB_PAGES_DIR folder scan, the page.json manifest, the three-tier index
// contract, the /api/pages roster + detail behind the auth wall, and the
// token-authenticated /pages-view tier-3 serving path with its traversal
// proofing. Fixture pages roots are per-test temp dirs; planted "secret"
// files outside the root and beside the served folder are the traversal
// targets — they must NEVER be served.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { setTimeout: sleep } = require('node:timers/promises');
const request = require('supertest');
const { makeApp, BASE_CONFIG } = require('./helpers');
const { humanizeName, mintPageToken, verifyPageToken } = require('../src/lib/pages');

/** Build a pages root exercising every tier + every skip reason. */
function makePagesRoot() {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-pages-'));
  const root = path.join(parent, 'pages');
  fs.mkdirSync(root);
  // The traversal target OUTSIDE the root: must never be reachable.
  fs.writeFileSync(path.join(parent, 'outside-secret.txt'), 'OUTSIDE-SECRET');

  // Tier 1, two sections + preamble.
  fs.mkdirSync(path.join(root, 'my-notes'));
  fs.writeFileSync(
    path.join(root, 'my-notes', 'index.md'),
    '# My Notes\n\nPreamble text for the intro.\n\n## First\n\n- alpha\n\n## Second\n\nSome **bold** text.\n'
  );
  // A sibling page's private file — the in-root traversal target.
  fs.writeFileSync(path.join(root, 'my-notes', 'private.txt'), 'SIBLING-SECRET');

  // Tier 3 with assets, a nested folder, a dotfile, and a manifest.
  fs.mkdirSync(path.join(root, 'fleet-app'));
  fs.mkdirSync(path.join(root, 'fleet-app', 'img'));
  fs.writeFileSync(
    path.join(root, 'fleet-app', 'index.html'),
    '<!doctype html><html><body><h1>Fleet</h1><script src="app.js"></script></body></html>'
  );
  fs.writeFileSync(path.join(root, 'fleet-app', 'app.js'), 'document.title = "fleet";');
  fs.writeFileSync(path.join(root, 'fleet-app', 'style.css'), 'h1 { color: green; }');
  fs.writeFileSync(path.join(root, 'fleet-app', 'img', 'dot.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');
  fs.writeFileSync(path.join(root, 'fleet-app', '.env'), 'DOTFILE-SECRET');
  fs.writeFileSync(path.join(root, 'fleet-app', 'page.json'), '{"title":"Fleet App","order":1,"icon":"F"}');

  // Tier 2: index.json content is deliberately garbage — it must never be parsed.
  fs.mkdirSync(path.join(root, 'ops-board'));
  fs.writeFileSync(path.join(root, 'ops-board', 'index.json'), '{ not valid json at all');

  // Precedence probes.
  fs.mkdirSync(path.join(root, 'all-three'));
  for (const f of ['index.html', 'index.json', 'index.md']) {
    fs.writeFileSync(path.join(root, 'all-three', f), f);
  }
  fs.mkdirSync(path.join(root, 'json-md'));
  fs.writeFileSync(path.join(root, 'json-md', 'index.json'), '{}');
  fs.writeFileSync(path.join(root, 'json-md', 'index.md'), '# also here');

  // Manifest edge cases: every field wrong-typed/oversized => all ignored.
  fs.mkdirSync(path.join(root, 'weird-manifest'));
  fs.writeFileSync(path.join(root, 'weird-manifest', 'index.md'), '# Weird\n\nbody\n');
  fs.writeFileSync(
    path.join(root, 'weird-manifest', 'page.json'),
    JSON.stringify({ title: 42, order: 'first', icon: 'x'.repeat(40), unknown: true })
  );
  // Malformed manifest => defaults, page still listed.
  fs.mkdirSync(path.join(root, 'broken-manifest'));
  fs.writeFileSync(path.join(root, 'broken-manifest', 'index.md'), '# Broken Manifest\n\nbody\n');
  fs.writeFileSync(path.join(root, 'broken-manifest', 'page.json'), '{ nope');

  // Skips: no index; invalid names.
  fs.mkdirSync(path.join(root, 'drafts'));
  fs.writeFileSync(path.join(root, 'drafts', 'notes.txt'), 'no index');
  fs.mkdirSync(path.join(root, 'bad name'));
  fs.writeFileSync(path.join(root, 'bad name', 'index.md'), '# nope');
  fs.mkdirSync(path.join(root, '.hidden'));
  fs.writeFileSync(path.join(root, '.hidden', 'index.md'), '# nope');
  // A stray file in the root is not a page and not a skip entry.
  fs.writeFileSync(path.join(root, 'stray.txt'), 'not a folder');

  return { parent, root };
}

const owner = (root, extra = {}) => makeApp({ authBypass: true, pagesDir: root, pagesScanTtlMs: 0, ...extra });
const anon = (root, extra = {}) => makeApp({ pagesDir: root, pagesScanTtlMs: 0, ...extra });

/** Mint a token through the real API path (authenticated detail response). */
async function tokenFor(app, slug) {
  const res = await request(app).get(`/api/pages/${slug}`);
  assert.equal(res.status, 200);
  const m = res.body.page.src.match(/^\/pages-view\/([^/]+)\/([^/]+)\/$/);
  assert.ok(m, `src carries the token path: ${res.body.page.src}`);
  return m[1];
}

// @plan:hub-pages-framework-core-2026-08-29 @promote
test('TP-pages-001: HUB_PAGES_DIR unset = feature off — empty roster, 404 details, dead pages-view', async () => {
  const app = makeApp({ authBypass: true }); // no pagesDir at all
  const roster = await request(app).get('/api/pages');
  assert.equal(roster.status, 200);
  assert.deepEqual(roster.body, { ok: true, enabled: false, pages: [], skipped: [] });
  assert.equal((await request(app).get('/api/pages/anything')).status, 404);
  assert.equal((await request(app).get('/pages-view/123.deadbeef/anything/index.html')).status, 404);
});

// @plan:hub-pages-framework-core-2026-08-29 @promote
test('TP-pages-002: the roster lists every indexed folder with its tier and honestly reports skips', async () => {
  const { root } = makePagesRoot();
  const res = await request(owner(root)).get('/api/pages');
  assert.equal(res.status, 200);
  assert.equal(res.body.enabled, true);
  const bySlug = Object.fromEntries(res.body.pages.map((p) => [p.slug, p]));
  assert.equal(bySlug['my-notes'].tier, 'md');
  assert.equal(bySlug['fleet-app'].tier, 'html');
  assert.equal(bySlug['ops-board'].tier, 'widgets');
  const skips = Object.fromEntries(res.body.skipped.map((s) => [s.name, s.reason]));
  assert.equal(skips['drafts'], 'no-index');
  assert.equal(skips['bad name'], 'invalid-name');
  assert.equal(skips['.hidden'], 'invalid-name');
  assert.ok(!('stray.txt' in skips), 'root files are not pages and not skip entries');
  assert.ok(!bySlug['stray.txt']);
  // No filesystem path leaks into the roster.
  assert.ok(!JSON.stringify(res.body).includes(root.replace(/\\/g, '\\\\')), 'roster must not carry fs paths');
});

// @plan:hub-pages-framework-core-2026-08-29 @promote
test('TP-pages-003: tabs sort manifest-order first, then alphabetically by title', async () => {
  const { root } = makePagesRoot();
  const res = await request(owner(root)).get('/api/pages');
  const slugs = res.body.pages.map((p) => p.slug);
  // fleet-app pins order 1; everything else is unordered => alphabetical by title:
  // All Three, Broken Manifest, Json Md, My Notes, Ops Board, Weird Manifest.
  assert.deepEqual(slugs, ['fleet-app', 'all-three', 'broken-manifest', 'json-md', 'my-notes', 'ops-board', 'weird-manifest']);
});

// @plan:hub-pages-framework-core-2026-08-29 @promote
test('TP-pages-004: manifest overrides title/icon/order; wrong-typed fields and broken JSON fall back to defaults', async () => {
  const { root } = makePagesRoot();
  const res = await request(owner(root)).get('/api/pages');
  const bySlug = Object.fromEntries(res.body.pages.map((p) => [p.slug, p]));
  assert.equal(humanizeName('my-notes'), 'My Notes');
  assert.equal(bySlug['my-notes'].title, 'My Notes', 'humanized default');
  assert.equal(bySlug['fleet-app'].title, 'Fleet App');
  assert.equal(bySlug['fleet-app'].icon, 'F');
  assert.equal(bySlug['fleet-app'].order, 1);
  // Wrong-typed/oversized fields are ignored one by one…
  assert.equal(bySlug['weird-manifest'].title, 'Weird Manifest');
  assert.equal(bySlug['weird-manifest'].icon, '');
  assert.equal(bySlug['weird-manifest'].order, null);
  // …and malformed JSON ignores the whole manifest, page still listed.
  assert.equal(bySlug['broken-manifest'].title, 'Broken Manifest');
});

// @plan:hub-pages-framework-core-2026-08-29 @promote
test('TP-pages-005: index precedence is html > json > md', async () => {
  const { root } = makePagesRoot();
  const res = await request(owner(root)).get('/api/pages');
  const bySlug = Object.fromEntries(res.body.pages.map((p) => [p.slug, p]));
  assert.equal(bySlug['all-three'].tier, 'html');
  assert.equal(bySlug['json-md'].tier, 'widgets');
});

// @plan:hub-pages-framework-core-2026-08-29 @promote
test('TP-pages-006: tier-1 detail renders through the one sanitization pipeline with the guide section shape', async () => {
  const { root } = makePagesRoot();
  const res = await request(owner(root)).get('/api/pages/my-notes');
  assert.equal(res.status, 200);
  const page = res.body.page;
  assert.equal(page.tier, 'md');
  assert.equal(page.title, 'My Notes');
  assert.match(page.intro, /Preamble text/, 'preamble lands in intro');
  assert.equal(page.sections.length, 2);
  const ids = page.sections.map((s) => s.id);
  assert.deepEqual(ids, ['first', 'second']);
  for (const s of page.sections) {
    assert.match(s.id, /^[a-z0-9-]+$/);
    assert.ok(!/<script/i.test(s.html));
    assert.ok(!/\sid=/.test(s.html), 'anchor ids live on client wrappers');
    assert.ok(!/<h2>/.test(s.html), 'headings stripped from bodies');
  }
  assert.match(page.sections[1].html, /<strong>bold<\/strong>/);
  // Hostile markdown is neutered, same posture as the guide (TP-home-002).
  fs.writeFileSync(
    path.join(root, 'my-notes', 'index.md'),
    '# Evil\n\n<script>alert(1)</script>\n\n## S\n\n<a href="javascript:x()">j</a>\n'
  );
  const evil = await request(owner(root)).get('/api/pages/my-notes');
  assert.ok(!/<script/i.test(JSON.stringify(evil.body)));
  assert.ok(!/javascript:/i.test(evil.body.page.sections[0].html));
});

// @plan:hub-pages-framework-core-2026-08-29 @promote
test('TP-pages-007: tier-3 detail hands back a token-scoped pages-view src that verifies', async () => {
  const { root } = makePagesRoot();
  const app = owner(root);
  const res = await request(app).get('/api/pages/fleet-app');
  assert.equal(res.status, 200);
  assert.equal(res.body.page.tier, 'html');
  const m = res.body.page.src.match(/^\/pages-view\/([^/]+)\/fleet-app\/$/);
  assert.ok(m, `src shape: ${res.body.page.src}`);
  assert.equal(verifyPageToken({ sessionSecret: BASE_CONFIG.sessionSecret }, 'fleet-app', m[1]), true);
  assert.equal(verifyPageToken({ sessionSecret: BASE_CONFIG.sessionSecret }, 'other-slug', m[1]), false);
});

// @plan:hub-pages-tier2-widgets-2026-08-29 @promote
// (TP-widg-003 amendment of phase 2's TP-pages-008: since phase 3 the tier-2
// index.json IS parsed — but garbage still cannot 5xx anything: it degrades
// to a visible layout-error card state. Full layout coverage lives in
// test/pages-widgets.test.js.)
test('TP-pages-008: garbage tier-2 index.json degrades to a layout-error card, never a 5xx', async () => {
  const { root } = makePagesRoot();
  const res = await request(owner(root)).get('/api/pages/ops-board');
  assert.equal(res.status, 200);
  assert.equal(res.body.page.tier, 'widgets');
  assert.equal(res.body.page.title, 'Ops Board');
  assert.ok(res.body.page.layoutError, 'malformed layout surfaces as a visible in-page message');
  assert.deepEqual(res.body.page.widgets, []);
});

// @plan:hub-pages-framework-core-2026-08-29 @promote
test('TP-pages-009: unknown and skipped slugs are clean 404s', async () => {
  const { root } = makePagesRoot();
  const app = owner(root);
  for (const slug of ['nope', 'drafts', 'stray.txt']) {
    const res = await request(app).get(`/api/pages/${slug}`);
    assert.equal(res.status, 404, slug);
    assert.equal(res.body.ok, false);
  }
});

// @plan:hub-pages-framework-core-2026-08-29 @promote
test('TP-pages-010: the pages API sits behind the auth wall', async () => {
  const { root } = makePagesRoot();
  const app = anon(root);
  assert.equal((await request(app).get('/api/pages')).status, 401);
  assert.equal((await request(app).get('/api/pages/my-notes')).status, 401);
  assert.equal((await request(owner(root)).get('/api/pages')).status, 200);
});

// @plan:hub-pages-framework-core-2026-08-29 @promote
test('TP-pages-011: a valid token serves the tier-3 site — document, assets, nested files, trailing-slash redirect', async () => {
  const { root } = makePagesRoot();
  const tok = await tokenFor(owner(root), 'fleet-app');
  const app = anon(root); // token alone is the credential — no session, no bypass

  const bare = await request(app).get(`/pages-view/${tok}/fleet-app`);
  assert.equal(bare.status, 302);
  assert.equal(bare.headers.location, `/pages-view/${tok}/fleet-app/`);

  const doc = await request(app).get(`/pages-view/${tok}/fleet-app/`);
  assert.equal(doc.status, 200);
  assert.match(doc.headers['content-type'], /text\/html/);
  assert.match(doc.text, /<h1>Fleet<\/h1>/);

  const js = await request(app).get(`/pages-view/${tok}/fleet-app/app.js`);
  assert.equal(js.status, 200);
  assert.match(js.headers['content-type'], /javascript/);

  const css = await request(app).get(`/pages-view/${tok}/fleet-app/style.css`);
  assert.equal(css.status, 200);
  assert.match(css.headers['content-type'], /text\/css/);

  const svg = await request(app).get(`/pages-view/${tok}/fleet-app/img/dot.svg`);
  assert.equal(svg.status, 200);
  assert.match(svg.headers['content-type'], /image\/svg/);
});

// @plan:hub-pages-framework-core-2026-08-29 @promote
test('TP-pages-012: pages-view credentials — bad/expired/cross-slug tokens refused, live session accepted, non-tier-3 refused', async () => {
  const { root } = makePagesRoot();
  const tok = await tokenFor(owner(root), 'fleet-app');
  const app = anon(root);

  // Missing/garbled/tampered tokens: 401 (or the redirect route's 404 on shape).
  assert.equal((await request(app).get('/pages-view/nonsense/fleet-app/index.html')).status, 401);
  const tampered = tok.replace(/.$/, (c) => (c === '0' ? '1' : '0'));
  assert.equal((await request(app).get(`/pages-view/${tampered}/fleet-app/index.html`)).status, 401);
  // Expired: recompute the real HMAC for a past expiry — still refused.
  const exp = Date.now() - 1000;
  const mac = crypto.createHmac('sha256', BASE_CONFIG.sessionSecret).update(`pages:fleet-app:${exp}`).digest('hex');
  assert.equal((await request(app).get(`/pages-view/${exp}.${mac}/fleet-app/index.html`)).status, 401);
  // A token minted for fleet-app opens nothing else.
  assert.equal((await request(app).get(`/pages-view/${tok}/all-three/index.html`)).status, 401);
  // A live owner session works without a token (direct debugging path)…
  const sessionOk = await request(owner(root)).get(`/pages-view/${tampered}/fleet-app/index.html`);
  assert.equal(sessionOk.status, 200, 'session-authed request serves despite a dead token');
  // …but tier-1/tier-2 folders are never static-served, even authenticated.
  const t1 = mintPageToken({ sessionSecret: BASE_CONFIG.sessionSecret }, 'my-notes');
  assert.equal((await request(app).get(`/pages-view/${t1}/my-notes/private.txt`)).status, 404);
  assert.equal((await request(owner(root)).get(`/pages-view/${t1}/my-notes/index.md`)).status, 404);
});

// @plan:hub-pages-framework-core-2026-08-29 @promote
test('TP-pages-013: traversal attempts never serve bytes from outside the page folder', async () => {
  const { root } = makePagesRoot();
  const tok = await tokenFor(owner(root), 'fleet-app');
  const app = anon(root);
  // Raw HTTP requests on purpose: supertest's client (WHATWG URL) collapses
  // `..` and `%2e%2e` dot segments before they ever leave the machine, which
  // would test the CLIENT, not the server guard. These paths hit the wire
  // verbatim.
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.on('listening', resolve));
  const { port } = server.address();
  const rawGet = (rawPath) =>
    new Promise((resolve, reject) => {
      const req = require('node:http').request(
        { host: '127.0.0.1', port, path: rawPath, method: 'GET' },
        (res) => {
          let body = '';
          res.on('data', (c) => (body += c));
          res.on('end', () => resolve({ status: res.statusCode, body }));
        }
      );
      req.on('error', reject);
      req.end();
    });
  try {
    const attempts = [
      `/pages-view/${tok}/fleet-app/../my-notes/private.txt`,
      `/pages-view/${tok}/fleet-app/../../outside-secret.txt`,
      `/pages-view/${tok}/fleet-app/%2e%2e%2fmy-notes/private.txt`,
      `/pages-view/${tok}/fleet-app/%2e%2e/%2e%2e/outside-secret.txt`,
      `/pages-view/${tok}/fleet-app/..%5C..%5Coutside-secret.txt`,
      `/pages-view/${tok}/fleet-app/img/../../../outside-secret.txt`,
      `/pages-view/${tok}/fleet-app/index.html%00.txt`,
      `/pages-view/${tok}/fleet-app//app.js`,
    ];
    for (const url of attempts) {
      const res = await rawGet(url);
      assert.ok([400, 404].includes(res.status), `${url} -> ${res.status}`);
      assert.ok(!String(res.body).includes('SECRET'), `${url} must not leak file bytes`);
    }
    // Traversal-shaped slugs die at the API too (auth wall first for anon; the
    // shape guard answers 404 on an authed app).
    assert.equal((await request(owner(root)).get('/api/pages/..%2f..')).status, 404);
  } finally {
    server.close();
  }
});

// @plan:hub-pages-framework-core-2026-08-29 @promote
test('TP-pages-014: dotfiles 404, missing assets 404, and pages-view responses carry the page CSP posture', async () => {
  const { root } = makePagesRoot();
  const tok = await tokenFor(owner(root), 'fleet-app');
  const app = anon(root);
  assert.equal((await request(app).get(`/pages-view/${tok}/fleet-app/.env`)).status, 404);
  assert.equal((await request(app).get(`/pages-view/${tok}/fleet-app/missing.js`)).status, 404);
  const doc = await request(app).get(`/pages-view/${tok}/fleet-app/`);
  const csp = doc.headers['content-security-policy'];
  assert.match(csp, /frame-ancestors 'self'/);
  assert.match(csp, /connect-src 'self'/);
  assert.ok(!/frame-ancestors 'none'/.test(csp), 'page CSP overrides the shell CSP');
  assert.equal(doc.headers['referrer-policy'], 'no-referrer');
  assert.equal(doc.headers['x-content-type-options'], 'nosniff');
});

// @plan:hub-pages-framework-core-2026-08-29 @promote
test('TP-pages-015: the scan cache holds within the TTL and refreshes after it', async () => {
  const { root } = makePagesRoot();
  // Long TTL: a folder dropped in after the first scan stays invisible…
  const cached = owner(root, { pagesScanTtlMs: 60000 });
  const before = await request(cached).get('/api/pages');
  fs.mkdirSync(path.join(root, 'late-arrival'));
  fs.writeFileSync(path.join(root, 'late-arrival', 'index.md'), '# Late\n');
  const still = await request(cached).get('/api/pages');
  assert.deepEqual(still.body.pages.map((p) => p.slug), before.body.pages.map((p) => p.slug), 'cache holds');
  // …a short TTL picks it up after expiry (drop a folder in => next load)…
  const fresh = owner(root, { pagesScanTtlMs: 10 });
  await request(fresh).get('/api/pages');
  fs.mkdirSync(path.join(root, 'later-still'));
  fs.writeFileSync(path.join(root, 'later-still', 'index.md'), '# Later\n');
  await sleep(30);
  const after = await request(fresh).get('/api/pages');
  assert.ok(after.body.pages.some((p) => p.slug === 'later-still'), 'expired cache rescans');
});

// @plan:hub-pages-framework-core-2026-08-29 @promote
test('TP-pages-016: a symlink escaping the pages root is not served (posix)', { skip: process.platform === 'win32' }, async () => {
  const { root } = makePagesRoot();
  fs.symlinkSync(path.join(path.dirname(root), 'outside-secret.txt'), path.join(root, 'fleet-app', 'link.txt'));
  const tok = await tokenFor(owner(root), 'fleet-app');
  const res = await request(anon(root)).get(`/pages-view/${tok}/fleet-app/link.txt`);
  assert.equal(res.status, 404);
  assert.ok(!String(res.text).includes('SECRET'));
});

// @plan:hub-pages-framework-core-2026-08-29 @promote
test('TP-pages-017: the guide keeps its shape — the graduated parser adds only an (empty) intro', async () => {
  const res = await request(makeApp({ authBypass: true })).get('/api/guide');
  assert.equal(res.status, 200);
  const { title, intro, sections } = res.body.guide;
  assert.equal(typeof title, 'string');
  assert.equal(intro, '', 'guide.md has no preamble — intro stays empty');
  assert.ok(Array.isArray(sections) && sections.length > 0);
});
