// TP-phase0: ws CLI surface (see ws plan get test-plan-phase0-scaffold)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const WS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'ws.js');

/** @param {string[]} args */
function run(args) {
  return spawnSync(process.execPath, [WS, ...args], { encoding: 'utf8' });
}

test('TP-phase0-004: no command prints usage with ported + pending lists, exit 2', () => {
  const r = run([]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /usage: node cli\/ws\.js/);
  assert.match(r.stderr, /ported: {2}pull/);
  assert.match(r.stderr, /ported:.*scheduler/);
  assert.match(r.stderr, /ported:.*run-job/);
  assert.match(r.stderr, /pending:.*boot/);
});

test('TP-phase0-005: unknown command prints usage, exit 2', () => {
  const r = run(['frobnicate']);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /usage: node cli\/ws\.js/);
});

test('TP-phase0-006: pending command points at the legacy script, exit 3', () => {
  const r = run(['boot']);
  assert.equal(r.status, 3);
  assert.match(r.stderr, /not ported yet/);
  assert.match(r.stderr, /entrypoint\.sh/);
});

test('TP-phase1-010: ws sync without a message prints usage, exit 2', () => {
  const r = run(['sync']);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /usage: ws sync/);
});

test('TP-ws-sync-paths-008: ws sync --paths guards — no message, or --paths with no paths, exit 2', () => {
  for (const args of [['sync', '--paths', 'cli/ws.js'], ['sync', 'chore: msg', '--paths']]) {
    const r = run(args);
    assert.equal(r.status, 2, args.join(' '));
    assert.match(r.stderr, /usage: ws sync <commit message> \[--paths/);
  }
});

test('TP-ci-guard-013: --no-guard is a flag, never part of the commit message', () => {
  // Stripped before the message is assembled: alone it leaves no message (usage,
  // exit 2), and the usage text advertises the escape hatch.
  const r = run(['sync', '--no-guard']);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /usage: ws sync <commit message> \[--paths .*\] \[--no-guard\]/);
});

// TP-plans-db: ws plan usage guards (see ws plan get test-plan-plans-db)
test('TP-plans-db-010: ws plan with no/unknown subcommand prints usage, exit 2', () => {
  for (const args of [['plan'], ['plan', 'frobnicate']]) {
    const r = run(args);
    assert.equal(r.status, 2, args.join(' '));
    assert.match(r.stderr, /usage: ws plan list/);
  }
});

test('TP-plans-db-011 / TP-audit-rem-021: ws plan get/set/history without slug or fields print usage, exit 2', () => {
  for (const args of [['plan', 'get'], ['plan', 'set'], ['plan', 'set', 'my-slug'], ['plan', 'history']]) {
    const r = run(args);
    assert.equal(r.status, 2, args.join(' '));
    assert.match(r.stderr, /usage: ws plan list/);
  }
});

test('TP-msgread-001: ws query --message-id rejects a non-numeric id, exit 2 (no API call)', () => {
  for (const id of ['abc', '3x', '']) {
    const r = run(['query', '--message-id', id]);
    assert.equal(r.status, 2, `id=${JSON.stringify(id)}`);
    assert.match(r.stderr, /usage: ws query --message-id <id>/);
  }
});

test('TP-msgread-002: ws msg usage points at the read command (write/read split is discoverable)', () => {
  const r = run(['msg']);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /msg WRITES a document/);
  assert.match(r.stderr, /ws query --message-id <id>/);
});

test('TP-plans-db-012: ws plan set with both --file and --body prints usage, exit 2', () => {
  const r = run(['plan', 'set', 'my-slug', '--file', 'x.md', '--body', 'y']);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /usage: ws plan list/);
});

// Identity for email tests is explicit (no code defaults since 2026-07-20), so
// these pass identically on the PC and in CI regardless of ambient env vars.
const MAIL_IDENTITY = { OWNER_EMAIL: 'owner@example.invalid', AGENT_EMAIL: 'agent@example.invalid' };

test('TP-phase1-011: ws email refuses without GMAIL_APP_PASSWORD, exit 2', () => {
  const r = spawnSync(process.execPath, [WS, 'email', '--subject', 's', '--body-path', 'x.md'], {
    encoding: 'utf8',
    env: { ...process.env, ...MAIL_IDENTITY, GMAIL_APP_PASSWORD: '' },
  });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /GMAIL_APP_PASSWORD/);
});

test('TP-phase1-012: ws email with a missing body file exits 3 (no send attempted)', () => {
  const r = spawnSync(process.execPath, [WS, 'email', '--subject', 's', '--body-path', 'definitely-missing.md'], {
    encoding: 'utf8',
    env: { ...process.env, ...MAIL_IDENTITY, GMAIL_APP_PASSWORD: 'placeholder' },
  });
  assert.equal(r.status, 3);
  assert.match(r.stderr, /Body file not found/);
});

test('TP-identity-001: ws email refuses when mail identity env is unset (no code defaults), exit 2', () => {
  const r = spawnSync(process.execPath, [WS, 'email', '--subject', 's', '--body-path', 'x.md'], {
    encoding: 'utf8',
    env: { ...process.env, OWNER_EMAIL: '', AGENT_EMAIL: '', GMAIL_APP_PASSWORD: 'placeholder' },
  });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /OWNER_EMAIL \/ AGENT_EMAIL/);
});
