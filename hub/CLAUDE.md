# CLAUDE.md — hub

The CEO's central operations hub web app — the single pane for all operations,
grown feature by feature from the original digest viewer (the feature inventory
is the workspace registry `configs/features.json`, which keys by name; this
file's sections carry each feature's repo-side detail).

Shared workspace conventions (conventional commits, branch → PR → the CEO merges,
test-plan-first, secrets via env vars, central-DB `ws log` audit trail) live in the workspace
repo: `../workspace/.claude/CLAUDE.md`. This file covers only repo-specific details.

## Stack

Node 22 + Express 4 (backend: auth, /api JSON, static hosting) + React 19/Vite
(frontend SPA in `client/`, built to `dist/` — gitignored; `npm run build` before
`npm start` serves the UI). `marked` + `sanitize-html` run SERVER-side only: every
/api response carries sanitized HTML, never raw markdown (XSS posture: the one
pipeline in `src/lib/render-markdown.js` + strict CSP with no inline script/style).
All styling is token-driven — see `client/src/styles/tokens.css`; never introduce
an ad-hoc color/size/duration. Two suites:

- `npm test` — Node built-in test runner + supertest, `test/*.test.js`. API routes,
  libs, sanitization, auth, SPA-shell serving. Fast; the default gate.
- `npm run test:e2e` — Playwright (chromium, headless), `e2e/*.spec.js`. The browser
  half: client-side scripts (the comment-box confirm modal, the digest index rows),
  form → redirect round-trips, and section navigation. `playwright.config.js` starts
  BOTH servers itself — `src/server.js` with `AUTH_BYPASS=true`, and
  `e2e/fixtures/stub-log-api.js` standing in for the workspace log API (the real API is
  never contacted: the suite must be deterministic and must never write to the central
  DB). Fixture `.claude` tree for the Agents/Skills sections: `e2e/fixtures/claude/`.
  Add a spec whenever behavior lives in client-side React code (modal guards,
  navigation, filters) — supertest only reaches the JSON API.

Entry point `src/server.js`; the Express app is built by the factory in `src/app.js` so
tests can construct isolated instances with their own config.

## Layout (where to add a new feature)

- `src/routes/` — one API router per section (JSON under /api). Add a new file,
  mount it in `src/app.js`.
- `client/src/pages/` — the React views; register routes in `client/src/App.jsx`
  and wire nav in its SECTIONS/SUBTABS lists (top tabs Home · Documents ·
  Claude; every top tab is a grouping section and its pages land as subtabs —
  Home: Digests/Guide, Documents: Plans/Tests/Records/Conversations, Claude:
  Core/Agents/Skills/Features). Home is THE landing surface (design
  `hub-home-custom-pages-design` Part 1): `/` is the Home tab's own route AND
  the brand-click target, rendering the latest digest; `/digests` (index) and
  `/digests/:date` live under its Digests subtab. The Guide subtab (`/guide`)
  is the hub's user manual — authored as packaged markdown in
  `src/content/guide.md`, split into `## `-sections and sanitized server-side
  (`src/lib/guide.js`, `GET /api/guide`), rendered with a sticky right-hand
  section TOC whose anchor ids live on client wrappers, never inside the
  sanitized HTML.
- `src/lib/` — non-HTTP domain logic (e.g. `digests.js` reads/renders digest markdown).
- `src/auth/` — OAuth flow + `requireAuth` middleware. All new routes must be mounted
  BEHIND `requireAuth` in `src/app.js` unless there is an explicit reason not to
  (`/healthz`, `/public/*`, `/auth/*` and tier-3 `/pages-view/*` — whose
  credential is the HMAC path token, see "Custom pages" below — are the only
  paths above the wall).

## Custom pages (design hub-home-custom-pages-design Part 2)

