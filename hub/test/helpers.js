'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { createApp } = require('../src/app');

const SAMPLE = (date) => `# Daily Digest — ${date}

## World brief

- **Something happened** in the world. [Read more](https://example.com/story)
- Another bullet item.

## Tech news

Plain paragraph with **bold text** and a [link](https://example.com/tech).
`;

/**
 * Default digest fixtures for the DB-backed Digests section (digests now live in the
 * `daily-digest` message kind, not files). Refs deliberately cover BOTH real-world
 * shapes: a bare `YYYY-MM-DD` (rows imported 07-10..07-17) and a
 * `YYYY-MM-DD-daily-digest` (runner-stored rows). Same three dates + same SAMPLE
 * markdown as the file era, so every rendering assertion carries over unchanged.
 */
const DIGEST_ENTRIES = [
  { id: 101, ts: '2026-01-01T07:00:00Z', date: '2026-01-01', kind: 'daily-digest', subject: 'Daily Digest — 2026-01-01', ref: '2026-01-01' },
  { id: 102, ts: '2026-01-02T07:00:00Z', date: '2026-01-02', kind: 'daily-digest', subject: 'Daily Digest — 2026-01-02', ref: '2026-01-02-daily-digest' },
  { id: 103, ts: '2026-01-03T07:00:00Z', date: '2026-01-03', kind: 'daily-digest', subject: 'Daily Digest — 2026-01-03', ref: '2026-01-03-daily-digest' },
];

/** The `GET /message/:id` text shape the server emits (server.js msgLine header). */
function digestDetailText(entry, body) {
  const line = `${entry.id} | ${entry.date} | ${entry.kind || 'daily-digest'} | ${entry.subject || '-'} | ${entry.ref || '-'} | ${body.length} chars`;
  return `# ${line}\n\n${body}\n`;
}

/**
 * A composable request handler for the two digest log-API endpoints
 * (`GET /message?kind=daily-digest&format=json`, `GET /message/:id`). Returns a
 * function `(req, res, u) => handled:boolean` so suites that already run a plan/
 * conversation stub can delegate digest requests to it. Bodies default to the SAMPLE
 * markdown keyed by entry id; pass `bodies` to inject custom content (e.g. malicious
 * markdown for the sanitizer regression).
 */
function digestStubHandler({ entries = DIGEST_ENTRIES, bodies } = {}) {
  const bodyFor = bodies || Object.fromEntries(entries.map((e) => [e.id, SAMPLE(e.date)]));
  return function handle(req, res, u) {
    if (u.pathname === '/message' && u.searchParams.get('kind') === 'daily-digest') {
      const limit = Math.min(Number(u.searchParams.get('limit') || 20), 200);
      // Mirror the server: newest ids first, capped at limit, then ascending.
      const rows = entries
        .slice()
        .sort((a, b) => b.id - a.id)
        .slice(0, limit)
        .reverse()
        .map((e) => ({ ...e, body_length: (bodyFor[e.id] || '').length }));
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ ok: true, count: rows.length, entries: rows }));
      return true;
    }
    const m = u.pathname.match(/^\/message\/(\d+)$/);
    if (m && req.method === 'GET') {
      const e = entries.find((x) => String(x.id) === m[1]);
      res.setHeader('Content-Type', 'text/plain');
      if (!e) { res.statusCode = 404; res.end('not found\n'); return true; }
      res.end(digestDetailText(e, bodyFor[e.id] || ''));
      return true;
    }
    return false;
  };
}

/** Standalone digest log-API stub (the Digests suite talks only to this). */
function startDigestStub(opts = {}) {
  const handle = digestStubHandler(opts);
  const seen = [];
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    seen.push({ method: req.method, path: u.pathname, kind: u.searchParams.get('kind'), key: req.headers['x-api-key'] });
    if (handle(req, res, u)) return;
    res.statusCode = 404;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ ok: false }));
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ url: `http://127.0.0.1:${server.address().port}`, seen, close: () => server.close() }));
  });
}

const AGENT_MD = (name, model) => `---
name: ${name}
description: "${name} agent: does ${name} things for tests"
tools: Read, Write, Bash
model: ${model}
---

You are the ${name} agent.

## Rules for ${name}

- **Bold rule** for ${name}.
- Second rule.
`;

/**
 * Block-scalar frontmatter variants, mirroring real skills (cicd-pipeline-skill and
 * jest-skill use `description: >`, cloud-solution-architect uses `>-`): the fixture
 * tree must exercise them so the sanity net (TP-readme-summ-013) means something.
 */
const AGENT_MD_FOLDED = `---
name: beta
description: >
  beta agent: does beta things for tests,
  folded across two source lines.
tools: Read, Write, Bash
model: opus
---

You are the beta agent.

## Rules for beta

- **Bold rule** for beta.
- Second rule.
`;

const SKILL_MD_FOLDED_STRIP = `---
name: skill-two
description: >-
  The skill-two skill, used whenever tests need skill-two,
  folded across two source lines.
---

# skill-two skill

## How skill-two works

Plain paragraph with **bold text** about skill-two.
`;

