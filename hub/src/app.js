'use strict';

const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
const session = require('express-session');
const { authRouter, requireAuth } = require('./auth/oauth');
const { htmlPage } = require('./lib/html-page');
const { digestsRouter } = require('./routes/digests');
const { conversationsRouter } = require('./routes/conversations');
const { plansRouter } = require('./routes/plans');
const { agentsRouter } = require('./routes/agents');
const { skillsRouter } = require('./routes/skills');
const { pageCommentsRouter } = require('./routes/page-comments');
const { stationsRouter } = require('./routes/stations');
const { featuresRouter } = require('./routes/features');
const { threadsRouter } = require('./routes/threads');
const { identityRouter } = require('./routes/identity');
const { guideRouter } = require('./routes/guide');
const { pagesApiRouter, pagesViewRouter } = require('./routes/pages');

/**
 * App factory — takes a full config object (see src/config.js) so tests can build
 * isolated instances. Since the React refactor, Express is strictly the backend:
 * auth, JSON data delivery under /api, and static hosting of the built SPA
 * (vite build → config.distDir). No server-side view rendering remains.
 *
 * Route map:
 *   /healthz                        public  liveness probe (no data)
 *   /public/*                       public  backend stylesheet for terminal pages
 *   /auth/*                         public  OAuth callback + logout
 *   /api/digests[/:date]            gated   digest index + one sanitized digest (+ picker thread counts)
 *   POST /api/conversations         gated   start a page-born conversation (page-comment intake)
 *   /api/conversations/:id          gated   one legacy email thread (read-only render)
 *   POST /api/conversations/:id/status  gated  archive/unarchive (server-side PATCH)
 *   /api/plans[/:slug]              gated   plan list (status/kind/repo filters, thread counts,
 *                                           kind=conversation = the conversation view,
 *                                           view=tests|records = the Documents subtabs) + one plan
 *   /api/agents[/:name]             gated   workspace agents
 *   /api/knowledge/:slug            gated   governing doc (whitelisted)
 *   /api/skills[/:name]             gated   workspace skills (+ upstream provenance)
 *   /api/stations                   gated   station registry (control-plane verdicts)
 *   /api/features                   gated   feature-major matrix (log API aggregate)
 *   /api/threads/:pageType/:slug    gated   one document's thread (sanitized entries)
 *   /api/identity                   gated   instance identity (nav brand, speaker labels)
 *   /api/guide                      gated   the packaged user manual (Home > Guide sections)
 *   /api/pages[/:slug]              gated   custom-pages roster + one page (HUB_PAGES_DIR;
 *                                           unset = enabled:false, no tab appears)
 *   /pages-view/:token/:slug/*      token   tier-3 static-site serving — the slug-scoped
 *                                           HMAC path token IS the credential (the sandboxed
 *                                           iframe's opaque origin withholds session cookies;
 *                                           tokens are minted only behind the auth wall —
 *                                           see src/routes/pages.js + the security review)
 *   POST /api/page-comments         gated   comment-box confirm → log API message
 *   /assets/*, /fonts/*             gated   built SPA bundle (served from distDir)
 *   GET <anything else>             gated   SPA fallback → dist/index.html
 */
function createApp(config) {
  const app = express();
  if (config.baseUrl.startsWith('https://')) app.set('trust proxy', 1); // behind Caddy in prod

  app.use(
    session({
      secret: config.sessionSecret,
      resave: false,
      saveUninitialized: false,
      cookie: {
        httpOnly: true,
        sameSite: 'lax',
        secure: config.baseUrl.startsWith('https://'),
        maxAge: 7 * 24 * 60 * 60 * 1000,
      },
    })
  );

  // Content-Security-Policy on every response — defense in depth behind the
  // server-side markdown sanitizer (render-markdown.js). The React build emits
  // no inline scripts and no inline styles, so both script-src and style-src
  // are 'self' alone — strictly tighter than the EJS era's nonce +
  // unsafe-inline (TP-react-008; formerly TP-audit-remediation-005).
  app.use((req, res, next) => {
    res.setHeader(
      'Content-Security-Policy',
      "default-src 'self'; script-src 'self'; style-src 'self'; " +
        "img-src 'self' https: data:; font-src 'self'; " +
        "object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'"
    );
    next();
  });

  // Public routes — keep this list minimal (see CLAUDE.md).
  app.get('/healthz', (req, res) => res.json({ ok: true })); // TP-digest-viewer-016
  // Terminal-page stylesheet: public on purpose — auth-failure pages render for
  // people who cannot load the gated bundle. Styles only, no data (html-page.js).
  app.use('/public', express.static(path.join(__dirname, 'public'), { index: false }));
  app.use('/auth', authRouter(config));
  // Tier-3 page serving sits ABOVE the cookie wall by design: its slug-scoped
  // HMAC token (mintable only through the authenticated /api/pages/:slug) is
  // the credential — see the route-map note above and src/routes/pages.js.
  app.use(pagesViewRouter(config));

  // Everything below the wall is owner-only (401/403 JSON for /api, 302/403
  // pages otherwise — see requireAuth).
  app.use(requireAuth(config));
  app.use(digestsRouter(config));
  app.use(conversationsRouter(config));
  app.use(plansRouter(config));
  app.use(agentsRouter(config));
  app.use(skillsRouter(config));
  app.use(pageCommentsRouter(config));
  app.use(stationsRouter(config));
  app.use(featuresRouter(config));
  app.use(threadsRouter(config));
  app.use(identityRouter(config));
  app.use(guideRouter(config));
  app.use(pagesApiRouter(config));

  // Unknown /api path: JSON 404, never the SPA shell (TP-react-007).
  app.use('/api', (req, res) => {
    res.status(404).json({ ok: false, error: 'Unknown API route.' });
  });

  // Built SPA assets (gated, like every content route).
  app.use(express.static(config.distDir, { index: false }));

  // SPA fallback: every remaining GET serves the shell; the client router owns
  // the path and the /api calls carry the real status codes (test-plan
  // assumption 3). Missing build = a clear 503, not a stack trace.
  app.use((req, res) => {
    if (req.method !== 'GET') {
      return res.status(404).json({ ok: false, error: 'Not found.' });
    }
    const indexHtml = path.join(config.distDir, 'index.html');
    if (!fs.existsSync(indexHtml)) {
      return res
        .status(503)
        .type('html')
        .send(
          htmlPage({
            title: 'Frontend not built',
            message: 'The SPA bundle is missing — run `npm run build` (vite) and restart.',
          })
        );
    }
    res.sendFile(indexHtml);
  });

  return app;
}

module.exports = { createApp };
