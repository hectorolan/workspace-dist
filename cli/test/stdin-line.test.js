// TP-stdin-line: --stdin-line content source for plan-edit.mjs and backlog-add.js
// (see ws plan get test-plan-stdin-line). The hazard being closed: Windows
// PowerShell mangles embedded double quotes in native args before Node sees them
// (audit pages-program-audit-2026-08-29 BROKEN 3 — backlog items 79/84 truncated
// at the first embedded quote). Stdin is the shell-proof channel; these tests pin
// that quote-bearing content round-trips byte-for-byte.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const PLAN_EDIT = path.join(ROOT, 'cli', 'util-tools', 'plan-edit.mjs');
const BACKLOG_ADD = path.join(ROOT, 'cli', 'util-tools', 'backlog-add.js');

// The content whose argv journey used to truncate at the first embedded `"`.
// eslint-disable-next-line no-template-curly-in-string
const SPICY = '- item with "double quotes", \'singles\', `backticks` and $vars — intact';

/**
 * Minimal plan-API stub: GET /plan/:slug serves `served`, PUT /plan/:slug
 * records the submitted body into `puts` and answers ok. No real API, no DB.
 */
const stub = {
  /** @type {http.Server} */ server: /** @type {any} */ (null),
  port: 0,
  served: '',
  /** @type {Array<{slug: string, body: string}>} */ puts: [],
};

before(async () => {
  stub.server = http.createServer((req, res) => {
    const slug = decodeURIComponent((req.url || '').split('/').pop() || '');
    if (req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end(stub.served);
      return;
    }
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      stub.puts.push({ slug, body: JSON.parse(raw).body });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, line: `${slug} | plan | active | 2026-08-29 | stub` }));
    });
  });
  await new Promise((r) => stub.server.listen(0, '127.0.0.1', () => r(null)));
  stub.port = /** @type {import('node:net').AddressInfo} */ (stub.server.address()).port;
});

after(() => stub.server.close());

/**
 * Async spawn (NOT spawnSync — that blocks the event loop, and the stub server
 * lives in this same process, so a sync child would deadlock into the client's
 * 15s fetch timeout).
 * @param {string} tool @param {string[]} args @param {string} [input]
 * @returns {Promise<{status: number|null, stdout: string, stderr: string}>}
 */
function run(tool, args, input) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [tool, ...args], {
      env: { ...process.env, LOG_API_URL: `http://127.0.0.1:${stub.port}`, LOG_API_KEY: 'stub-key' },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (c) => { stdout += c; });
    child.stderr.setEncoding('utf8').on('data', (c) => { stderr += c; });
    child.on('error', reject);
    child.on('close', (status) => resolve({ status, stdout, stderr }));
    child.stdin.end(input ?? '');
  });
}

test('TP-stdin-line-001: plan-edit --replace-line --stdin-line stores quote-bearing content byte-for-byte', async () => {
  stub.served = '# s | plan | active | 2026-08-29 | T\n\n## List\n\n- old item\n- other\n';
  stub.puts = [];
  const r = await run(PLAN_EDIT, ['s', '--replace-line', 'old item', '--stdin-line'], SPICY + '\n');
  assert.equal(r.status, 0, r.stderr);
  assert.equal(stub.puts.length, 1);
  assert.equal(stub.puts[0].body, `## List\n\n${SPICY}\n- other`);
});

test('TP-stdin-line-002: plan-edit --append-to-section --stdin-line lands the stdin line intact at the section tail', async () => {
  stub.served = '# s | plan | active | 2026-08-29 | T\n\n## Alpha\n\n- a1\n\n## Beta\n\n- b1\n';
  stub.puts = [];
  const r = await run(PLAN_EDIT, ['s', '--append-to-section', 'Alpha', '--stdin-line'], SPICY + '\n');
  assert.equal(r.status, 0, r.stderr);
  assert.equal(stub.puts[0].body, `## Alpha\n\n- a1\n${SPICY}\n\n## Beta\n\n- b1`);
});

