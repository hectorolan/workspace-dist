'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const request = require('supertest');
const { makeApp, makeClaudeDir, startDigestStub } = require('./helpers');
const { configFromEnv } = require('../src/config');

const API_KEY = 'stub-api-key';

/**
 * 2026-07-24 audit remediation suite, adapted to the React refactor (central-DB
 * test plans hn-test-plan-2026-07-24-audit-remediation +
 * hn-test-plan-2026-07-26-react-refactor): HN-C stored XSS (server-side
 * sanitization now asserted on the /api html fields + strict CSP), HN-A
 * AUTH_BYPASS prod guard, plan `kind` normalization, HN-E/HN-F comment-box
 * hardening. The in-flight double-send guard (old TP-audit-remediation-011)
 * lives in the browser suite: TP-nexus-e2e-047 drives it in real chromium.
 */

/** Malicious markdown reused across content types (TP fixtures section). */
const EVIL_MD = [
  'Safe **bold** text and a [safe link](https://example.com/ok).',
  '',
  '<script>window.__pwned = 1;</script>',
  '',
  '<img src=x onerror="window.__pwned = 2">',
  '',
  '[click me](javascript:window.__pwned=3)',
].join('\n');

/** Asserts the payload is inert while legitimate markdown survived. */
function assertInert(html, label) {
  assert.ok(!html.includes('__pwned'), `${label}: script/handler payload must not render`);
  assert.ok(!/onerror/i.test(html), `${label}: event-handler attribute must be stripped`);
  assert.ok(!/javascript:/i.test(html), `${label}: javascript: URL must be stripped`);
  assert.match(html, /<strong>bold<\/strong>/, `${label}: legitimate markdown must survive`);
  assert.match(html, /href="https:\/\/example\.com\/ok"/, `${label}: safe links must survive`);
}

const PLANS = [
  { slug: 'p-plan', title: 'A plain plan', status: 'active', kind: 'plan', repo: null, updated_at: '2026-07-23T10:00:00Z', body_length: 40 },
  { slug: 'p-legacy', title: 'A legacy row', status: 'active', repo: null, updated_at: '2026-07-20T10:00:00Z', body_length: 40 },
];

const BODIES = {
  'p-plan': { ...PLANS[0], body: EVIL_MD },
  'p-legacy': { ...PLANS[1], body: 'Legacy body.' },
};

const CONVERSATION = {
  conversation: { id: 7, title: 'Evil thread', created_at: '2026-07-20T10:00:00Z' },
  messages: [
    { id: 1, kind: 'inbox-request', date: '2026-07-20', ts: '2026-07-20T10:00:00Z', body: EVIL_MD },
  ],
};

/** Stub log API: /plan, /plan/:slug, /conversation/:id. */
function startStubApi({ plans = PLANS, bodies = BODIES } = {}) {
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    res.setHeader('Content-Type', 'application/json');
    const m = u.pathname.match(/^\/plan\/([^/]+)$/);
    if (m) {
      const p = bodies[decodeURIComponent(m[1])];
      if (!p) { res.statusCode = 404; return res.end(JSON.stringify({ ok: false })); }
      return res.end(JSON.stringify({ ok: true, plan: p }));
    }
    if (u.pathname === '/plan') {
      let rows = plans;
      const s = u.searchParams.get('status');
      if (s) rows = rows.filter((p) => p.status === s);
      return res.end(JSON.stringify({ ok: true, count: rows.length, entries: rows }));
    }
    if (u.pathname === `/conversation/${CONVERSATION.conversation.id}`) {
      return res.end(JSON.stringify(CONVERSATION));
    }
    res.statusCode = 404;
    res.end(JSON.stringify({ ok: false }));
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({ url: `http://127.0.0.1:${server.address().port}`, close: () => server.close() });
    });
  });
}

const appFor = (stubUrl, overrides = {}) =>
  makeApp({ authBypass: true, logApiUrl: stubUrl, logApiKey: API_KEY, ...overrides });

test('TP-audit-remediation-001 / TP-react-019: malicious markdown in a plan body renders inert', async () => {
  const stub = await startStubApi();
  try {
    const res = await request(appFor(stub.url)).get('/api/plans/p-plan');
    assert.equal(res.status, 200);
    assertInert(res.body.plan.html, 'plan');
  } finally {
    stub.close();
  }
});

test('TP-audit-remediation-002: malicious markdown in a conversation message renders inert', async () => {
  const stub = await startStubApi();
  try {
    const res = await request(appFor(stub.url)).get('/api/conversations/7');
    assert.equal(res.status, 200);
    assertInert(res.body.messages[0].html, 'conversation');
  } finally {
    stub.close();
  }
});

test('TP-audit-remediation-003: malicious digest renders inert; a plain https image is kept', async () => {
  const body = `${EVIL_MD}\n\n<img src="https://example.com/pic.png" alt="pic">\n`;
  const stub = await startDigestStub({
    entries: [{ id: 1, date: '2026-01-01', kind: 'daily-digest', subject: 'Daily Digest — 2026-01-01', ref: '2026-01-01' }],
    bodies: { 1: body },
  });
  try {
    const res = await request(appFor(stub.url)).get('/api/digests/2026-01-01');
    assert.equal(res.status, 200);
    assertInert(res.body.digest.html, 'digest');
    assert.match(res.body.digest.html, /<img src="https:\/\/example\.com\/pic\.png"/, 'handler-free image must survive');
  } finally {
    stub.close();
  }
});

