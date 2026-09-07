'use strict';

// Home > Guide: the packaged user manual served by GET /api/guide
// (design hub-home-custom-pages-design Part 1, phase 1; central-DB test plan
// hub-home-restructure-2026-08-29). The manual is src/content/guide.md split
// into ## sections server-side; every body renders through the one
// sanitization pipeline, and anchor ids never live inside the HTML — the
// client owns them on wrapper elements.

const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { makeApp } = require('./helpers');
const { parseGuide } = require('../src/lib/guide');

const asOwner = (overrides = {}) => makeApp({ authBypass: true, ...overrides });

// @plan:hub-home-restructure-2026-08-29 @promote
test('TP-home-001: GET /api/guide serves the manual — title plus unique slug-shaped sections', async () => {
  const res = await request(asOwner()).get('/api/guide');
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
  const { title, sections } = res.body.guide;
  assert.equal(typeof title, 'string');
  assert.ok(title.length > 0);
  assert.ok(Array.isArray(sections) && sections.length > 0, 'sections must be a non-empty array');
  const ids = sections.map((s) => s.id);
  for (const s of sections) {
    assert.equal(typeof s.id, 'string');
    assert.equal(typeof s.title, 'string');
    assert.equal(typeof s.html, 'string');
    assert.match(s.id, /^[a-z0-9-]+$/, `slug-shaped id, got "${s.id}"`);
  }
  assert.equal(new Set(ids).size, ids.length, 'section ids must be unique');
});

// @plan:hub-home-restructure-2026-08-29 @promote
test('TP-home-002: section html is sanitized rendered markdown with no embedded anchor ids', async () => {
  const res = await request(asOwner()).get('/api/guide');
  const { sections } = res.body.guide;
  // Rendered markdown, not source: at least one section carries block markup.
  assert.ok(
    sections.some((s) => /<(p|ul|blockquote)>/.test(s.html)),
    'sections must contain rendered HTML'
  );
  for (const s of sections) {
    assert.ok(!/<script/i.test(s.html), 'no script tags');
    assert.ok(!/\sid=/.test(s.html), 'anchor ids live on client wrappers, never inside sanitized html');
    // The client renders the heading itself: the body must not repeat it.
    assert.ok(!/<h2>/.test(s.html), 'section heading is stripped from the body');
  }
  // The pipeline holds against hostile source too (same posture as digests).
  const parsed = parseGuide('# T\n\n## Evil\n\n<script>alert(1)</script>\n\n<a href="javascript:x()">j</a>\n');
  assert.ok(!/<script/i.test(parsed.sections[0].html));
  assert.ok(!/javascript:/i.test(parsed.sections[0].html));
});

// @plan:hub-guide-ask-orchestrator-2026-08-29 @promote
// (TP-guide4-001/002, amending TP-widg-011's amendment of TP-pages-018/TP-home-003
// to the final truth: phase 4 filled the ask-the-orchestrator section, so no
// "Coming in a later phase" stub marker remains anywhere in the guide.)
test('TP-home-003: every guide section is filled — no stub markers remain, tier 1/2/3 onboarding intact', async () => {
  const res = await request(asOwner()).get('/api/guide');
  const { sections } = res.body.guide;
  const byId = Object.fromEntries(sections.map((s) => [s.id, s]));
  // TP-guide4-002: the last stub fell with phase 4 — nowhere in the manual.
  for (const s of sections) {
    assert.doesNotMatch(s.html, /Coming in a later phase/, `stub marker left in section ${s.id}`);
  }
  // TP-guide4-001: the ask-the-orchestrator path is documented for real —
  // asking, folder/tab delivery, the audit trail, the conversational loop.
  const ask = byId['ask-the-orchestrator-agent-built-pages'];
  assert.ok(ask, 'expected the ask-the-orchestrator section');
  assert.match(ask.html, /pages folder/);
  assert.match(ask.html, /audit trail/);
  assert.match(ask.html, /review/i);
  // The shipped tiers carry their five-minute walks, not placeholders.
  assert.ok(byId['tier-1-markdown-pages']);
  assert.doesNotMatch(byId['tier-1-markdown-pages'].html, /Coming in a later phase/);
  assert.match(byId['tier-1-markdown-pages'].html, /index\.md/);
  // Tier 2: the five-minute walk plus the whole catalog, documented by name.
  assert.ok(byId['tier-2-widget-layouts']);
  assert.doesNotMatch(byId['tier-2-widget-layouts'].html, /Coming in a later phase/);
  assert.match(byId['tier-2-widget-layouts'].html, /index\.json/);
  for (const widget of ['digest-list', 'plan-list', 'plan-view', 'feature-cells', 'stat-tiles']) {
    assert.match(byId['tier-2-widget-layouts'].html, new RegExp(widget), `guide documents ${widget}`);
  }
  assert.ok(byId['tier-3-full-html-js-sites']);
  assert.doesNotMatch(byId['tier-3-full-html-js-sites'].html, /Coming in a later phase/);
  assert.match(byId['tier-3-full-html-js-sites'].html, /index\.html/);
  assert.match(byId['tier-3-full-html-js-sites'].html, /sandbox/i);
  // The framework intro documents the one setting that turns pages on.
  assert.match(byId['custom-pages-build-your-own-tabs'].html, /HUB_PAGES_DIR/);
  // The real phase-1 content is present alongside: the hub's surfaces.
  for (const id of ['what-the-hub-is', 'home-digests-and-this-guide']) {
    assert.ok(byId[id], `expected section ${id}`);
  }
});

// @plan:hub-home-restructure-2026-08-29 @promote
test('TP-home-004: /api/guide sits behind the auth wall', async () => {
  const denied = await request(makeApp()).get('/api/guide');
  assert.equal(denied.status, 401);
  assert.equal(denied.body.ok, false);
  const allowed = await request(asOwner()).get('/api/guide');
  assert.equal(allowed.status, 200);
});