`HUB_PAGES_DIR` (unset = feature OFF, no tab) points at a user-owned folder;
every direct subfolder is one page = one top-level tab after the built-ins
(manifest `page.json` order, then alphabetical). Index precedence
`index.html` > `index.json` > `index.md`: tier 1 (md) renders through the ONE
sanitization pipeline via `src/lib/guide.js`'s parser and the client's shared
`SectionedDocument` layout (the Guide's renderer, graduated — a tier-1 page
looks exactly like the Guide); tier 2 (json) is a widget layout composed
SERVER-side by `src/lib/page-widgets.js` (catalog v1: digest-list, plan-list,
plan-view, feature-cells, stat-tiles — every widget rides an existing
`src/lib/*` log-API client, the key never reaches the browser; the user-facing
catalog doc lives in the Guide's tier-2 section, `client/src/pages/widgets.jsx`
renders the handed-back card states) where malformed layouts, unknown widgets,
bad params, and erroring data sources each degrade to a visible card state
inside a 200 — never a 5xx, and never any touch of the tier-3 token machinery;
tier 3
(html) is served as a static site at `/pages-view/<token>/<slug>/…` inside a
sandboxed iframe — `allow-scripts allow-forms`, NEVER `allow-same-origin`
(that combo would let page JS reach the hub shell). Serving rules that must
not loosen (`src/lib/pages.js` + `src/routes/pages.js`, security review
`docs/security-review-pages-serving.md`): `/api/pages*` stays behind
`requireAuth`; `/pages-view` sits ABOVE the cookie wall on purpose because
the sandboxed iframe's opaque origin withholds SameSite cookies — its
credential is a 1 h slug-scoped HMAC path token minted only inside
authenticated `/api/pages/:slug` responses (a live owner session also
passes); traversal proofing is layered (slug charset → scan-roster
membership → segment whitelist → resolve + realpath containment) and only
tier-3 folders are ever static-served. User content NEVER crashes the hub:
no-index folders are skipped, malformed manifests fall back to defaults,
garbage index.json degrades to a layout-error card. E2E runs against the
fixture root `e2e/fixtures/pages/` (all tiers incl. a full widget board and a
malformed one, + a skipped folder), wired in `playwright.config.js`.

## Auth (read before touching)

- Google OIDC, scopes `openid email` only. Access is hard-restricted server-side to
  the ONE address in the `ALLOWED_EMAIL` env var (CEO-is-config, 2026-08-15). FAIL
  CLOSED: unset/empty denies every login and logs one loud boot line naming the var —
  never fail open, and never loosen the exact-match check.
- Registered redirect URIs (Google Cloud, project `ho-nexus`) are exactly
  `http://localhost:8080/auth/callback` and
  `https://ho-nexus.westus2.cloudapp.azure.com/auth/callback`. Never add routes or config
  that assume any other redirect URI; the callback path `/auth/callback` and local port
  8080 are load-bearing.
- Credentials come from `.env` (gitignored): `GOOGLE_OAUTH_CLIENT_ID` /
  `GOOGLE_OAUTH_CLIENT_SECRET`. Never print or commit their values. Keep `.env.example`
  current (names + comments only) whenever an env var is added.

## Dev auth bypass — MUST stay off in real deployments

`AUTH_BYPASS=true` (literal string) skips the Google round-trip and treats every request
as authenticated as `AUTH_BYPASS_EMAIL` (default: the `ALLOWED_EMAIL` value). The server-side
allowlist still runs, so a non-owner bypass email still gets 403 — that's how tests cover
the rejection path. Rules:

- Default is OFF; anything other than the literal `true` means off.
- Only for local dev and automated tests. It must never be set in the production compose
  config or on the Azure VM. Devops: check for this at every deploy.

## Digests data

The Digests section reads the workspace log API's `daily-digest` message kind server-side
(`GET /message?kind=daily-digest&format=json` for the date list, `GET /message/:id` for one
body — `workspace/server/README.md`), using `LOG_API_URL` + `LOG_API_KEY` (X-Api-Key
header) — the SAME server-side client pattern as the Conversations and Plans sections
(`src/lib/digests.js`). The key stays in the Node process; it never reaches the browser.
Unset `LOG_API_URL` = the section shows a "not configured" page; the rest of the app is
unaffected. The digest history is the DB (source of truth, per the churn-test invariant in
the workspace CLAUDE.md) — a new digest is visible the moment the daily-digest job stores
its message, with no file, mount, or sync step to go stale. A digest's date comes from the
first `YYYY-MM-DD` in the message `ref` (fallback `subject`), never the row's `date` column
(evening catch-up runs store tomorrow's digest under today's date); date collisions keep
the highest message id. `/digests` is an INDEX page (two-line rows, newest first): a row's
title is the stored message subject verbatim, falling back to `Daily Digest — <date>` when
absent — composed report titles ride the subject, so they surface with no UI change. Tests
stub the API with a local `node:http` server (shared helper in `test/helpers.js`) — no
live API needed.

## Conversations data (reworked by document-threads N2)

Conversations live on the **Documents tab's Conversations subtab** — `/conversations`,
a real page again since `hn-documents-subtabs-2026-08-15` (design: central-DB plan
`nexus-document-threads-design`); the N2-era `/plans?kind=conversation` URL redirects
there, so old bookmarks and digest-email links never
404. Two populations, merged newest-activity-first by `GET /api/plans?kind=conversation`:

