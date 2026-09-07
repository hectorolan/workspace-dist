'use strict';

// Doc-truth guards for the pages-program audit remediation (central-DB test
// plan hub-pages-audit-remediation-2026-08-29; audit
// pages-program-audit-2026-08-29). These are cheap grep-style checks that keep
// the repo's own docs in sync with the code facts the audit caught drifting:
// the auth surface, the env-var table, and the widget caps.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// CRLF-normalized so the regexes hold on every checkout.
const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8').replace(/\r\n/g, '\n');

// @plan:hub-pages-audit-remediation-2026-08-29 @promote
test('TP-par-001: README and CLAUDE.md name every public surface mounted above the auth wall', () => {
  const appSrc = read('src/app.js');
  // The code fact the docs must track: pagesViewRouter mounts BEFORE requireAuth.
  const viewMount = appSrc.indexOf('app.use(pagesViewRouter(config))');
  const wall = appSrc.indexOf('app.use(requireAuth(config))');
  assert.ok(viewMount !== -1 && wall !== -1, 'expected both mounts in src/app.js');
  assert.ok(viewMount < wall, 'pagesViewRouter must mount above the requireAuth wall');
  // Every above-the-wall surface, named in both docs' auth zones.
  for (const doc of ['README.md', 'CLAUDE.md']) {
    const text = read(doc);
    for (const surface of ['/healthz', '/public', '/auth', '/pages-view']) {
      assert.ok(text.includes(surface), `${doc} must name the public surface ${surface}`);
    }
  }
});

// @plan:hub-pages-audit-remediation-2026-08-29 @promote
test('TP-par-002: every env var declared in .env.example appears in the README env table', () => {
  const readme = read('README.md');
  const vars = read('.env.example')
    .split('\n')
    .map((l) => (/^([A-Z][A-Z0-9_]*)=/.exec(l) || [])[1])
    .filter(Boolean);
  assert.ok(vars.length >= 8, `expected the full var roster, got ${vars.length}`);
  for (const v of vars) {
    assert.ok(readme.includes(v), `README env table must document ${v}`);
  }
});

// @plan:hub-pages-audit-remediation-2026-08-29 @promote
test('TP-par-003: the Guide documents the widget caps with the same numbers as page-widgets.js', () => {
  const src = read('src/lib/page-widgets.js');
  const cap = (name) => {
    const m = new RegExp(`const ${name} = (\\d+);`).exec(src);
    assert.ok(m, `expected ${name} constant in src/lib/page-widgets.js`);
    return m[1];
  };
  const guide = read('src/content/guide.md');
  const tier2 = guide.split(/^## /m).find((s) => s.startsWith('Tier 2'));
  assert.ok(tier2, 'expected the Tier 2 guide section');
  for (const [name, phrase] of [
    ['MAX_WIDGETS', 'widgets'],
    ['MAX_TILES', 'tiles'],
    ['MAX_FEATURE_IDS', 'feature ids'],
  ]) {
    const n = cap(name);
    assert.ok(
      new RegExp(`${n}[^.]*${phrase}|${phrase}[^.]*${n}`).test(tier2),
      `guide tier-2 section must state the ${phrase} cap of ${n}`
    );
  }
});

// @plan:hub-pages-audit-remediation-2026-08-29 @throwaway
test('TP-par-004: no legacy "feature #N" navigation label remains in CLAUDE.md', () => {
  assert.doesNotMatch(read('CLAUDE.md'), /feature #\d/i);
});

// @plan:hub-pages-audit-remediation-2026-08-29 @throwaway
test('TP-par-005: README documents the pages program surfaces', () => {
  const readme = read('README.md');
  // "What it shows" rows for the program's three surfaces.
  assert.match(readme, /\| Home · Guide \| `\/guide` \|/);
  assert.match(readme, /`\/pages\/:slug`/);
  assert.match(readme, /`\/pages-view\/:token\/:slug\/\*`/);
  // The Home row's superseded "no nav tab lit" claim is gone: / lights Home.
  assert.doesNotMatch(readme, /no nav\s+tab lit|lights no nav/);
  assert.match(readme, /lights the Home tab/);
  // The production paragraph carries the pages-root mount.
  assert.match(readme, /HUB_PAGES_DIR/);
});

// @plan:hub-pages-audit-remediation-2026-08-29 @throwaway
test('TP-par-006: the compose deploy note carries the pages-root prod-override lines', () => {
  const compose = read('docker-compose.yml');
  const note = compose.slice(0, compose.indexOf('services:'));
  assert.match(note, /HUB_PAGES_DIR/);
  assert.match(note, /agent\/hub\/pages/);
});

// @plan:hub-pages-audit-remediation-2026-08-29 @throwaway
test('TP-par-007: the CHANGELOG #59 entry names the two amended test files', () => {
  const changelog = read('CHANGELOG.md');
  const entry = /"Ask the orchestrator" section is filled[\s\S]*?\n\n- \*\*/.exec(changelog);
  assert.ok(entry, 'expected the PR #59 changelog entry');
  assert.doesNotMatch(entry[0], /Content-only/);
  assert.match(entry[0], /test\/guide\.test\.js/);
  assert.match(entry[0], /e2e\/pages\.spec\.js/);
});
