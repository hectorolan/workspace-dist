'use strict';

const crypto = require('node:crypto');
const express = require('express');
const { sendErrorPage } = require('../lib/html-page');

const GOOGLE_AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';

/**
 * Post-logout flag cookie (TP-losv-*): /auth/logout sets it so the NEXT OAuth
 * redirect carries `prompt=select_account` — Google then shows its account
 * chooser (a visible signed-out state) instead of silently re-authenticating a
 * live Google browser session. Deliberately NOT sent on every redirect: the app
 * session expires (7-day maxAge), and expiry re-auth should stay silent. The
 * cookie is short-lived and cleared by a successful callback; if the browser
 * drops it, behavior degrades to silent re-auth, never a broken login.
 */
const SIGNED_OUT_COOKIE = 'hub_signed_out';
const SIGNED_OUT_COOKIE_MAX_AGE_MS = 10 * 60 * 1000;

/** True when the request carries the post-logout flag cookie (no cookie-parser needed). */
function hasSignedOutCookie(req) {
  const header = req.headers && req.headers.cookie;
  if (!header) return false;
  return header.split(';').some((part) => part.trim().startsWith(`${SIGNED_OUT_COOKIE}=`));
}

/**
 * Build the Google authorization URL for this request, storing the CSRF state and
 * the post-login return path in the session. Scopes are `openid email` ONLY.
 * After an explicit logout (flag cookie present), adds `prompt=select_account` —
 * a request parameter only; the registered redirect URI never changes.
 */
function buildAuthRedirect(req, config) {
  const state = crypto.randomBytes(16).toString('hex');
  req.session.oauthState = state;
  req.session.returnTo = req.originalUrl && req.originalUrl.startsWith('/') ? req.originalUrl : '/';
  const params = new URLSearchParams({
    client_id: config.clientId,
    redirect_uri: `${config.baseUrl}/auth/callback`,
    response_type: 'code',
    scope: 'openid email',
    state,
  });
  if (hasSignedOutCookie(req)) params.set('prompt', 'select_account'); // TP-losv-002/003
  return `${GOOGLE_AUTH_ENDPOINT}?${params}`;
}

/**
 * Validate the claims of an ID token received DIRECTLY from Google's token endpoint
 * over HTTPS (so no local signature check is required, per Google's guidance).
 * Returns null when valid, otherwise a short reason string (never echoed with secrets).
 * Enforces the hard server-side allowlist: exact match on config.allowedEmail
 * (the ALLOWED_EMAIL env var). FAIL CLOSED: an empty allowlist rejects every
 * claim set — never compare against the empty string.
 * (TP-digest-viewer-014, TP-ceoconf-004)
 */
function validateIdTokenClaims(claims, config) {
  if (!config.allowedEmail) return 'allowlist not configured (ALLOWED_EMAIL unset)';
  if (!claims || typeof claims !== 'object') return 'missing claims';
  if (claims.aud !== config.clientId) return 'aud mismatch';
  if (claims.email_verified !== true) return 'email not verified';
  if (claims.email !== config.allowedEmail) return 'email not allowed';
  return null;
}

/** Decode a JWT payload without verifying the signature (token came from Google over TLS). */
function decodeJwtPayload(jwt) {
  const parts = String(jwt).split('.');
  if (parts.length !== 3) return null;
  try {
    return JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
  } catch {
    return null;
  }
}

/** Exchange an authorization code for tokens at Google's token endpoint. */
async function exchangeCode(code, config) {
  const res = await fetch(GOOGLE_TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: config.clientId,
      client_secret: config.clientSecret,
      redirect_uri: `${config.baseUrl}/auth/callback`,
      grant_type: 'authorization_code',
    }),
  });
  if (!res.ok) throw new Error(`token endpoint returned ${res.status}`);
  return res.json();
}