const SKILL_MD = (name) => `---
name: ${name}
description: The ${name} skill, used whenever tests need ${name}.
---

# ${name} skill

## How ${name} works

Plain paragraph with **bold text** about ${name}.
`;

/**
 * Create a temp .claude-shaped fixture tree (agents, skills, knowledge docs).
 * See central-DB test plan hn-test-plan-2026-07-22-agents-skills-pages "Fixtures".
 */
/**
 * The .claude/README.md index tables the summary parser reads (TP-readme-summ-*).
 * Rows exist for `alpha` and `skill-one` only — `beta` and `skill-two` exercise the
 * frontmatter-description fallback in place. skill-one's cell carries markdown
 * (bold, code span, link) and an escaped pipe, matching the real README's hygiene rule.
 */
const README_MD = `# Fixture .claude index

## Agents

| Agent | Model | Role |
|---|---|---|
| \`alpha\` | fable | Curated alpha role from the README table. |

## Skills

| Skill | Origin | What it does |
|---|---|---|
| \`skill-one\` | workspace | Curated **skill-one** summary with a \\| pipe, \`code\`, and a [link](https://example.com). |
`;

function makeClaudeDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-claude-'));
  fs.writeFileSync(path.join(dir, 'README.md'), README_MD);
  fs.mkdirSync(path.join(dir, 'agents'));
  fs.writeFileSync(path.join(dir, 'agents', 'README.md'), '# not an agent — must be skipped');
  fs.writeFileSync(path.join(dir, 'agents', 'alpha.md'), AGENT_MD('alpha', 'fable'));
  fs.writeFileSync(path.join(dir, 'agents', 'beta.md'), AGENT_MD_FOLDED); // block-scalar case
  fs.mkdirSync(path.join(dir, 'skills', 'skill-one'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'skills', 'skill-one', 'SKILL.md'), SKILL_MD('skill-one'));
  fs.mkdirSync(path.join(dir, 'skills', 'skill-two'));
  fs.writeFileSync(path.join(dir, 'skills', 'skill-two', 'SKILL.md'), SKILL_MD_FOLDED_STRIP); // block-scalar case
  fs.mkdirSync(path.join(dir, 'skills', 'no-skill-here')); // no SKILL.md — must be skipped
  fs.writeFileSync(path.join(dir, 'skills', 'notes.md'), '# stray file — must be ignored');
  fs.writeFileSync(path.join(dir, 'CLAUDE.md'), '# Workspace conventions\n\n## Logging rule\n\nAlways **log** everything.\n');
  fs.writeFileSync(path.join(dir, 'SETUP.md'), '# Setup checklist\n\n## Access\n\n- gh auth done.\n');
  return dir;
}

const BASE_CONFIG = {
  clientId: 'test-client-id.apps.googleusercontent.com',
  clientSecret: 'test-client-secret',
  baseUrl: 'http://localhost:8080',
  sessionSecret: 'test-session-secret',
  authBypass: false,
  // Fixture identities only (CEO-is-config, hn-ceo-is-config-2026-08-15): no
  // test anywhere carries a real person's email or name.
  allowedEmail: 'owner@example.com',
  authBypassEmail: 'owner@example.com',
};

/**
 * Instance-identity fixture + stub handler (GET /identity) for suites whose stub
 * log API feeds identity-rendered surfaces (conversation speaker labels, the
 * /api/identity route). Fixture values on purpose — assertions key on THESE
 * (TP-ceoconf-009/010/011).
 */
const IDENTITY_FIXTURE = Object.freeze({ name: 'Fixture Owner', pronouns: 'they/them', hubTitle: 'Fixture Hub' });

function identityStubHandler(req, res, u) {
  if (u.pathname !== '/identity' || req.method !== 'GET') return false;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify({ ok: true, identity: IDENTITY_FIXTURE }));
  return true;
}

/**
 * A dist/-shaped fixture (index.html only) so the SPA fallback can serve a shell
 * without running a real `vite build` in the unit suite (TP-react-007). The
 * marker text lets tests assert THIS file was served.
 */
const DIST_INDEX_MARKER = 'hub spa shell fixture';
function makeDistDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-dist-'));
  fs.writeFileSync(
    path.join(dir, 'index.html'),
    `<!doctype html><html><head><title>hub</title></head><body><div id="root"></div><!-- ${DIST_INDEX_MARKER} --></body></html>`
  );
  return dir;
}

/** Build an app instance for tests. */
function makeApp(overrides = {}) {
  const workspaceClaudeDir = overrides.workspaceClaudeDir || makeClaudeDir();
  const distDir = overrides.distDir || makeDistDir();
  return createApp({ ...BASE_CONFIG, workspaceClaudeDir, distDir, ...overrides });
}

module.exports = {
  makeApp,
  makeClaudeDir,
  makeDistDir,
  DIST_INDEX_MARKER,
  BASE_CONFIG,
  IDENTITY_FIXTURE,
  identityStubHandler,
  SAMPLE,
  DIGEST_ENTRIES,
  digestStubHandler,
  startDigestStub,
};
