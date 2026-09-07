'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const session = require('express-session');
const request = require('supertest');
const { makeApp, BASE_CONFIG } = require('./helpers');
const { authRouter, requireAuth, validateIdTokenClaims, SIGNED_OUT_COOKIE } = require('../src/auth/oauth');

const GOOGLE_AUTH = 'https://accounts.google.com/o/oauth2/v2/auth';

/** Unsigned JWT with a fixture payload — decodeJwtPayload only reads part 2 of 3. */
function fakeIdToken(claims) {
  return ['x', Buffer.from(JSON.stringify(claims)).toString('base64url'), 'x'].join('.');
}

/**
 * Standalone auth harness: express + session + authRouter with a STUBBED code
 * exchange, so tests can walk the SUCCESSFUL callback path without Google.
 * /probe reports the authenticated identity; /expire simulates session expiry.
 */
function makeAuthHarness(overrides = {}) {
  const config = { ...BASE_CONFIG, ...overrides };
  const app = express();
  app.use(session({ secret: config.sessionSecret, resave: false, saveUninitialized: false }));
  const exchangeCode = async () => ({
    id_token: fakeIdToken({ email: config.allowedEmail, email_verified: true, aud: config.clientId }),
  });
  app.use('/auth', authRouter(config, { exchangeCode }));
  app.use(requireAuth(config));
  app.get('/probe', (req, res) => res.json({ ok: true, email: req.userEmail }));
  app.get('/expire', (req, res) => req.session.destroy(() => res.json({ ok: true })));
  return app;
}

/** Extract the CSRF state Google would echo back, from a 302's Location URL. */
function stateFrom(res) {
  return new URL(res.headers.location).searchParams.get('state');
}

test('TP-digest-viewer-008 / TP-react-001: unauthenticated GET / redirects to Google with correct params', async () => {
  const res = await request(makeApp()).get('/'); // bypass OFF
  assert.equal(res.status, 302);
  const url = new URL(res.headers.location);
  assert.equal(url.origin + url.pathname, GOOGLE_AUTH);
  assert.equal(url.searchParams.get('client_id'), BASE_CONFIG.clientId);
  assert.equal(url.searchParams.get('redirect_uri'), 'http://localhost:8080/auth/callback');
  assert.equal(url.searchParams.get('response_type'), 'code');
  assert.equal(url.searchParams.get('scope'), 'openid email');
  assert.ok(url.searchParams.get('state'), 'state param must be non-empty');
});

test('TP-digest-viewer-009: deep link also redirects to Google (SPA path served only behind the wall)', async () => {
  const res = await request(makeApp()).get('/digests/2026-01-02');
  assert.equal(res.status, 302);
  assert.ok(res.headers.location.startsWith(GOOGLE_AUTH));
});

test('TP-react-002: unauthenticated /api request gets 401 JSON, never a Google redirect', async () => {
  const app = makeApp(); // bypass OFF
  for (const apiPath of ['/api/digests', '/api/plans', '/api/conversations', '/api/agents', '/api/skills']) {
    const res = await request(app).get(apiPath);
    assert.equal(res.status, 401, `${apiPath} must 401`);
    assert.match(res.headers['content-type'], /application\/json/);
    assert.equal(res.body.ok, false);
    assert.equal(res.headers.location, undefined, 'an API fetch must never be redirected');
  }
});

test('TP-digest-viewer-010: callback with mismatched state is rejected, no session', async () => {
  const app = makeApp();
  const agent = request.agent(app);
  await agent.get('/'); // establishes session + real state
  const cb = await agent.get('/auth/callback?code=fake&state=WRONG');
  assert.ok(cb.status === 400 || cb.status === 403, `got ${cb.status}`);
  // Still unauthenticated afterwards:
  const after = await agent.get('/');
  assert.equal(after.status, 302);
  assert.ok(after.headers.location.startsWith(GOOGLE_AUTH));
});

test('TP-digest-viewer-011: bypass as owner is let through to the SPA shell', async () => {
  const res = await request(makeApp({ authBypass: true, authBypassEmail: 'owner@example.com' })).get('/');
  assert.equal(res.status, 200);
  assert.match(res.text, /<div id="root">/);
});

test('TP-digest-viewer-012 / TP-react-003: bypass as wrong email gets 403 on pages AND /api', async () => {
  const app = makeApp({ authBypass: true, authBypassEmail: 'mallory@example.com' });
  const page = await request(app).get('/');
  assert.equal(page.status, 403);
  assert.match(page.text, /access denied/i);
  assert.doesNotMatch(page.text, /<div id="root">/, 'no SPA shell for a rejected account');
  const api = await request(app).get('/api/digests');
  assert.equal(api.status, 403);
  assert.match(api.headers['content-type'], /application\/json/);
  assert.equal(api.body.ok, false);
});