test('TP-audit-remediation-004: malicious agent/skill/knowledge markdown renders inert', async () => {
  const dir = makeClaudeDir();
  fs.writeFileSync(path.join(dir, 'agents', 'alpha.md'), `---\nname: alpha\ndescription: "evil agent"\n---\n\n${EVIL_MD}\n`);
  fs.writeFileSync(path.join(dir, 'skills', 'skill-one', 'SKILL.md'), `---\nname: skill-one\ndescription: evil skill\n---\n\n${EVIL_MD}\n`);
  fs.writeFileSync(path.join(dir, 'CLAUDE.md'), `# Conventions\n\n${EVIL_MD}\n`);
  const app = makeApp({ authBypass: true, workspaceClaudeDir: dir });
  const agent = await request(app).get('/api/agents/alpha');
  assertInert(agent.body.agent.html, 'agent');
  const skill = await request(app).get('/api/skills/skill-one');
  assertInert(skill.body.skill.html, 'skill');
  const knowledge = await request(app).get('/api/knowledge/claude-md');
  assertInert(knowledge.body.doc.html, 'knowledge');
});

test('TP-audit-remediation-005 / TP-react-008: strict CSP — script-src and style-src are self alone; no inline scripts in the shell', async () => {
  const app = makeApp({ authBypass: true });
  for (const url of ['/', '/api/agents']) {
    const res = await request(app).get(url);
    const csp = res.headers['content-security-policy'];
    assert.ok(csp, `CSP header must be set on ${url}`);
    assert.match(csp, /script-src 'self'(;|$| )/, 'scripts restricted to self — no nonce needed, none allowed inline');
    assert.ok(!/script-src[^;]*'unsafe-inline'/.test(csp), 'no unsafe-inline for scripts');
    assert.ok(!/script-src[^;]*nonce/.test(csp), 'the nonce era is over — nothing may re-widen script-src');
    assert.match(csp, /style-src 'self'(;|$| )/, 'styles restricted to self');
    assert.ok(!/style-src[^;]*'unsafe-inline'/.test(csp), 'no unsafe-inline for styles');
    assert.match(csp, /object-src 'none'/);
    assert.match(csp, /frame-ancestors 'none'/);
  }
  const shell = await request(app).get('/');
  assert.ok(!/<script(?![^>]*src=)/.test(shell.text), 'the served shell must contain no inline script');
});

test('TP-audit-remediation-006: AUTH_BYPASS=true with an https:// BASE_URL refuses to start', () => {
  const prodEnv = { BASE_URL: 'https://ho-nexus.westus2.cloudapp.azure.com', AUTH_BYPASS: 'true' };
  assert.throws(() => configFromEnv(prodEnv), /AUTH_BYPASS/);
  assert.ok(configFromEnv({ BASE_URL: 'http://localhost:8080', AUTH_BYPASS: 'true' }).authBypass);
  assert.equal(configFromEnv({ BASE_URL: 'https://ho-nexus.westus2.cloudapp.azure.com' }).authBypass, false);
});

test('TP-audit-remediation-007: missing kind field means "plan" on index and detail', async () => {
  const stub = await startStubApi();
  try {
    const app = appFor(stub.url);
    const index = await request(app).get('/api/plans');
    const legacyRow = index.body.plans.find((p) => p.slug === 'p-legacy');
    assert.equal(legacyRow.kind, 'plan', 'missing kind must default to plan on the index');
    const detail = await request(app).get('/api/plans/p-legacy');
    assert.equal(detail.body.plan.kind, 'plan', 'missing kind must default to plan on the detail');
  } finally {
    stub.close();
  }
});

test('TP-audit-remediation-009: instruction hard cap at 20000 chars; the 400 message states the limit', async () => {
  const stub = await startStubApi();
  try {
    const res = await request(appFor(stub.url))
      .post('/api/page-comments')
      .set('Content-Type', 'application/json')
      .send({ pageType: 'plans', slug: 'p-plan', instruction: 'x'.repeat(20001) });
    assert.equal(res.status, 400);
    assert.match(res.body.error, /20000|20,000/, 'the limit must be stated to the user');
  } finally {
    stub.close();
  }
});

test('TP-audit-remediation-010: oversized (>64kb) and malformed bodies get JSON-shaped errors', async () => {
  const stub = await startStubApi();
  try {
    const app = appFor(stub.url);
    const big = await request(app)
      .post('/api/page-comments')
      .set('Content-Type', 'application/json')
      .send({ pageType: 'plans', slug: 'p-plan', instruction: 'x'.repeat(70000) });
    assert.equal(big.status, 413);
    assert.match(big.headers['content-type'], /application\/json/, '413 must be JSON, not the Express HTML default');
    assert.equal(big.body.ok, false);
    assert.ok(big.body.error, '413 must explain itself');
    const bad = await request(app)
      .post('/api/page-comments')
      .set('Content-Type', 'application/json')
      .send('{"broken');
    assert.equal(bad.status, 400);
    assert.match(bad.headers['content-type'], /application\/json/);
    assert.equal(bad.body.ok, false);
  } finally {
    stub.close();
  }
});