- **Page-born conversations** are document-less threads (workspace
  `server/README.md` "Document threads"), anchor `(conversation, conv-<epoch-ms>)` —
  **`conv-<epoch-ms>` is THE doc_ref convention**, generated server-side by
  `POST /api/conversations` (the "Start a conversation" box). Never digits-only, so it
  can never collide with a legacy conversation id. The opener rides the page-comment
  intake contract with meta `{pageType:"conversations", slug:"conv-<ts>"}`, subject
  `Conversation: <first line> (conversations/<ref>)`, an instruction-only body (no
  page-context section — nothing to quote), and **its message `ref` is the `conv-*`
  doc_ref itself** (piece-1 contract — the trigger reverse lookup keys page-born rows
  on `message_ref`). `/conversations/conv-*` is the thread-only page: the thread IS
  the content, with the status badge + archive control on its header card.
- **Legacy email conversations** stay in the log API's `/conversation` store (never
  migrated) and render read-only at `/conversations/<numeric id>`, with their document
  thread (numeric anchor) + thread-mode comment box below, so new comments on old
  conversations thread into the new model.

Archive/unarchive covers BOTH populations (test plan
`hub-conversation-archive-ui-2026-08-17`): a JSON POST to
`/api/conversations/:ref/status` that calls `PATCH /conversation/:id {status}`
server-side — one PATCH for a numeric id, every distinct backing
`message.conversation_id` from the thread read for a `conv-*` ref. Reversible, never
deleted, and deliberately NO confirm dialog (CEO ruling 2026-08-17: archive means drop
it — the inbox runner skips archived threads; unarchiving restores eligibility). The
merged listing shows active rows by default (`?archived=1` reveals both populations'
archived rows; archived stay reachable by direct URL); a page-born row's archive state
is its opener's `conversation_status` on the anchor listing, and backing rows of
page-born openers dedupe out of the legacy population. A conversation that
generated a document (role-`trigger` entries, ONE `GET /thread?role=trigger` call for
the whole index) wears an artifact chip linking `/plans/<ref>` — on its index row AND
in both detail-page headers next to the status badge (test plan
`hub-conversation-detail-artifact-chips-2026-08-17`; the shared join lives in
`src/lib/threads.js` `artifactIndex`/`conversationArtifacts`). All of it
feature-detects: a pre-piece-1 log API means no badges, no dedupe, archives failing
with a clean inline error — never a broken page.

All calls run server-side with `LOG_API_URL` + `LOG_API_KEY` (X-Api-Key header) — the
key never reaches the browser. Unset `LOG_API_URL` = friendly not-configured page; the
rest of the app is unaffected. In production the log API is published on the VM host at
:8790 (see the deploy note in docker-compose.yml). Tests stub the API with a local
`node:http` server — no live API needed.

## Document threads

EVERY md-backed detail page — digest, plan, agent, skill, knowledge doc — renders
the document's thread below it (design: central-DB plan
`nexus-document-threads-design`; API contract: `workspace/server/README.md`
"Document threads"). The published result stays the top of the page: document,
hairline, THREAD section, box — the thread never bleeds into the document body.
`src/lib/threads.js` reads `GET /thread?doc_kind&doc_ref` with the standard
server-side `LOG_API_URL` + `LOG_API_KEY` client pattern and mirrors the intake's
pageType→doc_kind map verbatim (incl. `knowledge` → `knowledge`, new with N3) —
the two sides MUST agree or a page reads a different anchor than its comments
write. Thread bodies are untrusted quoted data (WS-H2): every entry renders
through `src/lib/render-markdown.js`, never raw; role-`ceo` page-comment bodies
display only their `## Instruction` section (the page-context echo is capture
machinery, not conversation). `trigger` entries render first as the document's
origin. The comment box runs in thread mode on all of these pages and on
conversation pages ("Add to this thread", reply lands in the thread in ~15 min
and by email) — identical POST machinery and confirm modal; the legacy
presentation is retired. Index rows join thread-entry counts server-side from
the `/thread` anchor listing, best-effort — zero renders nothing and a join
failure (or an unconfigured log API, on the filesystem-backed Agents/Skills/
Knowledge indexes) never breaks the index; every row-shaped index uses the
two-line idiom (Plans, digests, agents, skills, knowledge); conversations live
on the Documents tab's Conversations subtab (see "Conversations data").

## Station detail data (merged by feature-registry Part C)