test('TP-stdin-line-003: stdin-line normalization — CRLF becomes LF, one trailing newline stripped, interior intact', async () => {
  stub.served = '# s | plan | active | 2026-08-29 | T\n\nkeep\ntarget\n';
  stub.puts = [];
  const r = await run(PLAN_EDIT, ['s', '--replace-line', 'target', '--stdin-line'], 'line "A"\r\n');
  assert.equal(r.status, 0, r.stderr);
  assert.equal(stub.puts[0].body, 'keep\nline "A"');
});

test('TP-stdin-line-004: plan-edit guards — --stdin-line with --with/--line/--stdin-body or without a mode exits 2, nothing written', async () => {
  stub.puts = [];
  const bad = [
    ['s', '--replace-line', 'x', '--stdin-line', '--with', 'y'], // both sources
    ['s', '--append-to-section', 'H', '--stdin-line', '--line', 'y'], // both sources
    ['s', '--stdin-body', '--stdin-line'], // stdin-body is a full-body mode
    ['s', '--stdin-line'], // no replace/append mode to feed
  ];
  for (const args of bad) {
    const r = await run(PLAN_EDIT, args, 'content\n');
    assert.equal(r.status, 2, args.join(' '));
    assert.match(r.stderr, /usage: node cli\/util-tools\/plan-edit\.mjs/);
  }
  assert.equal(stub.puts.length, 0);
});

// TP-stdin-line-005 (regression): argv forms unchanged — covered by the existing
// suite, TP-plan-edit-003/006/009/010 kept green in cli/test/plan-edit.test.js.

test('TP-stdin-line-008: a UTF-8 BOM on stdin is stripped by both tools — PowerShell pipes prepend one', async () => {
  const BOM = '﻿';
  stub.served = '# s | plan | active | 2026-08-29 | T\n\nkeep\ntarget\n';
  stub.puts = [];
  const r = await run(PLAN_EDIT, ['s', '--replace-line', 'target', '--stdin-line'], `${BOM}new "line"\n`);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(stub.puts[0].body, 'keep\nnew "line"');

  stub.served = '# backlog | plan | active | 2026-08-29 | Backlog\n\n## Awaiting the CEO\n\n- existing\n\n## Other\n';
  stub.puts = [];
  const b = await run(BACKLOG_ADD, ['--stdin-line'], `${BOM}bom item text\n`);
  assert.equal(b.status, 0, b.stderr);
  assert.ok(stub.puts[0].body.includes('- existing\n- bom item text\n'), stub.puts[0].body);
});

test('TP-stdin-line-006: backlog-add --stdin-line stores quote-bearing item text verbatim; stray-flag guard still applies', async () => {
  stub.served = '# backlog | plan | active | 2026-08-29 | Backlog\n\n## Awaiting the CEO\n\n- existing\n\n## Other\n';
  stub.puts = [];
  const spicyItem = SPICY.replace(/^- /, ''); // raw text, tool adds the bullet
  const r = await run(BACKLOG_ADD, ['--stdin-line'], spicyItem + '\n');
  assert.equal(r.status, 0, r.stderr);
  assert.equal(stub.puts.length, 1);
  assert.ok(stub.puts[0].body.includes(`- existing\n- ${spicyItem}\n`), stub.puts[0].body);

  stub.puts = [];
  const bad = await run(BACKLOG_ADD, ['--stdin-line'], '--help looks like a flag\n');
  assert.equal(bad.status, 2);
  assert.match(bad.stderr, /must not begin with a flag/);
  assert.equal(stub.puts.length, 0);
});

test('TP-stdin-line-007: backlog-add — positional text plus --stdin-line exits 2; plain argv path still inserts under Awaiting', async () => {
  stub.puts = [];
  const both = await run(BACKLOG_ADD, ['some text', '--stdin-line'], 'stdin text\n');
  assert.equal(both.status, 2);
  assert.match(both.stderr, /usage: backlog-add\.js/);
  assert.equal(stub.puts.length, 0);

  stub.served = '# backlog | plan | active | 2026-08-29 | Backlog\n\n## Awaiting the CEO\n\n- existing\n\n## Other\n';
  const r = await run(BACKLOG_ADD, ['plain argv item']);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(stub.puts[0].body.includes('- existing\n- plain argv item\n'), stub.puts[0].body);
});
