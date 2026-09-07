// TP-apisock: a pooled HTTP connection that dies mid-request must not cost the
// caller a write it can never retry.
//
// The live failure (windows-pc, 2026-08-18): `ws sync` reads the regression baseline
// (opening a pooled keep-alive socket), then blocks its event loop for ~26 s running
// the ci-guard gates in `execFileSync`. By the time the post-push `planSet` goes out,
// the connection is dead at the far end — through the SSH tunnel the local socket
// still looks alive, so the request is written and then reset: `fetch failed`, cause
// `UND_ERR_SOCKET`. It landed on a best-effort path, so every sync from that station
// silently lost its baseline advance AND its test-plan closures, printing one
// unfalsifiable line. The client now retries ONCE — but only what is safe to repeat.
//
// The fixture models the far end going away mid-request (a stub that destroys the
// socket on the first attempt and answers the retry), because that is the shape the
// tunnel produces; a plain idle timeout is evicted by undici itself and never fails.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

/** @type {import('node:http').Server} */
let server;
/** @type {{method: string, url: string}[]} */
let seen = [];
/** Kill (rather than answer) the next N requests, modelling a dead far end. */
let killNext = 0;
/** @type {typeof import('../util/apiclient.js')} */
let api;

before(async () => {
  server = http.createServer((req, res) => {
    seen.push({ method: req.method || '', url: req.url || '' });
    if (killNext > 0) {
      killNext -= 1;
      req.socket.destroy();
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, line: 'stored' }));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', () => r(undefined)));
  const addr = /** @type {import('node:net').AddressInfo} */ (server.address());
  // apiclient reads LOG_API_URL at module load — point it here before the import.
  process.env.LOG_API_URL = `http://127.0.0.1:${addr.port}`;
  delete process.env.LOG_API_KEY;
  api = await import('../util/apiclient.js');
});

after(async () => {
  await new Promise((r) => server.close(() => r(undefined)));
});

test('TP-apisock-001: an IDEMPOTENT write (PUT /plan) survives a socket that dies mid-request', async () => {
  seen = [];
  killNext = 1;
  const r = await api.planSet('test-baseline-workspace', { title: 't', body: 'b', kind: 'baseline' });
  assert.equal(r.line, 'stored');
  assert.equal(seen.filter((s) => s.method === 'PUT').length, 2, 'one failed attempt + one retry');
});

test('TP-apisock-002: an APPEND write (POST /log) is NEVER retried — it falls back instead', async () => {
  // A retried POST could store the line twice if the first attempt reached the DB,
  // and a duplicated audit line is worse than a queued one: `ws log` already has a
  // fallback file that `ws pull` replays, so nothing is lost by refusing to retry.
  const fake = mkdtempSync(path.join(tmpdir(), 'ws-sock-'));
  const prevData = process.env.WS_DATA_DIR;
  seen = [];
  killNext = 1;
  try {
    process.env.WS_DATA_DIR = fake;
    const r = await api.log({ area: 'sockettest', status: 'done', message: 'no duplicate' });
    assert.equal(r.ok, false);
    assert.equal(seen.filter((s) => s.method === 'POST').length, 1, 'exactly one attempt');
    assert.match(readFileSync(path.join(fake, 'fallback', 'log.md'), 'utf8'), /no duplicate/);
    assert.ok(existsSync(path.join(fake, 'fallback', 'log.md')));
  } finally {
    if (prevData === undefined) delete process.env.WS_DATA_DIR;
    else process.env.WS_DATA_DIR = prevData;
    rmSync(fake, { recursive: true, force: true });
  }
});

test('TP-apisock-003: a genuinely unreachable API still fails fast — the retry is not a hang', async () => {
  const prev = process.env.LOG_API_URL;
  try {
    process.env.LOG_API_URL = 'http://127.0.0.1:1';
    const fresh = await import(`../util/apiclient.js?nocache=${Date.now()}`);
    const started = Date.now();
    await assert.rejects(() => fresh.planSet('x', { title: 't', body: 'b', kind: 'plan' }));
    assert.ok(Date.now() - started < 10000, 'a refused connection is not retried into a hang');
  } finally {
    process.env.LOG_API_URL = prev;
  }
});
