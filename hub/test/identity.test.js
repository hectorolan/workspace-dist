'use strict';

// Instance-identity client + /api/identity route (CEO-is-config sweep,
// central-DB test plan hn-ceo-is-config-2026-08-15). The identity — name,
// pronouns, hub title — comes from the workspace log API's GET /identity and is
// NEVER hardcoded; on any failure the generic labels render, because a hub page
// must never break when the log API is down.

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const request = require('supertest');
const { makeApp, IDENTITY_FIXTURE, identityStubHandler } = require('./helpers');
const { getIdentity, resetIdentityCache, IDENTITY_FALLBACK } = require('../src/lib/identity');

/** Minimal stub log API serving only GET /identity (plus a 404 for the rest). */
function startIdentityStub({ broken = false } = {}) {
  let hits = 0;
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    if (u.pathname === '/identity') hits += 1;
    if (broken) {
      res.statusCode = 500;
      return res.end('boom');
    }
    if (identityStubHandler(req, res, u)) return;
    res.statusCode = 404;
    res.end(JSON.stringify({ ok: false }));
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () =>
      resolve({ url: `http://127.0.0.1:${server.address().port}`, hitCount: () => hits, close: () => server.close() })
    );
  });
}

// @plan:hn-ceo-is-config-2026-08-15 @promote
test('TP-ceoconf-007: getIdentity serves the API identity and caches it for ~5 minutes', async () => {
  resetIdentityCache();
  const stub = await startIdentityStub();
  try {
    const config = { logApiUrl: stub.url, logApiKey: 'k' };
    const t0 = 1_000_000;
    assert.deepEqual({ ...(await getIdentity(config, t0)) }, { ...IDENTITY_FIXTURE });
    assert.equal(stub.hitCount(), 1);
    // Within the TTL: cached, no second upstream fetch.
    await getIdentity(config, t0 + 60 * 1000);
    assert.equal(stub.hitCount(), 1, 'second call within TTL must not refetch');
    // Past the TTL: refetched.
    await getIdentity(config, t0 + 6 * 60 * 1000);
    assert.equal(stub.hitCount(), 2, 'call after TTL expiry must refetch');
  } finally {
    stub.close();
  }
});

// @plan:hn-ceo-is-config-2026-08-15 @promote
test('TP-ceoconf-008: getIdentity is fail-soft — unconfigured, unreachable, non-2xx and malformed all fall back', async () => {
  resetIdentityCache();
  // Unconfigured log API: immediate fallback, no fetch.
  assert.deepEqual({ ...(await getIdentity({ logApiUrl: '' })) }, { ...IDENTITY_FALLBACK });

  // Non-2xx.
  const broken = await startIdentityStub({ broken: true });
  try {
    assert.deepEqual({ ...(await getIdentity({ logApiUrl: broken.url })) }, { ...IDENTITY_FALLBACK });
  } finally {
    broken.close();
  }

  // Unreachable (closed port) — must resolve to the fallback, never throw.
  const gone = await startIdentityStub();
  gone.close();
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual({ ...(await getIdentity({ logApiUrl: gone.url })) }, { ...IDENTITY_FALLBACK });

  // Malformed envelope (200 with no identity object).
  const malformed = await new Promise((resolve) => {
    const server = http.createServer((req, res) => res.end(JSON.stringify({ ok: true })));
    server.listen(0, '127.0.0.1', () =>
      resolve({ url: `http://127.0.0.1:${server.address().port}`, close: () => server.close() })
    );
  });
  try {
    assert.deepEqual({ ...(await getIdentity({ logApiUrl: malformed.url })) }, { ...IDENTITY_FALLBACK });
  } finally {
    malformed.close();
  }
});

// @plan:hn-ceo-is-config-2026-08-15 @promote
test('TP-ceoconf-009: /api/identity is gated, serves the fixture identity, and never errors when the API is down', async () => {
  resetIdentityCache();
  const stub = await startIdentityStub();
  try {
    // Unauthenticated: 401 JSON like every /api route.
    const unauth = await request(makeApp({ logApiUrl: stub.url })).get('/api/identity');
    assert.equal(unauth.status, 401);

    // Authenticated: the stub's fixture identity.
    const ok = await request(makeApp({ authBypass: true, logApiUrl: stub.url })).get('/api/identity');
    assert.equal(ok.status, 200);
    assert.equal(ok.body.ok, true);
    assert.deepEqual(ok.body.identity, { ...IDENTITY_FIXTURE });

    // Log API unconfigured: still 200, generic labels — a page render never breaks.
    const down = await request(makeApp({ authBypass: true, logApiUrl: '' })).get('/api/identity');
    assert.equal(down.status, 200);
    assert.deepEqual(down.body.identity, { ...IDENTITY_FALLBACK });
  } finally {
    stub.close();
  }
});
