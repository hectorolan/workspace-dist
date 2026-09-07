// TP-phase1: the ws log-API client end-to-end against a real server/server.js on a
// temp DB (see ws plan get test-plan-phase1-clients)
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { today } from '../util/clock.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const WS = path.join(ROOT, 'cli', 'ws.js');
const SERVER = path.join(ROOT, 'server', 'server.js');
const PORT = 18790 + Math.floor(Math.random() * 1000);
const KEY = 'test-key';

/** @type {import('node:child_process').ChildProcess} */
let server;
/** @type {string} */
let dir;

/**
 * @param {string[]} args
 * @param {Record<string, string>} [env]
 */
function ws(args, env = {}) {
  return spawnSync(process.execPath, [WS, ...args], {
    encoding: 'utf8',
    env: { ...process.env, LOG_API_URL: `http://127.0.0.1:${PORT}`, LOG_API_KEY: KEY, ...env },
  });
}

before(async () => {
  dir = mkdtempSync(path.join(tmpdir(), 'ws-api-'));
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
  // The apiclient module (imported dynamically in TP-logs-retirement-004b) reads
  // LOG_API_URL/KEY at load time — point it at this test server before that import.
  process.env.LOG_API_URL = `http://127.0.0.1:${PORT}`;
  process.env.LOG_API_KEY = KEY;
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
  const exited = new Promise((r) => server.once('exit', r));
  server.kill();
  await exited;
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* Windows can hold the DB file a beat after exit — temp cleanup is best-effort */
  }
});

test('TP-phase1-001: ws health reports ok', () => {
  const r = ws(['health']);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /"ok":\s*true/);
});

test('TP-phase1-002: ws log stores an audit line the API echoes back', () => {
  const r = ws(['log', '-r', 'workspace', '-a', 'tester', 'phase1', 'done', 'client test line']);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /phase1 \| done \| client test line/);
});

test('TP-phase1-003: ws query reads the line back', () => {
  const r = ws(['query', '--repo', 'workspace', '--days', '1']);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /client test line/);
});

test('TP-phase1-004: ws msg stores a document; ws query --messages finds it', () => {
  const body = path.join(dir, 'doc.md');
  writeFileSync(body, '# a report\n');
  const r = ws(['msg', 'report', 'Phase 1 doc', 'phase1-doc', body]);
  assert.equal(r.status, 0);
  const q = ws(['query', '--messages', '--kind', 'report', '--days', '1']);
  assert.match(q.stdout, /Phase 1 doc/);
});

test('TP-phase1-005: ws email-out derives the date+slug ref like the legacy clients', () => {
  const body = path.join(dir, 'mail.md');
  writeFileSync(body, 'mail body\n');
  const r = ws(['email-out', 'Hello: World!', body]);
  assert.equal(r.status, 0);
  const date = today(); // schedule-timezone date, matching the client's ref derivation
  assert.match(r.stdout, new RegExp(`${date}-Hello-World`));
});

test('TP-phase1-006 / TP-logs-retirement-004: ws log falls back to <data>/fallback/log.md when the API is down, exit 0', () => {
  const fake = mkdtempSync(path.join(tmpdir(), 'ws-fallback-'));
  try {
    const r = ws(['log', 'area', 'failed', 'offline line'], {
      LOG_API_URL: 'http://127.0.0.1:1',
      WS_DATA_DIR: fake, // fallback now lives in the per-machine data dir, not the repo
    });
    assert.equal(r.status, 0);
    assert.match(r.stderr, /appended to/);
    // the client creates the fallback directory itself — nothing may be lost
    const md = path.join(fake, 'fallback', 'log.md');
    assert.ok(existsSync(md));
    assert.match(readFileSync(md, 'utf8'), /area \| failed \| offline line/);
  } finally {
    rmSync(fake, { recursive: true, force: true });
  }
});

test('TP-phase1-007: ws msg fails loudly (exit 1) when the API is down — no silent loss', () => {
  const body = path.join(dir, 'doc2.md');
  writeFileSync(body, 'x');
  const r = ws(['msg', 'report', 's', 'r', body], { LOG_API_URL: 'http://127.0.0.1:1' });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /file remains the source of truth/);
});

test('TP-logs-retirement-004b: replayFallback drains <data>/fallback/log.md into the API and archives it', async () => {
  // Relocated from the retired migration-tool test suite. Complements TP-phase1-006 (which
  // covers the WRITE side — falling back to the file when the API is down); this covers
  // the DRAIN side — `ws pull` replaying the queued lines back into the API.
  const fake = mkdtempSync(path.join(tmpdir(), 'ws-replay-'));
  const prevData = process.env.WS_DATA_DIR;
  try {
    process.env.WS_DATA_DIR = fake; // fallbackLog() resolves under WS_DATA_DIR at call time
    const api = await import('../util/apiclient.js');
    const fb = path.join(fake, 'fallback', 'log.md');
    mkdirSync(path.dirname(fb), { recursive: true });
    writeFileSync(fb, '# header line\n2026-07-22 | replay-area | done | first replayed line\n2026-07-22 | replay-area | done | second replayed line\n', 'utf8');

    const r = await api.replayFallback();
    assert.equal(r.status, 'replayed');
    assert.equal(r.replayed, 2);
    assert.equal(existsSync(fb), false, 'file archived after a full drain');

    const lines = await api.query({ endpoint: '/log', params: { area: 'replay-area' } });
    assert.match(lines, /first replayed line/);
    assert.match(lines, /second replayed line/);
    // second run is a quiet no-op (nothing left to replay)
    assert.equal((await api.replayFallback()).status, 'none');
  } finally {
    if (prevData === undefined) delete process.env.WS_DATA_DIR;
    else process.env.WS_DATA_DIR = prevData;
    rmSync(fake, { recursive: true, force: true });
  }
});