/**
 * Auth wall for every protected route.
 * - Session user present: enforce the allowlist (again — defense in depth), else 403.
 * - Dev bypass ON (tests/local only, see CLAUDE.md): treat the request as authenticated
 *   as config.authBypassEmail, then fall through to the SAME allowlist check.
 * - Otherwise: page/asset requests 302 straight to Google's consent flow; /api
 *   requests get 401/403 JSON instead — an API fetch must never be redirected into
 *   an HTML consent page (the SPA reloads the document on a 401, and the document
 *   request performs the redirect). (TP-react-001/002/003, TP-digest-viewer-008/011/012/013)
 */
function requireAuth(config) {
  return (req, res, next) => {
    const isApi = req.path === '/api' || req.path.startsWith('/api/');
    let email = req.session && req.session.user ? req.session.user.email : null;
    if (!email && config.authBypass === true) email = config.authBypassEmail;
    if (!email) {
      if (isApi) return res.status(401).json({ ok: false, error: 'Not authenticated.' });
      return res.redirect(buildAuthRedirect(req, config));
    }
    // FAIL CLOSED (TP-ceoconf-003): an empty allowlist (ALLOWED_EMAIL unset)
    // denies every identity — the second clause alone would pass '' === ''.
    if (!config.allowedEmail || email !== config.allowedEmail) {
      console.warn(`auth: rejected non-allowed account (allowlist enforced)`);
      if (req.session) req.session.destroy(() => {});
      if (isApi) {
        return res.status(403).json({ ok: false, error: 'Access denied: this app is restricted to its owner.' });
      }
      return sendErrorPage(res, 403, 'Access denied', 'Access denied: this app is restricted to its owner.');
    }
    req.userEmail = email;
    return next();
  };
}

/** Router for /auth/* — the OAuth callback and logout. */
function authRouter(config, deps = {}) {
  const exchange = deps.exchangeCode || exchangeCode;
  const router = express.Router();

  // TP-digest-viewer-010: reject state mismatches; TP-digest-viewer-014: claim checks.
  router.get('/callback', async (req, res) => {
    const { code, state, error } = req.query;
    if (error) {
      return sendErrorPage(res, 403, 'Sign-in failed', 'Google sign-in was cancelled or failed.');
    }
    if (!state || !req.session.oauthState || state !== req.session.oauthState) {
      return sendErrorPage(res, 400, 'Sign-in failed', 'Invalid sign-in state. Please try again.');
    }
    delete req.session.oauthState;
    if (!code) {
      return sendErrorPage(res, 400, 'Sign-in failed', 'Missing authorization code.');
    }
    let claims;
    try {
      const tokens = await exchange(code, config);
      claims = decodeJwtPayload(tokens.id_token);
    } catch (err) {
      console.error(`auth: token exchange failed: ${err.message}`);
      return sendErrorPage(res, 502, 'Sign-in failed', 'Could not complete sign-in with Google. Please try again.');
    }
    const reason = validateIdTokenClaims(claims, config);
    if (reason) {
      console.warn(`auth: sign-in rejected (${reason})`);
      return req.session.destroy(() =>
        sendErrorPage(res, 403, 'Access denied', 'Access denied: this app is restricted to its owner.')
      );
    }
    const returnTo = req.session.returnTo || '/';
    delete req.session.returnTo;
    req.session.user = { email: claims.email };
    res.clearCookie(SIGNED_OUT_COOKIE, { path: '/' }); // TP-losv-004: signed in — expiry re-auth is silent again
    return res.redirect(returnTo);
  });

  // TP-losv-001: explicit sign-out must be VISIBLE — set the flag cookie so the
  // requireAuth redirect that follows sends the user to Google's account chooser
  // instead of silently re-authenticating (never Google's global logout).
  router.get('/logout', (req, res) => {
    req.session.destroy(() => {
      res.cookie(SIGNED_OUT_COOKIE, '1', {
        httpOnly: true,
        sameSite: 'lax',
        secure: config.baseUrl.startsWith('https://'),
        maxAge: SIGNED_OUT_COOKIE_MAX_AGE_MS,
        path: '/',
      });
      res.redirect('/');
    });
  });

  return router;
}

module.exports = {
  authRouter,
  requireAuth,
  buildAuthRedirect,
  validateIdTokenClaims,
  decodeJwtPayload,
  SIGNED_OUT_COOKIE,
};
