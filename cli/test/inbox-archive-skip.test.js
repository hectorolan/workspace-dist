// TP-convarch (ws plan get hub-conversation-archive-api-2026-08-17): the archived-
// conversation intake skip. CEO ruling 2026-08-17: archive means DROP — the inbox
// runner must not answer a waiting comment whose conversation is archived. The
// skip happens at selection time only (comment_state stays `waiting`, nothing is
// claimed or marked seen), so unarchiving restores eligibility with no restore
// machinery, and every skip is one loud line in the run's own log — never silent.
// Same live-server temp-DB harness as inbox.test.js.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SERVER = path.join(ROOT, 'server', 'server.js');
const PORT = 17790 + Math.floor(Math.random() * 1000);
const KEY = 'test-key-archive-skip';

/** @type {import('node:child_process').ChildProcess} */
let server;
/** @type {string} */
let dir;
/** @type {typeof import('../util/apiclient.js')} */
let api;
/** @type {typeof import('../util/inbox.js')} */
let inbox;

/** @param {string} p @param {object} [body] */
const post = (p, body) =>
  fetch(`http://127.0.0.1:${PORT}${p}`, {
    method: 'POST',
    headers: { 'X-Api-Key': KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
/** @param {string} p @param {object} body */
const patch = (p, body) =>
  fetch(`http://127.0.0.1:${PORT}${p}`, {
    method: 'PATCH',
    headers: { 'X-Api-Key': KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

/**
 * Post one page comment with its own unique subject, so each gets its own
 * conversation row; returns {id, conversationId}.
 * @param {string} ref @param {string} subject
 */
async function postComment(ref, subject) {
  const res = await post('/message', {
    kind: 'page-comment',
    subject,
    ref,
    body: '## Instruction\nDo the thing.\n',
    meta: JSON.stringify({ source: 'hub', pageType: 'conversations', slug: ref }),
  });
  assert.equal(res.status, 201);
  const json = await res.json();
  assert.ok(json.conversation && json.conversation.id > 0, `comment ${ref} joined a conversation`);
  return { id: json.id, conversationId: json.conversation.id };
}

before(async () => {
  dir = mkdtempSync(path.join(tmpdir(), 'ws-inbox-archive-'));
  process.env.LOG_API_URL = `http://127.0.0.1:${PORT}`;
  process.env.LOG_API_KEY = KEY;
  process.env.WORKSPACE_DIR = path.join(dir, 'workspace');
  process.env.WS_DATA_DIR = path.join(dir, 'data');
  mkdirSync(process.env.WORKSPACE_DIR, { recursive: true });
  mkdirSync(path.join(process.env.WS_DATA_DIR, 'inbox-tmp'), { recursive: true });
  api = await import('../util/apiclient.js');
  inbox = await import('../util/inbox.js');

  server = spawn(process.execPath, [SERVER], {
    env: {
      ...process.env,
      LOG_DB_PATH: path.join(dir, 'logs.db'),
      LOG_API_PORT: String(PORT),
      LOG_API_HOST: '127.0.0.1',
      LOG_API_KEY: KEY,
    },
    stdio: 'ignore',
  });
  for (let i = 0; i < 50; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/health`, { headers: { 'X-Api-Key': KEY } });
      if (res.ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('api server did not come up');
});

after(async () => {
  if (server && server.exitCode === null) {
    const exited = new Promise((r) => server.once('exit', r));
    server.kill();
    await exited;
  }
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* Windows can hold the DB file a beat after exit — temp cleanup is best-effort */
  }
});

test('TP-convarch-010: a waiting comment in an archived conversation is skipped loudly, state untouched', async () => {
  const a = await postComment('conv-1755400100010', 'Conversation: archived one (conversations/conv-1755400100010)');
  assert.equal((await patch(`/conversation/${a.conversationId}`, { status: 'archived' })).status, 200);

  /** @type {string[]} */
  const lines = [];
  const captured = await inbox.checkPageComments({ log: (l) => lines.push(l) });
  assert.deepEqual(captured, [], 'the archived-conversation comment is not captured');
  const skip = lines.find((l) => l.includes('conv-1755400100010'));
  assert.ok(skip, `expected a skip line, got: ${lines.join(' / ')}`);
  assert.match(skip, new RegExp(`conversation ${a.conversationId} is archived`));
  // Selection-time only: not seen, still waiting — nothing consumed.
  assert.equal((await api.seenIds()).has('conv-1755400100010'), false);
  const waiting = await api.listMessages({ kind: 'page-comment', state: 'waiting' });
  assert.ok(waiting.some((m) => m.ref === 'conv-1755400100010'), 'comment_state stayed waiting');
});

test('TP-convarch-011: unarchiving makes the same comment eligible again — the drop is reversible', async () => {
  const waiting = await api.listMessages({ kind: 'page-comment', state: 'waiting' });
  const row = waiting.find((m) => m.ref === 'conv-1755400100010');
  assert.ok(row, 'precondition: the comment is still waiting');
  assert.equal((await patch(`/conversation/${row.conversation_id}`, { status: 'active' })).status, 200);

  const captured = await inbox.checkPageComments();
  assert.deepEqual(captured.map((f) => path.basename(f, '.md')), ['conv-1755400100010']);
  await api.markSeen('conv-1755400100010', 'conv-1755400100010.md'); // no waiting leftovers
});

test('TP-convarch-012: archived-list fetch failure fails OPEN with a loud line — intake never blocks on the filter', async () => {
  await postComment('conv-1755400100012', 'Conversation: filter down (conversations/conv-1755400100012)');
  /** @type {string[]} */
  const lines = [];
  const captured = await inbox.checkPageComments({
    log: (l) => lines.push(l),
    listArchived: async () => { throw new Error('boom'); }, // test seam
  });
  assert.deepEqual(captured.map((f) => path.basename(f, '.md')), ['conv-1755400100012']);
  assert.ok(
    lines.some((l) => /archive/.test(l) && /boom|failed|inactive/.test(l)),
    `expected a loud filter-inactive line, got: ${lines.join(' / ')}`
  );
  await api.markSeen('conv-1755400100012', 'conv-1755400100012.md');
});

test('TP-convarch-013: mixed batch — active-conversation comments flow exactly as before, archived siblings skip', async () => {
  await postComment('conv-1755400100013', 'Conversation: stays active (conversations/conv-1755400100013)');
  const e = await postComment('conv-1755400100014', 'Conversation: gets archived (conversations/conv-1755400100014)');
  assert.equal((await patch(`/conversation/${e.conversationId}`, { status: 'archived' })).status, 200);

  /** @type {string[]} */
  const lines = [];
  const captured = await inbox.checkPageComments({ log: (l) => lines.push(l) });
  assert.deepEqual(captured.map((f) => path.basename(f, '.md')), ['conv-1755400100013']);
  assert.ok(lines.some((l) => l.includes('conv-1755400100014')), 'the sibling skip is recorded');
  await api.markSeen('conv-1755400100013', 'conv-1755400100013.md');
});
