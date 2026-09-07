'use strict';

const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
const { scanPages, loadPage, verifyPageToken, VALID_NAME, TOKEN_SHAPE } = require('../lib/pages');
const { renderWidgetsPage } = require('../lib/page-widgets');

/**
 * Custom pages routes (design `hub-home-custom-pages-design` Part 2, phase 2;
 * test plan hub-pages-framework-core-2026-08-29; security review
 * docs/security-review-pages-serving.md).
 *
 * Two routers with two mount points:
 * - `pagesApiRouter` — /api/pages roster + /api/pages/:slug detail, mounted
 *   BEHIND requireAuth like every content route. Feature off (HUB_PAGES_DIR
 *   unset) = an enabled:false roster and 404 details: no tab appears at all.
 * - `pagesViewRouter` — /pages-view/<token>/<slug>/<asset…>, the tier-3
 *   static-site serving path, mounted ABOVE the requireAuth wall on purpose:
 *   the sandboxed iframe's opaque origin withholds SameSite session cookies
 *   from subresource requests, so the slug-scoped HMAC path token (minted only
 *   inside authenticated /api/pages/:slug responses — see src/lib/pages.js) IS
 *   the credential. A live owner session is accepted too (direct debugging).
 *   Everything else about the wall's posture holds: no valid token or session
 *   = 401, and nothing here ever redirects to Google (assets must fail clean).
 */

/** The tier-3 page CSP (test-plan assumption "Iframe sandbox + CSP"): inline
 *  script/style are allowed INSIDE the sandboxed page — a single-file
 *  index.html is the natural five-minute page, and isolation comes from the
 *  iframe sandbox + opaque origin, not the page's internal CSP — while
 *  connect-src 'self' keeps pages from phoning home (the hub-API bridge is a
 *  later, opt-in phase) and frame-ancestors 'self' keeps them hub-framed. */
const PAGE_CSP =
  "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; " +
  "img-src 'self' data: https:; font-src 'self' data: https:; media-src 'self'; " +
  "connect-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'self'";

/** True when the request carries a live, allowlisted owner session (mirrors
 *  requireAuth's decision, without its redirect side). */
function sessionAuthed(req, config) {
  let email = req.session && req.session.user ? req.session.user.email : null;
  if (!email && config.authBypass === true) email = config.authBypassEmail;
  return Boolean(email && config.allowedEmail && email === config.allowedEmail);
}

function pagesApiRouter(config) {
  const router = express.Router();

  router.get('/api/pages', (req, res) => {
    if (!config.pagesDir) {
      return res.json({ ok: true, enabled: false, pages: [], skipped: [] });
    }
    const { pages, skipped } = scanPages(config);
    // The roster carries titles/tiers only — never filesystem paths (TP-pages-002).
    res.json({ ok: true, enabled: true, pages, skipped });
  });

  router.get('/api/pages/:slug', async (req, res) => {
    const { slug } = req.params;
    if (!config.pagesDir || !VALID_NAME.test(slug)) {
      return res.status(404).json({ ok: false, error: 'Page not found.' });
    }
    let page = loadPage(config, slug);
    if (!page) return res.status(404).json({ ok: false, error: 'Page not found.' });
    if (page.tier === 'widgets') {
      // Tier 2 (phase 3, test plan hub-pages-tier2-widgets-2026-08-29):
      // server-side widget composition. Every user-content failure is an
      // in-page card state inside the 200 (renderWidgetsPage never throws on
      // user files); the catch is a backstop for programming errors only.
      try {
        page = await renderWidgetsPage(config, slug, page);
      } catch {
        return res.status(500).json({ ok: false, error: 'Failed to render the page.' });
      }
    }
    res.json({ ok: true, page });
  });

  return router;
}

function pagesViewRouter(config) {
  const router = express.Router();

  // NOTE on ordering: the wildcard route registers FIRST — Express 4 routing
  // is non-strict, so the bare '/:token/:slug' pattern would otherwise also
  // swallow the trailing-slash document URL and 302-loop it (caught by
  // TP-pages-011).
  router.get('/pages-view/:token/:slug/*', (req, res) => {
    const { token, slug } = req.params;
    if (!config.pagesDir || !VALID_NAME.test(slug)) {
      return res.status(404).json({ ok: false, error: 'Not found.' });
    }
    // Credential: slug-scoped token OR live owner session — never neither.
    if (!verifyPageToken(config, slug, token) && !sessionAuthed(req, config)) {
      return res.status(401).json({ ok: false, error: 'Not authenticated.' });
    }
    // Only tier-3 pages are static-served (least surface, TP-pages-012); the
    // scan roster is the lookup, so a skipped folder is unreachable here.
    const { pages } = scanPages(config);
    const page = pages.find((p) => p.slug === slug && p.tier === 'html');
    if (!page) return res.status(404).json({ ok: false, error: 'Not found.' });

    // Path-traversal proofing to the pages root (TP-pages-013/014/016):
    // segment whitelist, then resolved-path containment, then realpath
    // containment (catches symlink escapes), then plain-file check.
    const rel = req.params[0] === '' ? 'index.html' : req.params[0];
    if (rel.includes('\0') || rel.includes('\\')) {
      return res.status(400).json({ ok: false, error: 'Bad request.' });
    }
    const segments = rel.split('/');
    if (segments.some((s) => s === '' || s.startsWith('.'))) {
      // Blocks '..', '.', dotfiles, and empty segments in one stroke.
      return res.status(404).json({ ok: false, error: 'Not found.' });
    }
    const pageDir = path.join(config.pagesDir, slug);
    const abs = path.resolve(pageDir, rel);
    if (!abs.startsWith(path.resolve(pageDir) + path.sep)) {
      return res.status(400).json({ ok: false, error: 'Bad request.' });
    }
    let real;
    try {
      real = fs.realpathSync(abs);
      const realPageDir = fs.realpathSync(pageDir);
      if (real !== realPageDir && !real.startsWith(realPageDir + path.sep)) {
        return res.status(404).json({ ok: false, error: 'Not found.' });
      }
      if (!fs.statSync(real).isFile()) {
        return res.status(404).json({ ok: false, error: 'Not found.' });
      }
    } catch {
      return res.status(404).json({ ok: false, error: 'Not found.' });
    }

    // Override the hub shell's strict global CSP with the page CSP (this
    // response is page content, not shell), keep the token out of outbound
    // referrers, and pin content-type sniffing off.
    res.setHeader('Content-Security-Policy', PAGE_CSP);
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.sendFile(real, { dotfiles: 'ignore' }, (err) => {
      if (err && !res.headersSent) {
        res.status(404).json({ ok: false, error: 'Not found.' });
      }
    });
  });

  // Bare page URL → trailing-slash form, so the document's relative asset URLs
  // resolve under its own token+slug prefix (TP-pages-011). Both segments are
  // shape-validated BEFORE being echoed into the Location header.
  router.get('/pages-view/:token/:slug', (req, res) => {
    const { token, slug } = req.params;
    if (!TOKEN_SHAPE.test(token) || !VALID_NAME.test(slug)) {
      return res.status(404).json({ ok: false, error: 'Not found.' });
    }
    res.redirect(302, `/pages-view/${token}/${slug}/`);
  });

  return router;
}

module.exports = { pagesApiRouter, pagesViewRouter, PAGE_CSP };
