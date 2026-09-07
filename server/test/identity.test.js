'use strict';

// GET /identity — the log API serving "who this instance works for" to the hub
// web app. Plan: `ws plan get test-plan-identity-endpoint`. The contract under
// test: the endpoint and cli/util/ceo.js can never disagree (one read path),
// the key gate applies, and an unconfigured instance serves generic labels
// rather than an error — a hub page render must survive a broken config.

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const API_KEY = 'test-key-identity';

/** Spawn a server on a random port; resolve its base URL. @param {Record<string,string>} extraEnv */
function boot(extraEnv) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'logapi-identity-test-'));
  const proc = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: {
      ...process.env,
      LOG_DB_PATH: path.join(dir, 'logs.db'),
      LOG_API_PORT: '0',
      LOG_API_HOST: '127.0.0.1',
      LOG_API_KEY: API_KEY,
      ...extraEnv,
    },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  const base = new Promise((resolve, reject) => {
    let out = '';
    const timer = setTimeout(() => reject(new Error('server did not start: ' + out)), 10000);
    proc.stdout.on('data', (d) => {
      out += d;
      const m = out.match(/listening on (http:\/\/127\.0\.0\.1:\d+)/);
      if (m) { clearTimeout(timer); resolve(m[1]); }
    });
    proc.on('exit', (code) => reject(new Error('server exited early: ' + code + ' ' + out)));
  });
  return { proc, base };
}

let proc;
let base;

test.before(async () => {
  ({ proc, base: base } = boot({}));
  base = await base;
});

test.after(() => { if (proc) proc.kill(); });

test('TP-hubident-001: /identity returns exactly what cli/util/ceo.js resolves — one read path, no drift', async () => {
  const res = await fetch(base + '/identity', { headers: { 'X-Api-Key': API_KEY } });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  // Config-agnostic on purpose: the expected values come from the same module the
  // server uses, so this test never hardcodes an operator's name (CEO is config).
  const { ceo } = await import(pathToFileURL(path.join(__dirname, '..', '..', 'cli', 'util', 'ceo.js')).href);
  assert.deepEqual(body.identity, ceo(path.join(__dirname, '..', '..')));
  for (const k of ['name', 'pronouns', 'hubTitle']) {
    assert.equal(typeof body.identity[k], 'string');
    assert.ok(body.identity[k].length > 0, `${k} must be non-empty`);
  }
});

test('TP-hubident-002: /identity sits behind the same api-key gate as every other endpoint', async () => {
  const res = await fetch(base + '/identity');
  assert.equal(res.status, 401);
});

test('TP-hubident-003: an instance with no config serves generic labels, never an error', async () => {
  const emptyRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'logapi-identity-noconf-'));
  const { proc: p2, base: b2 } = boot({ WS_ROOT: emptyRoot });
  try {
    const url = await b2;
    const res = await fetch(url + '/identity', { headers: { 'X-Api-Key': API_KEY } });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.deepEqual(body.identity, { name: 'the CEO', pronouns: 'they/them', hubTitle: 'Hub' });
  } finally {
    p2.kill();
    fs.rmSync(emptyRoot, { recursive: true, force: true });
  }
});
