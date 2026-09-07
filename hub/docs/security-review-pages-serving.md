# Security review — custom pages serving path (phase 2)

Date: 2026-08-29. Scope: the pages framework core added by test plan
`hub-pages-framework-core-2026-08-29` (design `hub-home-custom-pages-design`
Part 2) — `/api/pages`, `/api/pages/:slug`, `/pages-view/<token>/<slug>/…`,
the folder scan, the tier-1 render path, and the tier-3 iframe sandbox.
Method: threat-enumerated audit of the serving path (the security-review
methodology; no registered workspace skill exists, so the review was performed
directly and recorded here). Accepted risk profile per the design: single
tenant behind Google OAuth, pages are operator-authored — but the sandbox is
the default posture and this audit gates the merge.

Files audited: `src/routes/pages.js`, `src/lib/pages.js`, `src/lib/guide.js`,
`src/lib/render-markdown.js` (unchanged, re-checked as the tier-1 sink),
`src/app.js` (mount order), `client/src/pages/custom.jsx` (iframe attributes),
`client/src/App.jsx` (roster consumption).

## Verdict

**Pass.** No findings requiring change before merge; the deliberate risk
acceptances are listed at the end. Every control below is enforced by an
automated test (IDs cited).

## 1. Authentication

- `/api/pages` and `/api/pages/:slug` mount behind `requireAuth` like every
  content route — 401 JSON unauthenticated, allowlist still enforced under
  bypass (TP-pages-010).
- `/pages-view` sits ABOVE the cookie wall **by design**, because the
  sandboxed iframe's opaque origin makes browsers withhold SameSite session
  cookies from its subresource requests — cookie auth alone would 302 every
  asset to Google in production while looking fine under AUTH_BYPASS. Its
  credential is a slug-scoped HMAC path token:
  - minted ONLY inside authenticated `/api/pages/:slug` responses
    (`mintPageToken`), signed with `sessionSecret` (HMAC-SHA256), 1 h expiry —
    so nothing under `/pages-view` is reachable without first holding an
    authenticated session (auth-equivalence);
  - verified shape-first (`TOKEN_SHAPE`), expiry-checked, compared with
    `crypto.timingSafeEqual` (constant-time; both buffers fixed 32 bytes);
  - scoped to ONE slug — a token for page A opens nothing of page B
    (TP-pages-012);
  - a live allowlisted session is accepted as the alternative credential
    (`sessionAuthed` mirrors `requireAuth`'s decision, fail-closed on an empty
    allowlist), covering direct debugging (TP-pages-012).
- Token leakage vectors: `Referrer-Policy: no-referrer` on every pages-view
  response keeps the token-bearing URL out of outbound referrers
  (TP-pages-014); tokens never appear in logs; the 1 h expiry bounds any leak.
  Residual: the token is visible in the owner's own DOM/history — same trust
  domain as the session cookie itself.

## 2. Path traversal (the headline risk)

Layered guards in `/pages-view/:token/:slug/*` — each independently
sufficient for the cases it covers:

1. **Slug charset**: `VALID_NAME` (`^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`) —
   no separators, no leading dot; enforced at the API too (TP-pages-013).
2. **Roster membership**: the slug must appear in the scan of the configured
   root with tier `html` — the validate-against-listing pattern the
   agents/skills routes established. Skipped/invalid folders are unreachable.
3. **Segment whitelist** on the asset path: reject `\0` and `\` outright
   (400); reject any empty segment or segment starting with `.` (404) — which
   kills `..`, `.`, dotfiles, and `//` in one stroke. Encoded (`%2e%2e`) and
   double-encoded traversal decode into these same rejected shapes or into
   nonexistent literal filenames (TP-pages-013, exercised with RAW socket
   requests because WHATWG clients pre-collapse dot segments).
4. **Resolved-path containment**: `path.resolve(pageDir, rel)` must stay
   under the page's own directory (prefix + separator check).