The station drill-down (`/stations/:env`, reached from a Features-matrix column header;
the old Stations PAGE is retired — `/stations` redirects to `/features`, query preserved)
reads the workspace log API's station registry server-side (`GET /station?format=json`,
`workspace/server/README.md` "Stations") with the same `LOG_API_URL` + `LOG_API_KEY`
client pattern as Plans/Conversations (`src/lib/stations.js`). Two invariants, both
tested: **the control plane judges, the page renders** — `stale`, `age_minutes` and
`never_reported` are the API's read-time findings and are echoed verbatim, never
recomputed from timestamps in the app or browser (a station whose tunnel is down is
exactly the one that cannot file a report); and **checks are trimmed to strings** — each
env-doctor result forwards as `{id, level, name, detail}` plus the ONE optional prose
field `explain` (env-doctor's plain-language explainer, C-2 follow-up — string-only and
length-capped, dropped otherwise, never coerced; absent on older cached reports and then
absent from the response too), with `data` objects and the raw `report` dropped
server-side, so no secret-shaped value has a path to the browser (gh scopes appear as
names inside `detail`). A check's `explain` renders as muted secondary text under its
detail — in the full table and on the FAIL/WARN headline rows — and the prose is authored
ONLY in env-doctor, never hardcoded in the UI (the C-2 registry rule). The detail shows
the machine facts only —
badges (ok/failing, stale, not in configs), last-report meta, public IP, platform, the
FAIL/WARN headline list, and the FULL check table, always open; the station's feature
column deliberately lives ONLY on the matrix (one fact, one place). Never-reported is a
NORMAL state (new box, empty DB) and renders the quiet card — absence is not failure.
`?stale_minutes=` forwards the API's staleness-window override (validated positive
integer). There is no browser-side `cp-env:` string parsing: cp-env check rows ride the
generic check path, so a report's failures stay visible. Capability labels for THIS
repo's vars are the `# env-doctor:` markers in `.env.example` (grammar: workspace
SYSTEM.md "Per-service env health").

## Features data (feature-registry Parts B + C — the ONE health surface)

The Features subtab (`/features`) renders the workspace log API's **server-aggregated**
feature-major matrix (`GET /feature?format=json`, contract:
`workspace/server/README.md` "Feature registry") via `/api/features`
(`src/lib/features.js` + `src/routes/features.js`, same `LOG_API_URL` + `LOG_API_KEY`
server-side client pattern as the station detail). Two invariants, both tested: **the
control plane judges, the page renders** — every cell state (`ready` / `off` /
`missing` / `warn` / `stale` / `unmeasured` / `never-reported` / `n/a`) is the API's
finding, echoed verbatim, never derived here — and **the trim is a whitelist**
(TP-hubfeat-002): features/cells/checks forward only known string/number/boolean
fields (job `last_run` keeps outcome + date only; `description` is the one prose
field, passed through verbatim), so nothing secret-shaped has a path to the browser
and the station check-data trim is never widened. Rendering rules that must stay
honest: `n/a` (out of scope) is the quietest cell, visually distinct from `missing`;
`unmeasured` (declared, no evidence) never reads as ready; job rows show last-run
outcome + disabled state; every row's second line is the registry's colloquial
`description` (C-2) — the prose lives ONLY in the feed, never hardcoded in the UI.
Layout (test plan `hub-features-kind-tabs-2026-08-27`): kinds render one at a time
behind an in-page tab row derived from the kinds PRESENT in the feed (never a
hardcoded list — an unknown kind gets its own raw-kind tab), deep-linked via
`?kind=` composing with `?stale_minutes=`, invalid/absent values falling back to
the first tab; scope is an inline tag right after the title in the name cell (no
scope column), the description owning the freed width.
Since Part C this is the ONE surface (design `features-ui-restructure-design`, C-1):
station column headers wear the `/api/stations` verdicts (health/stale badge +
humanized age — a best-effort join: a failed stations read renders plain header
names, never a broken matrix) and link to the `/stations/:env` drill-down;
never-reported stations render as dimmed columns; reporters absent from configs are
never columns and land in the "Also reporting" strip. `?stale_minutes=` forwards to
both feeds. Chip vocabulary lives in `client/src/styles/app.css`
(`.feature-chip.fc-*`) — one vocabulary for matrix and detail, token-driven.

## Running

- `npm run build` then `npm start` — local, port 8080 (`npm run dev` for Vite HMR on 5173).
- `docker compose up --build` — same, containerized, with the workspace `.claude` mount.
- `npm test` — unit/route suite; no network, no real Google login needed.
- `npm run test:e2e` — browser suite (first run: `npx playwright install chromium`).

Test plans and audit history live in the central log DB, not in the repo: project test
plans are `ws plan set --kind test-plan --repo hub <slug> ...` (rendered on the
Documents tab — test plans under its Tests subtab), and audit lines are `ws log -r hub <area> <status> "<msg>"`. `ops/log.md` is the
gitignored local offline-fallback target for `ws log -r hub` (written only when the API
is unreachable, replayed on the next healthy tick) — never committed.