test('TP-digest-viewer-013: bypass is off by default and off for non-"true" values', async () => {
  for (const app of [makeApp(), makeApp({ authBypass: 'TRUE' }), makeApp({ authBypass: '1' })]) {
    const res = await request(app).get('/');
    assert.equal(res.status, 302);
    assert.ok(res.headers.location.startsWith(GOOGLE_AUTH));
  }
});

test('TP-digest-viewer-014: id_token claim validation enforces exact owner email', () => {
  const ok = { email: BASE_CONFIG.allowedEmail, email_verified: true, aud: BASE_CONFIG.clientId };
  assert.equal(validateIdTokenClaims(ok, BASE_CONFIG), null);

  const wrongEmail = { ...ok, email: 'mallory@example.com' };
  assert.ok(validateIdTokenClaims(wrongEmail, BASE_CONFIG));

  const unverified = { ...ok, email_verified: false };
  assert.ok(validateIdTokenClaims(unverified, BASE_CONFIG));

  const wrongAud = { ...ok, aud: 'someone-else' };
  assert.ok(validateIdTokenClaims(wrongAud, BASE_CONFIG));

  const caseTrick = { ...ok, email: 'Owner@example.com' };
  assert.ok(validateIdTokenClaims(caseTrick, BASE_CONFIG),
    'email comparison must be exact (case-sensitive)');
});

// @plan:hn-ceo-is-config-2026-08-15 @promote
test('TP-ceoconf-003: FAIL CLOSED — empty allowlist denies every identity, even an empty-string email', async () => {
  // Bypass as a normally-allowlisted address, but the allowlist itself is empty:
  // the gate must 403, never pass '' === ''.
  const app = makeApp({ allowedEmail: '', authBypass: true, authBypassEmail: 'owner@example.com' });
  const page = await request(app).get('/');
  assert.equal(page.status, 403);
  assert.doesNotMatch(page.text, /<div id="root">/, 'no SPA shell when the allowlist is unset');
  const api = await request(app).get('/api/digests');
  assert.equal(api.status, 403);
  assert.equal(api.body.ok, false);
});

// @plan:hn-ceo-is-config-2026-08-15 @promote
test('TP-ceoconf-004: claim validation with an empty allowlist rejects all claims, including email:""', () => {
  const noAllowlist = { ...BASE_CONFIG, allowedEmail: '' };
  const normal = { email: 'owner@example.com', email_verified: true, aud: BASE_CONFIG.clientId };
  assert.ok(validateIdTokenClaims(normal, noAllowlist), 'a real-looking claim set must be rejected');
  const emptyEmail = { email: '', email_verified: true, aud: BASE_CONFIG.clientId };
  assert.ok(validateIdTokenClaims(emptyEmail, noAllowlist), 'empty email must never match an empty allowlist');
});

// @plan:hn-ceo-is-config-2026-08-15 @promote
test('TP-ceoconf-005: configFromEnv logs ONE loud line naming ALLOWED_EMAIL when it is missing', (t) => {
  const { configFromEnv } = require('../src/config');
  const errors = [];
  t.mock.method(console, 'error', (line) => errors.push(String(line)));
  const missing = configFromEnv({});
  assert.equal(missing.allowedEmail, '');
  assert.equal(errors.filter((l) => l.includes('ALLOWED_EMAIL')).length, 1, 'exactly one loud boot line');

  errors.length = 0;
  const set = configFromEnv({ ALLOWED_EMAIL: ' owner@example.com ' });
  assert.equal(set.allowedEmail, 'owner@example.com', 'trimmed');
  assert.equal(set.authBypassEmail, 'owner@example.com', 'bypass email defaults to the allowlist');
  assert.equal(errors.length, 0, 'no boot warning when the var is set');
});

// @plan:hub-logout-visible-signout-2026-08-18 @promote
test('TP-losv-001: GET /auth/logout 302s to / and sets the signed-out flag cookie', async () => {
  const res = await request(makeApp()).get('/auth/logout');
  assert.equal(res.status, 302);
  assert.equal(res.headers.location, '/');
  const setCookie = (res.headers['set-cookie'] || []).find((c) => c.startsWith(`${SIGNED_OUT_COOKIE}=`));
  assert.ok(setCookie, 'logout must set the signed-out flag cookie');
  assert.match(setCookie, /HttpOnly/i);
  assert.match(setCookie, /Max-Age=600/i, 'flag cookie is short-lived (10 minutes)');
});