5. **Realpath containment**: the resolved file's `realpathSync` must stay
   under the page directory's realpath — an in-folder symlink pointing
   outside the root is refused (TP-pages-016, POSIX; on Windows the scan's
   `isDirectory()` additionally excludes junction/symlink page folders).
6. `res.sendFile` runs with `dotfiles: 'ignore'` as a final backstop, and
   only after `statSync(...).isFile()`.

Tested attack set: `../` (plain/encoded/double-encoded), backslash variants,
null bytes, deep chains, empty segments, dotfiles, sibling-page and
outside-root planted secrets — never served (TP-pages-013/014/016).

## 3. Iframe sandbox / isolation of tier-3 code

- The client pins `sandbox="allow-scripts allow-forms"` — **never**
  `allow-same-origin` (which, combined with allow-scripts on same-origin
  content, would let page JS unwind the sandbox and reach the hub shell).
  Proven in a real browser: the fixture app's `window.parent.document` probe
  throws while its scripts run (TP-pages-033).
- Opaque origin ⇒ page code has no hub cookies, no localStorage of the hub
  origin, and its `fetch` to the hub API is cross-origin without credentials
  and without CORS approval — the signed-in-viewer bridge remains a later,
  explicitly opt-in phase.
- Per-response page CSP replaces the shell CSP on pages-view responses:
  `connect-src 'self'` (no phoning home), `object-src 'none'`,
  `frame-ancestors 'self'` (pages render only inside the hub or directly),
  `base-uri 'self'`, `form-action 'self'`; `'unsafe-inline'` script/style is
  allowed INSIDE the page on purpose — a self-contained single-file
  `index.html` is the intended five-minute page, and isolation is enforced by
  the sandbox + opaque origin, not the page's internal CSP (TP-pages-014).
- The hub shell's own strict CSP is untouched; the same-origin iframe is
  admitted by its `default-src 'self'` (no `frame-src` widening needed).
- `X-Content-Type-Options: nosniff` on all pages-view responses.

## 4. Tier-1 (markdown) path

- Renders through the ONE existing pipeline (`render-markdown.js` — marked +
  sanitize-html allowlist); the allowlist was NOT widened. Section anchor ids
  stay on client wrappers, never inside sanitized HTML. Hostile markdown
  (script tags, `javascript:` hrefs) is neutered (TP-pages-006), same posture
  as the guide/digests.
- The graduated `parseGuide` change is additive (an `intro` field) and feeds
  the same sanitizer; `/api/guide` shape verified unchanged otherwise
  (TP-pages-017).

## 5. Scan / roster surface

- The roster returns slugs/titles/tiers/icons only — no filesystem paths
  (TP-pages-002). Manifest fields are type- and length-validated
  (title ≤80, icon ≤16, finite order); malformed manifests and garbage
  `index.json` are never parsed into behavior and never crash (TP-pages-004/008).
- Feature off (`HUB_PAGES_DIR` unset) is fully dead: empty roster, 404
  details, dead pages-view (TP-pages-001). An unreadable root scans as empty
  — user filesystem state can never 5xx the hub.
- DoS considerations: the scan is one readdir + a few stats per folder,
  cached 5 s per app instance; token verification is one HMAC. No
  user-controlled amplification.

## Accepted risks (recorded, not fixed — matching the design's risk profile)

1. **Operator-authored content is trusted within its sandbox**: a malicious
   page could still render deceptive UI inside its own tab. Single-tenant,
   operator-authored — accepted by the design.
2. **`img-src/font-src https:` in the page CSP** lets a tier-3 page load
   remote images/fonts (and thus emit outbound GETs). Deliberate usability
   trade-off; `connect-src 'self'` still blocks programmatic exfiltration
   channels. Revisit if the bridge phase tightens the posture.
3. **Token in URL**: mitigated (no-referrer, 1 h expiry, slug scope,
   owner-only trust domain) rather than eliminated; eliminating it would
   require weakening the sandbox or the session-cookie posture — worse
   trades.
4. **`/pages-view` is mounted above the cookie wall**: the public-route list
   grew by one router whose every response is credential-checked in-handler.
   The route map in `src/app.js` documents it loudly.
