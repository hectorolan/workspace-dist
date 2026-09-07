'use strict';

const path = require('node:path');
const crypto = require('node:crypto');

/** Build the runtime config from process.env (production/dev entry path). */
function configFromEnv(env = process.env) {
  const port = parseInt(env.PORT || '8080', 10);
  const baseUrl = (env.BASE_URL || 'http://localhost:8080').replace(/\/$/, '');
  const authBypass = env.AUTH_BYPASS === 'true';
  // The ONE account allowed into hub — the server-side allowlist, from env
  // (CEO-is-config sweep, hn-ceo-is-config-2026-08-15). FAIL CLOSED: unset/empty
  // means every login is denied (requireAuth + validateIdTokenClaims both refuse
  // when the allowlist is empty) and ONE loud boot line names the missing var —
  // an auth gate never fails open. (TP-ceoconf-003/005)
  const allowedEmail = (env.ALLOWED_EMAIL || '').trim();
  if (!allowedEmail) {
    console.error(
      'ERROR: ALLOWED_EMAIL is not set — the auth allowlist is empty, so EVERY login will be denied until ALLOWED_EMAIL is set in the environment.'
    );
  }
  // Hard production guard (2026-07-24 audit, finding A): a stray AUTH_BYPASS=true
  // in a prod env would silently hand every anonymous visitor the owner's session.
  // An https:// BASE_URL is the existing prod signal (trust proxy / secure cookie
  // use the same test) — refuse to start rather than warn. (TP-audit-remediation-006)
  if (authBypass && baseUrl.startsWith('https://')) {
    throw new Error(
      'AUTH_BYPASS=true is dev/test only and BASE_URL is https:// (production). Refusing to start — remove AUTH_BYPASS from the environment.'
    );
  }
  return {
    port,
    baseUrl,
    allowedEmail,
    clientId: env.GOOGLE_OAUTH_CLIENT_ID || '',
    clientSecret: env.GOOGLE_OAUTH_CLIENT_SECRET || '',
    // Workspace .claude directory (the Claude tab's Core/Agents/Skills pages). Resolved
    // relative to the repo root locally; production points it into the mounted
    // workspace_sources volume. Never a hardcoded host path.
    workspaceClaudeDir: path.resolve(
      path.join(__dirname, '..'),
      env.WORKSPACE_CLAUDE_DIR || '../workspace/.claude'
    ),
    // Workspace log API (conversations data). Server-side only — the key must never
    // reach the browser. Unset URL => the Conversations page shows a "not configured"
    // state instead of failing.
    logApiUrl: (env.LOG_API_URL || '').replace(/\/$/, ''),
    logApiKey: env.LOG_API_KEY || '',
    // Built SPA output (vite build). Overridable so tests can point the SPA
    // fallback at a fixture without running a build (HN_DIST_DIR is test-only).
    distDir: path.resolve(path.join(__dirname, '..'), env.HN_DIST_DIR || 'dist'),
    // Custom pages root (design hub-home-custom-pages-design Part 2): every
    // direct subfolder = one top-level tab. UNSET = the feature is off — no
    // tab appears at all. Resolved like WORKSPACE_CLAUDE_DIR: relative to the
    // repo root; absolute paths pass through.
    pagesDir: env.HUB_PAGES_DIR ? path.resolve(path.join(__dirname, '..'), env.HUB_PAGES_DIR) : '',
    // Scan cache TTL (ms). Not an env var on purpose — nobody tunes this;
    // tests override it on the config object (test plan
    // hub-pages-framework-core-2026-08-29, "Scan cache TTL").
    pagesScanTtlMs: 5000,
    sessionSecret: env.SESSION_SECRET || crypto.randomBytes(32).toString('hex'),
    // Dev/test ONLY. Off unless the literal string "true"; combined with an
    // https:// BASE_URL the guard above refuses to start. See CLAUDE.md.
    authBypass,
    authBypassEmail: env.AUTH_BYPASS_EMAIL || allowedEmail,
  };
}

module.exports = { configFromEnv };