// @plan:hub-logout-visible-signout-2026-08-18 @promote
test('TP-losv-002: full round-trip — login, logout, next redirect carries prompt=select_account', async () => {
  const agent = request.agent(makeAuthHarness());
  // Unauthenticated: redirected to Google, no prompt param (TP-losv-003 pins this too).
  const first = await agent.get('/probe');
  assert.equal(first.status, 302);
  // Successful callback (stubbed exchange) signs the owner in.
  const cb = await agent.get(`/auth/callback?code=ok&state=${stateFrom(first)}`);
  assert.equal(cb.status, 302);
  assert.equal(cb.headers.location, '/probe', 'returnTo round-trips');
  const authed = await agent.get('/probe');
  assert.equal(authed.status, 200);
  assert.equal(authed.body.email, BASE_CONFIG.allowedEmail);
  // Explicit sign-out destroys the session…
  const out = await agent.get('/auth/logout');
  assert.equal(out.status, 302);
  // …and the NEXT redirect to Google demands a visible account chooser.
  const after = await agent.get('/probe');
  assert.equal(after.status, 302, 'session must be gone after logout');
  const url = new URL(after.headers.location);
  assert.equal(url.origin + url.pathname, GOOGLE_AUTH);
  assert.equal(url.searchParams.get('prompt'), 'select_account');
});

// @plan:hub-logout-visible-signout-2026-08-18 @promote
test('TP-losv-003: default OAuth redirect carries NO prompt param (silent expiry re-auth preserved)', async () => {
  const res = await request(makeApp()).get('/');
  assert.equal(res.status, 302);
  const url = new URL(res.headers.location);
  assert.equal(url.searchParams.get('prompt'), null, 'no prompt without a prior explicit logout');
});

// @plan:hub-logout-visible-signout-2026-08-18 @promote
test('TP-losv-004: successful callback clears the flag cookie — later expiry redirect is silent again', async () => {
  const agent = request.agent(makeAuthHarness());
  await agent.get('/auth/logout'); // flag cookie set
  const prompted = await agent.get('/probe');
  assert.equal(new URL(prompted.headers.location).searchParams.get('prompt'), 'select_account');
  const cb = await agent.get(`/auth/callback?code=ok&state=${stateFrom(prompted)}`);
  const cleared = (cb.headers['set-cookie'] || []).find((c) => c.startsWith(`${SIGNED_OUT_COOKIE}=`));
  assert.ok(cleared, 'successful sign-in must clear the flag cookie');
  assert.match(cleared, /Expires=Thu, 01 Jan 1970/i);
  assert.equal((await agent.get('/probe')).status, 200);
  await agent.get('/expire'); // simulate session expiry
  const after = await agent.get('/probe');
  assert.equal(after.status, 302);
  assert.equal(new URL(after.headers.location).searchParams.get('prompt'), null,
    'expiry after a NORMAL sign-in must re-auth silently');
});

// @plan:hub-logout-visible-signout-2026-08-18 @promote
test('TP-losv-005: with the flag cookie present, every other redirect param is unchanged', async () => {
  const agent = request.agent(makeApp());
  await agent.get('/auth/logout');
  const res = await agent.get('/');
  assert.equal(res.status, 302);
  const url = new URL(res.headers.location);
  assert.equal(url.origin + url.pathname, GOOGLE_AUTH);
  assert.equal(url.searchParams.get('client_id'), BASE_CONFIG.clientId);
  assert.equal(url.searchParams.get('redirect_uri'), 'http://localhost:8080/auth/callback',
    'the registered callback URI is load-bearing and must not move');
  assert.equal(url.searchParams.get('response_type'), 'code');
  assert.equal(url.searchParams.get('scope'), 'openid email', 'scopes stay openid email ONLY');
  assert.ok(url.searchParams.get('state'), 'state param must be non-empty');
});

// @plan:hub-logout-visible-signout-2026-08-18 @promote
test('TP-losv-006: flag cookie is Secure on an https base URL and not on http', async () => {
  const http = await request(makeApp()).get('/auth/logout');
  const plain = (http.headers['set-cookie'] || []).find((c) => c.startsWith(`${SIGNED_OUT_COOKIE}=`));
  assert.ok(plain && !/;\s*Secure/i.test(plain), 'no Secure attribute on plain-http local dev');
  const https = await request(makeApp({ baseUrl: 'https://example.com' })).get('/auth/logout');
  const secure = (https.headers['set-cookie'] || []).find((c) => c.startsWith(`${SIGNED_OUT_COOKIE}=`));
  assert.ok(secure, 'flag cookie set on https config');
  assert.match(secure, /;\s*Secure/i, 'Secure attribute required in production');
});

test('TP-react-004: callback error paths keep their statuses (provider error 403, missing code 400)', async () => {
  const app = makeApp();
  const agent = request.agent(app);
  const cancelled = await agent.get('/auth/callback?error=access_denied');
  assert.equal(cancelled.status, 403);
  assert.match(cancelled.text, /sign-in/i);

  await agent.get('/'); // establish a session + state
  const noState = await agent.get('/auth/callback?code=x');
  assert.equal(noState.status, 400);
});
