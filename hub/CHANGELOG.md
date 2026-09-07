# Changelog

## Unreleased

### Fixed

- **Fixture hygiene — token-shaped literals rebuilt by concatenation** (central-DB
  test plan `hub-fixture-hygiene-2026-09-07`): the two redaction-proof fixtures in
  `test/features.test.js` / `test/stations.test.js` no longer form a key-shaped
  literal on one line (found by the workspace distribution exporter's scan over the
  vendored hub tree — hub ships inside the distribution per manifest decision D3);
  runtime values unchanged, and a new `test/fixture-hygiene.test.js` guards
  test/, e2e/, src/ and client/src/ so the next such literal fails hub CI instead
  of the export.

- **Docs-truth pass — pages-program audit remediation, hub half** (central-DB
  test plan `hub-pages-audit-remediation-2026-08-29`; audit
  `pages-program-audit-2026-08-29`): README caught up with the shipped
  program — nav described as Home (Digests/Guide) · Documents · Claude plus
  user page tabs, `/` lights the Home tab, "What it shows" rows for the
  Guide/`/pages/:slug`/`/pages-view`, the route-wall list now names
  `/pages-view` with why it sits above the cookie wall (HMAC path tokens —
  see `docs/security-review-pages-serving.md`), `HUB_PAGES_DIR` in the env
  table, and the production paragraph points at the workspace SETUP.md
  live-host row for the pages-root wiring. CLAUDE.md's
  "only unauthenticated paths" sentence now matches its own pages section,
  and the legacy "feature #N" navigation labels are retired (the registry
  keys by name). The Guide documents the widget-board caps (24 widgets /
  8 tiles / 12 feature ids), drops the not-yet-real compose-file advice for
  `HUB_PAGES_DIR`, and aligns the ask-the-orchestrator delivery/blocked-path
  wording with the `hub-page-authoring` skill. The docker-compose.yml deploy
  note gains the pages-root prod-override lines (guidance only — dev
  defaults unchanged). The PR #59 entry below now names its two amended test
  files instead of claiming "content-only". New `test/docs-truth.test.js`
  guards the regressable claims: auth-surface list vs `src/app.js`,
  `.env.example` vs the README env table, and Guide cap numbers vs
  `page-widgets.js` constants.

### Added

- **Guide: the "Ask the orchestrator" section is filled** (central-DB test plan
  `hub-guide-ask-orchestrator-2026-08-29`; phase 4 of design
  `hub-home-custom-pages-design`, the CEO 2026-08-29): the last stubbed manual
  section now documents the zero-effort tier for real — how to ask (agent
  session or any page's comment box), what happens (the agent writes the page
  folder straight into the pages root, no PR/merge/deploy — the folder is the
  delivery), the review loop (the owner reviews the rendered tab; each
  conversational pass lands as one audit-trail line), and the boundaries (no
  secrets in page content, agents never touch the hub itself, an unwired
  `HUB_PAGES_DIR` comes back as one setup step instead of a guess). The
  "Coming in a later phase" marker is gone from the manual — every described
  phase has shipped. No behavior change: `src/content/guide.md` plus two
  amended tests — `test/guide.test.js` (TP-home-003 → no stub markers
  anywhere) and `e2e/pages.spec.js` (TP-pages-036, the browser half of the
  same claim). The agent-side
  workflow lives in the workspace repo (`hub-page-authoring` skill), not here
  — the manual stays client-facing.

- **Custom pages tier 2 — the widget layer** (central-DB test plan
  `hub-pages-tier2-widgets-2026-08-29`; phase 3 of design
  `hub-home-custom-pages-design`, the CEO 2026-08-29): an `index.json` page is
  now a real widget board, replacing phase 2's later-phase placeholder. The
  layout (`{"title"?, "widgets": [{"widget", "title"?, "params"?}]}`)
  composes built-in hub widgets, composed SERVER-side on the authenticated
  `/api/pages/:slug` path by `src/lib/page-widgets.js` through the existing
  log-API client libs — the API key never reaches the browser, and the
  tier-3 sandbox/HMAC `/pages-view` machinery is untouched (still
  tier-3-only). Catalog v1 (proposed per the design's "propose, CEO trims"):
  `digest-list` (recent digests, linked), `plan-list` (document rows with
  kind/status/repo filters), `plan-view` (one document's sanitized body),
  `feature-cells` (Features-matrix verdicts echoed verbatim in the shared
  chip vocabulary), `stat-tiles` (enumerated counts: open-plans,
  latest-digest, stations-ok) — every widget maps to data the hub already
  serves; the design's log-query-table candidate is deferred (would be a new
  hub data surface). Degrade, never crash: malformed layout, unknown widget,
  bad parameter, and erroring data source each render a visible card state
  inside a 200 — user content can never 5xx the hub. Guide: the tier-2
  five-minute walk + the user-facing widget catalog table land in their
  section (only ask-the-orchestrator stays stubbed, phase 4); the sticky TOC
  is unchanged. E2E fixtures: `ops-board/` becomes a live board exercising
  all five widgets plus an unknown-widget entry; `broken-board/` carries the
  malformed-JSON fixture forward — the suite still never contacts the real
  log API.

- **Custom pages framework core** (central-DB test plan
  `hub-pages-framework-core-2026-08-29`; phase 2 of design
  `hub-home-custom-pages-design`, the CEO 2026-08-29): the hub now grows
  user-defined top-level tabs from a folder. `HUB_PAGES_DIR` (new env var,
  unset = feature off — no tab appears) points at a pages root; every direct
  subfolder is ONE page = ONE tab after the built-ins, ordered by optional
  `page.json` manifest (`title`/`order`/`icon`, humanized folder name as the
  default title) then alphabetically. The folder's index file decides the
  tier — precedence `index.html` > `index.json` > `index.md`: tier 1
  (markdown) renders server-side through the one sanitization pipeline using
  the Guide's section parser/layout (graduated into `SectionedDocument`:
  sticky section TOC at ≥2 `## ` sections — a tier-1 page looks exactly like
  the Guide; the Guide itself stays a packaged Home subtab so the manual
  survives an unset pages root); tier 3 (full HTML/JS) is served as a static
  site under `/pages-view/<token>/<slug>/…` and displayed in a sandboxed
  iframe (`allow-scripts allow-forms`, never `allow-same-origin`) with its
  own page CSP (`connect-src 'self'`, no phoning home); tier 2 (widget
  layouts) is honored in precedence but renders a visible later-phase
  placeholder until phase 3. Folders with no index are listed as skipped —
  user content never crashes the hub. Serving: `GET /api/pages` roster +
  `GET /api/pages/:slug` behind `requireAuth`; tier-3 assets authenticate via
  short-lived slug-scoped HMAC path tokens minted only in authenticated
  responses (the sandboxed iframe's opaque origin withholds session cookies —
  cookie auth alone would break assets in real auth), with layered
  path-traversal proofing (charset → roster membership → segment whitelist →
  resolve + realpath containment) audited in
  `docs/security-review-pages-serving.md`. The scan is live (5 s cache):
  drop a folder in, reload, the tab is there — the packaged hub customized
  purely by config + user files. Guide tier-1/tier-3 onboarding sections are
  filled with their five-minute walks; tier-2 and ask-the-orchestrator stay
  stubbed for phases 3–4.

### Changed

- **Home restructure: the Digests tab becomes Home, with a Guide subtab**
  (central-DB test plan `hub-home-restructure-2026-08-29`; phase 1 of design
  `hub-home-custom-pages-design`, the CEO 2026-08-29): the top nav is now
  Home · Documents · Claude, and Home is THE landing surface — `/` is the
  Home tab's own route and the brand-click target (superseding the 2026-08-15
  "no tab active on `/`" call), rendering the latest digest as before. Home
  groups two subtabs on the shared template: **Digests** (the latest digest
  open by default; the `/digests` index and `/digests/:date` detail carry
  over unchanged — no URL disappeared, so old bookmarks and digest-email
  links need no new redirects, and the legacy `?date=` redirects stay) and
  **Guide** (`/guide`), the hub's user manual: packaged markdown
  (`src/content/guide.md`) split into `## `-sections and rendered through the
  one sanitization pipeline server-side (`src/lib/guide.js`, `GET
  /api/guide`), displayed with the manual on the left and a sticky right-hand
  TOC enumerating every section (collapsing to a leading jump list ≤768px).
  Section anchor ids are server-computed slugs placed on client-rendered
  wrappers — never inside sanitized HTML, so the sanitizer allowlist did not
  widen. Phase-1 guide content covers the hub's surfaces; the custom-pages
  framework sections (three authoring tiers, ask-the-orchestrator) are
  present as clearly-marked "coming in a later phase" stubs so the TOC
  already shows the structure phases 2–4 fill in.

- **Station detail: plain-language check explainers** (central-DB test plan
  `check-explainers-hub-2026-08-27`; the C-2 follow-up in design
  `features-ui-restructure-design` — workspace half landed as workspace
  `6894e76`): the check trim in `src/lib/stations.js` widened by exactly ONE
  field — env-doctor's `explain`, a sentence or two for an operator who does
  not know the system (what the check verifies, what a failure means). The
  field is string-only and length-capped, dropped otherwise (never coerced —
  the TP-stations-003 security posture is unchanged and now asserted against
  object/number/oversized values). The `/stations/:env` drill-down renders it
  as muted secondary text under the check's detail, in the full check table
  AND on the FAIL/WARN headline rows (the Features-row two-line idiom); rows
  without it — older cached reports — render exactly as before, no blank gap.
  The prose lives only in env-doctor; the UI never hardcodes per-check
  sentences.

- **Features page: kind tabs + inline scope tag** (central-DB test plan
  `hub-features-kind-tabs-2026-08-27`; the CEO's live review of the merged
  page, 2026-08-28): the stacked per-kind sections became an in-page tab row
  on the Documents-subtab template — one tab per kind PRESENT in the registry
  feed, derived from the data (a future kind gets its tab automatically; the
  old "Other" catch-all group is retired in favor of a raw-kind tab), with the
  active tab deep-linkable via `?kind=` (the Records-subtab idiom for a
  data-derived axis, composing with `?stale_minutes=`). The scope COLUMN is
  gone: scope now renders as a small inline tag right after the feature title
  inside the name cell, and the freed width goes to the row's registry
  description. Station column headers (health/stale badges, `/stations/:env`
  drill-down links), dimmed never-reported columns, the "Also reporting" strip
  and the `/api/features` contract are unchanged.
- **The Features matrix is the ONE health surface; the Stations page retired
  into it** (central-DB test plan `hub-features-stations-merge-2026-08-27`;
  design `features-ui-restructure-design` C-1 + C-2, the CEO's rulings
  2026-08-27 — Part C, on workspace's required-description registry change):
  the Stations subtab and page are gone — `/stations` redirects to `/features`
  (query preserved), and the per-station machine detail lives at
  `/stations/:env`, reached from the matrix's station column headers, which now
  wear the control plane's health/stale badges and humanized last-report age
  (a best-effort `/api/stations` join: a failed read renders plain header
  names, never a broken matrix). The detail keeps everything the old page knew
  — badges incl. "not in configs", last-report meta, public IP, platform, the
  FAIL/WARN headline list, and the full check table, now always open — while
  the station's feature column deliberately lives only on the matrix (the
  one-fact-two-places duplication C-1 exists to kill; parity checklist in the
  test plan). Never-reported stations render as dimmed columns and still open
  their quiet detail; reporters absent from configs are never columns and land
  in an "Also reporting" strip. Per C-2, every feature row's second line is now
  the registry's colloquial `description`, passed through the whitelist trim
  verbatim from `GET /feature` — the UI never hardcodes per-feature prose.

### Fixed

- **Sign-out is visible again** (central-DB test plan
  `hub-logout-visible-signout-2026-08-18`; the CEO's mobile report, 2026-08-18):
  the footer "sign out" link destroyed the session and redirected to `/`, but the
  auth wall immediately 302'd back to Google with no `prompt` parameter, and a
  live Google browser session silently re-authenticated — sign-out appeared to
  do nothing. `/auth/logout` now sets a short-lived httpOnly flag cookie
  (`hub_signed_out`, 10-minute Max-Age, `Secure` on https), and while it is
  present the OAuth redirect adds `prompt=select_account`, landing the user on
  Google's account chooser — a visible signed-out state. A successful callback
  clears the flag, so session-expiry re-auth stays silent (deliberately NOT
  always-on: the 7-day session cookie would otherwise turn every expiry into a
  visible chooser tap). Redirect URIs, the `/auth/callback` path, `openid email`
  scopes, and the fail-closed ALLOWED_EMAIL allowlist are untouched; no Google
  global logout.

- **Index-row chips sit on line 1, next to the badges** (central-DB test plan
  `hub-conversation-index-chip-line1-2026-08-17`; the CEO's live-site report,
  2026-08-17): the artifact-linkage chip on Conversations index rows rendered
  as its own stretched column beside the whole two-line row, because the chip
  is a sibling of the row anchor (the `after` slot — anchors never nest) and
  the row li laid siblings out as flex columns. The shared IndexRow template
  now uses the stretched-link idiom: the row anchor wraps only the title and
  covers the whole row through an absolutely-positioned CSS overlay, so
  `after` chips flow in-line on line 1 immediately after the title's badges —
  still independently clickable, the row still one click target with no dead
  zones, valid HTML throughout. The Skills origin chip (same slot) moves from
  its right-column spot to line 1 consistently; every other index renders
  identically, and the detail-page header chips (PR #49) are untouched.

### Added

- **Features subtab: the feature-major matrix, and a registry-backed Stations
  panel** (central-DB test plan `hub-features-matrix-2026-08-27`; design
  `features-ui-restructure-design`, the CEO's decision 3, 2026-08-27 — Part B of
  the feature-registry restructure, on workspace Part A's `GET /feature`):
  `/features` is the fifth Claude subtab — the declared registry's features
  grouped by kind (Jobs/Services/Tools/Checks/Pages), a verbatim scope badge per
  row (`all` / `schedule-owner` / `env:<name>` / `kind:<...>`), and one state
  chip per configured station, every state the control plane's own verdict
  echoed through the new `/api/features` proxy (`src/lib/features.js`, a
  strings-only whitelist trim — the station check-data trim is untouched).
  `n/a` (out of scope) renders quietest and never reads like `missing`;
  `unmeasured` (declared, no evidence) never reads ready; job rows carry
  last-run outcome and disabled state. The Stations page now lists each
  station's in-scope features from the same endpoint (best-effort: a feed
  failure just drops the panel), replacing the browser-side `cp-env:`
  string-parsed dependency panel — cp-env check rows ride the generic check
  path, so report failures stay visible without any client parsing.

- **Artifact chips inside conversation detail pages** (central-DB test plan
  `hub-conversation-detail-artifact-chips-2026-08-17`; the CEO's follow-up to
  PR #48): the "→ <kind>" chip that marked linked conversations on the index
  now also renders in the conversation's own header — next to the status badge,
  for BOTH populations (legacy email transcripts and page-born `conv-*`
  threads) — deep-linking the generated document's `/plans/<ref>` page. The
  trigger-join moved to one shared helper (`src/lib/threads.js`
  `artifactIndex`/`conversationArtifacts`) consumed by the index listing and
  both detail payloads (`GET /api/conversations/:id` and the conversation
  thread payload), so the resolution logic exists once. Unlinked conversations
  show nothing new, and a log API that cannot serve the reverse lookup renders
  the pages chip-less — never broken.

- **Conversation archive for both populations + artifact-linkage badges**
  (central-DB test plan `hub-conversation-archive-ui-2026-08-17`; piece 2 of the
  feature whose log-API half landed as workspace `764232d`): every conversation
  — legacy email AND page-born `conv-*` — can now be archived and unarchived
  from the UI, fully reversible, never deleted, deliberately without a confirm
  dialog (CEO ruling 2026-08-17: archive means drop it — the inbox runner skips
  archived threads and unarchiving restores eligibility). A page-born thread
  archives by PATCHing every backing conversation row from its own thread read;
  its archive state rides the anchor listing's new `conversation_status`, and
  its thread page grows the status badge + archive control. Index rows whose
  conversation generated a document (a role-`trigger` thread entry, read in ONE
  `GET /thread?role=trigger` call) wear a small artifact chip deep-linking
  `/plans/<ref>`. Backing rows of page-born openers dedupe out of the merged
  listing, and the opener's message ref is now the `conv-*` doc_ref itself
  (piece-1 contract). Everything feature-detects: a pre-piece-1 log API renders
  the page badge-less and archives fail with a clean inline error, never a
  broken page.

### Changed

- **VM deploy targets renamed to hub** (devops VM pass, the deferred half of the
  rename above): the host directories are now `~/agent/hub` and `~/agent/hub-staging`,
  the compose projects/containers `hub` / `hub-staging` (`hub-app-1`, `hub-caddy-1`,
  `hub-staging-app-1`), the 5-minute host cron runs `deploy.sh hub`, and both deploy
  clones point explicitly at `https://github.com/hectorolan/hub.git` instead of relying
  on GitHub's rename redirect. This repo's half: the CD workflow's deploy target and
  self-hosted runner label (`hub-vm` — no runner is registered today, so the label is
  free to change; a future runner must register with it), plus the VM paths quoted in
  `README.md` and `docker-compose.yml`. DNS, OAuth redirect URIs and the Google Cloud
  project name remain `ho-nexus` by design.

- **Renamed ho-nexus → hub** (the CEO's ruling 2026-08-15, executed 2026-08-16;
  hub go-public program step 4; central-DB test plan
  `hub-rename-mechanics-2026-08-16`): GitHub repo is now `hectorolan/hub` (old
  URLs redirect), package name `hub`, and every internal naming reference —
  docs, comments, brand strings, page-comment meta `source` (now `"hub"`; the
  workspace intake matches only `pageType`/`slug`, so anchoring is unaffected),
  test/e2e fixtures and labels — follows. Deliberately unchanged: the DNS label
  `ho-nexus.westus2.cloudapp.azure.com`, the Google Cloud project name and
  registered redirect URIs (OAuth/Azure-bound, own sub-decision — default keep),
  and VM-bound values (`deploy.sh ho-nexus`/`ho-nexus-staging` targets,
  `~/agent/ho-nexus*` dirs, the `ho-nexus-vm` runner label) until the separate
  devops VM pass. Dated history (this changelog, provenance comments) keeps the
  old name.

### Added

- **Tests-subtab explainer** (central-DB test plan
  `hn-tests-explainer-2026-08-16`): the Documents → Tests view now opens with a
  short standfirst for users who didn't build the system — test plans are proof
  of correctness, they close automatically once their evidence is complete (PR
  merge or a green run), open ones are in progress or waiting on your attention
  (follow up in a Claude session), and closed ones stay as history. Static copy
  on the existing IndexCard `sub` pattern, `/tests` only — no new CSS or
  component, no dismiss state.

- **CEO-is-config sweep** (the CEO, 2026-08-15; hub go-public program step 3;
  central-DB test plan `hn-ceo-is-config-2026-08-15`; findings
  `hub-history-scan-2026-08-15` F1/F2): the operator's identity leaves the
  tree. F1 — the auth allowlist is now the `ALLOWED_EMAIL` env var
  (`src/config.js`), FAILING CLOSED: unset/empty denies every login
  (`requireAuth` + `validateIdTokenClaims` both refuse an empty allowlist) and
  one loud boot line names the missing var; `.env.example` documents it as
  required. F2 — a new server-side identity client (`src/lib/identity.js`)
  reads the workspace log API's `GET /identity` (5-min cache, generic
  `the CEO`/`Hub` fallback on any failure — a page render never breaks because
  the API is down), a gated `GET /api/identity` serves it to the SPA, the nav
  brand renders `identity.hubTitle`, and legacy-conversation speaker labels
  render `identity.name` with the generic `ceo` rail class (the personal CSS
  class is gone). Every doc/comment/fixture mention of the real name or email
  became "the CEO", a config reference, or a fixture value (`owner@example.com`,
  `Fixture Owner`, `E2E Fixture Hub`); the e2e stub log API now serves
  `/identity` with fixture values and tests assert those. Real identity remains
  only in CHANGELOG history entries and the LICENSE copyright line (provenance).

- **Apache-2.0 license** (the CEO, 2026-08-15; hub go-public program step 1):
  verbatim Apache License 2.0 text at `LICENSE` (copyright line from the
  workspace `configs/environments.json` `ceo.name`, year 2026),
  `"license": "Apache-2.0"` in package.json, and a README License section.
  The CEO's merge of the PR is the legal adoption act. Prose/metadata only;
  no behavior change.

### Changed

- **Docs truth pass after the nav restructure** (the CEO, 2026-08-15; central-DB
  test plan `hn-docs-truth-audit-2026-08-15`): CLAUDE.md, README.md, the
  docker-compose/.env.example/src/config.js comments and one e2e describe label
  now state the merged #40/#41 nav — top tabs Digests · Documents · Claude,
  Documents subtabs Plans/Tests/Records/Conversations (with the reversed
  `/plans?kind=conversation` → `/conversations` redirect), the old Knowledge
  card as Core under Claude, and `/` as the latest digest lighting no tab. The
  README section table gains the Tests/Records/Stations rows it never had, and
  CLAUDE.md's stale "`ops/log.md` logging format" phrase now names the
  central-DB `ws log` audit trail. Prose only; no behavior change.

- **Documents is a grouping tab: Plans · Tests · Records · Conversations
  subtabs** (the CEO, 2026-08-15; central-DB test plan
  `hn-documents-subtabs-2026-08-15`): the Documents section now uses the same
  subtab strip as Claude — `/plans` (the landing) shows open kind=plan rows,
  `/tests` shows open test-plans with held ones (pinned CEO block) flagged
  "needs the CEO" and sorted first and the closed list behind a toggle,
  `/records` merges design/audit/doc/baseline (+ any future kind) with kind
  chips and an archived toggle, and `/conversations` is a real page again
  hosting the merged conversation listing (its archived legacy rows behind a
  toggle). Display-layer grouping only — no change to the DB, the plan kinds,
  the statuses, or the workspace `/plan` API; ho-nexus's own `/api/plans`
  gains `view=tests|records` and `archived=1`. Every pre-subtab URL keeps
  working: `/plans?kind=…` redirects to the owning subtab (repo carried,
  done/archived statuses mapped onto the toggles) and `/plans?kind=conversation`
  now redirects to `/conversations` — the reverse of the N2-era redirect.
  `/plans/:slug` stays the canonical detail URL for every kind and lights the
  subtab owning the loaded document's kind; the `baseline` kind joins the badge
  roster.

- **Top nav regrouped: Digests · Documents · Claude, and the homepage lights no
  tab** (the CEO, 2026-08-15; central-DB test plan
  `hn-nav-restructure-2026-08-15`): the Plans tab is relabeled **Documents**
  (label only — /plans and /plans/:slug unchanged, conversations still grouped
  under it), and the Agents / Skills / Stations top-level entries move under a
  new **Claude** tab with subtabs **Core / Agents / Skills / Stations**. Core is
  a new additive `/knowledge` index route hosting the governing-docs
  ("Knowledge") list that previously sat as a second card on /agents — same
  `/api/agents` payload, no API change, and every existing URL keeps working
  (no renames, no redirects needed). The active-state bug is fixed in the same
  change: `sectionOf`'s bare `digests` fallback lit the Digests tab on `/` and
  on unknown paths — a tab now lights only on its own routes, so `/` (the
  latest-digest home) and 404s show no active tab (supersedes the
  keep-Digests-active call in `test-plan-home-latest-digest`), /digests* keeps
  Digests lit, and /conversations* lights Documents.

### Added

- **Document threads on every remaining md-backed page** (backlog item 71; test
  plan `test-plan-document-threads-n3`): agent, skill and knowledge detail
  pages now render their document's thread below the published result — same
  components as digest/plan pages (roles, real message dates, provenance keys,
  trigger banner first, "Add to this thread" box at the foot; the thread never
  bleeds into the document body). The legacy comment-box presentation on
  agents/skills pages is retired — identical POST machinery and trust boundary.
  `knowledge` is a NEW pageType end to end (those pages had no comment box at
  all): mapped to doc_kind `knowledge` in both `src/lib/threads.js` and the
  workspace intake map (`workspace/server/threads.js`, landed on workspace
  main), with the raw doc source re-fetched server-side as comment context and
  never exposed to the browser (TP-nexus-thr-012, TP-page-comments-015/016,
  TP-agents-skills-015, TP-nexus-e2e-086..088, workspace TP-dthr-014).

### Changed

- **One template for the indexes, one for the document pages** (the CEO's
  consolidation, 2026-08-02; test plan `test-plan-index-row-template`): every
  two-line index — Plans, the conversation view, Digests, Agents, Knowledge,
  Skills — renders through `IndexRow`/`IndexCard`
  (`client/src/components/IndexRow.jsx`), and every comment-bearing document
  page — plan, digest, agent, knowledge doc, skill, legacy conversation —
  through `DocumentPage` (the reading-col → cards → pager → Thread scaffold);
  each section keeps only a thin adapter (fetch + map to
  `{href, title, desc, date, refKey, count}`). Pure string mapping lives in
  `row-format.mjs` so the Node runner pins its edges
  (TP-index-template-001..004). ZERO visual change: every existing Playwright
  assertion passes unchanged. The thread-only conversation page stays bespoke
  on purpose (the thread IS the content — no document card, pager below the
  thread); Stations renders cards, not rows, and is untouched.
- **The `history` plan kind is retired** (CEO 2026-08-02; test plan
  `test-plan-history-kind-removal`): archived items keep their original kind
  (`plan`/`audit`/`design`/`test-plan`/`doc`) with `status: archived` — a
  separate `history` kind only obscured what a thing originally was. The
  workspace side re-kinded all former `history` rows and dropped the kind from
  the log API's `PLAN_KINDS` first (workspace `768e97a`/`d085dc9`); ho-nexus
  now drops the chip from the Plans kind filter, its badge CSS, and the KINDS
  guard (`?kind=history` is ignored like any unknown kind). The `archived`
  status filter shows each item under its real kind chip (TP-hist-rm-001/002,
  TP-nexus-e2e-090/091).

- **Agents/Skills/Knowledge indexes join the two-line row idiom with comment
  counts** (the half PR #32 deferred): line 1 the name and its chips, the
  curated summary as its own line, then the machine facts — the row's key
  (`agents/<name>`, `skills/<name>`, `knowledge/<slug>`) with the thread-entry
  count pushed right, silent at zero; counts join server-side from the
  `/thread` anchor listing, best-effort — an unconfigured or failing log API
  means no counts, never a broken index (these sections read the filesystem
  and must work without the API at all). Origin chips and curated summaries
  survive unchanged (TP-agents-skills-013/014, TP-nexus-thr-013,
  TP-nexus-e2e-089).

### Fixed

- **Duplicate case-ID claims resolved by suffix** (test plan
  `hn-test-plan-2026-08-02-case-id-suffix`): PR #33 and PR #34 independently
  claimed `TP-nexus-e2e-078..080`; the second claimants (PR #34's tests) are
  now `078_2`/`079_2` (`e2e/threads.spec.js`) and `080_2`
  (`e2e/conversation-threads.spec.js`) — suffix, never renumber (CEO
  2026-08-02). The citing test plan `test-plan-thread-entry-provenance` was
  updated in the DB to match. New CI job `case-ids` runs the vendored
  `scripts/case-id-check.mjs --refs origin/main` (source of truth:
  workspace `cli/util-tools/case-id-check.js`) and fails the build on any
  true duplicate — two test titles asserting one ID; comments and fixtures
  citing an ID are references, never collisions.

- **Thread entries stamp the MESSAGE's date, never the link time** (test plan
  `test-plan-thread-entry-provenance`): entries rendered `entry.created` — for
  backfilled history that is the day the entry was attached to its document,
  not the day the words were written (a 2026-07-25 conversation displayed as
  08/02). The stamp is now `message.date` + the `HH:MM` from `message.ts`;
  `entry.created` stays ordering plumbing only (TP-nexus-thr-010,
  TP-nexus-e2e-078_2).

### Changed

- **Provenance keys under each thread entry's date** (same test plan): a
  `--font-data` meta line — `conversations/<conversation_id>` when the message
  has a source conversation (workspace log API `de7b932`; null degrades to no
  segment), then `message <id>`, then the message `kind` — on entries in every
  document thread and on the conversation view's own thread page, so any entry
  traces back to how it is saved. The trigger banner stays; the provenance line
  joins it (TP-nexus-thr-011, TP-nexus-e2e-079_2 and TP-nexus-e2e-080_2).

- **The homepage is the latest digest again; /digests keeps the index** (CEO
  call; test plan `test-plan-home-latest-digest`): `/` now renders the NEWEST
  digest in full — body + its document thread — via the same `DigestPage`
  component the `/digests/<date>` route uses, so the morning read is one click
  on the brand with no date needed. `/digests` remains the index page PR #33
  shipped (two-line rows, newest first, subject titles), reached through the
  "Digests" nav item (`['Digests', '/digests', 'digests']`); both paths keep
  the Digests nav item active via the existing `sectionOf` fallthrough. Deep
  links `/digests/<date>` and legacy `?date=X` redirects (on both `/` and
  `/digests`) are unchanged; an empty digest history renders the quiet
  states-idiom line on `/`, never chrome (TP-nexus-e2e-082..085;
  TP-nexus-e2e-078/-002 amended to pin the index at `/digests`).

- **The Digests section is an index page** (backlog item 70; test plan
  `test-plan-digest-index`): `/digests` (and the landing `/`) now renders the
  digest LIST — two-line rows in the PR #32 idiom, newest first: line 1 the
  digest title (the stored message subject verbatim, falling back to
  `Daily Digest — <date>` for subject-less history, so the composed report
  titles of backlog item 72 light up with zero further UI work), line 2
  `date · digests/<date>` with the comment count pushed right, nonzero only
  (joined best-effort from the `/thread` anchor listing — a join failure never
  breaks the index). The jump-to-latest landing redirect is retired: the CEO
  lands on the list and picks by date. The detail page's date dropdown retired
  with it — the index IS the date navigation; a `← All digests` pager (the
  PlanPage idiom) leads back, and the detail payload slims to `{date, html}`.
  Deep links survive: `/digests/<date>` renders directly (emails carry them)
  and legacy `/digests?date=X` still redirects. No digests → a quiet empty
  line, not chrome (TP-digest-index-001..007, TP-nexus-e2e-078..081;
  TP-nexus-e2e-001/-003/-074 and TP-nexus-n2-011 retired with the behaviors).

- **Two-line index rows on the Plans page** (test plan
  `test-plan-two-line-index-rows`): every row on the Plans index (all kind
  filters) and the conversation view is now two lines, always — line 1 the name
  with its chips (kind, status, repo), line 2 the machine facts in the data
  voice: date first, then the row's key, with the comment count pushed to the
  right edge and rendered only when nonzero (the zero-silent convention keeps
  its data path, moved position). Every row type carries its key: plan rows the
  slug, conversation rows `conversations/<ref>` (previously keyless). Scoped by
  a `.two-line` modifier on `ul.conv-index`, so the Agents/Skills/Knowledge
  indexes keep their single-line summary idiom; the digest date list is a
  `<select>` picker — a different idiom, untouched (TP-nexus-e2e-075..077).

### Added

- **Conversations on the Plans page + thread counts** (design: central-DB plan
  `nexus-document-threads-design`, N2 — the final phase; test plan
  `test-plan-document-threads-n2`): every Plans-index row whose document has a
  thread shows its entry count (joined server-side from the `/thread` anchor
  listing, best-effort — zero is silent, a join failure never breaks the index),
  and the digest date picker shows the same per-date counts. The Plans page
  gains the `conversation` kind: document-less threads (doc_ref convention
  `conv-<epoch-ms>`, documented in CLAUDE.md) merged with active legacy email
  conversations, newest activity first, plus a "Start a conversation" compose
  box whose opener rides the SAME page-comment intake machinery as every comment
  (meta `conversations/conv-<ts>`, instruction-only body — the inbox tick
  answers into the thread + email, no new answer path). `/conversations/conv-*`
  is the thread-only page; legacy pages keep their read-only transcript and gain
  their document thread + thread-mode box below. The Conversations section and
  its nav entry are removed — `/conversations` redirects to
  `/plans?kind=conversation`, and numeric deep links keep resolving, so old
  bookmarks and digest emails never 404. `GET /api/conversations` (the index
  route) retired with the page; `POST /api/conversations` is the compose
  endpoint (TP-nexus-n2-001..012, TP-nexus-e2e-069..074).

- **Document threads below digest and plan pages** (design: central-DB plan
  `nexus-document-threads-design`, N1; test plan `test-plan-document-threads-n1`):
  each digest and plan detail page renders its thread — the CEO commenting, the
  agent answering, in flat order — read server-side from the workspace log API's
  `GET /thread` (W1) via `src/lib/threads.js` with the same pageType→doc_kind
  map W1 records. Role-`ceo` entries display the instruction section only (the
  page-context echo never renders); `trigger` entries pin to the top marked as
  the document's origin; every body passes the one sanitized-markdown pipeline
  (thread bodies are untrusted quoted data, WS-H2). The comment box becomes
  "Add to this thread" at the thread's foot on those pages (same confirm-only
  POST machinery; a successful post refetches so the new CEO entry appears
  without a reload) — other detail pages keep the legacy presentation until N2.
  The e2e stub gains `/thread` fixtures + intake-capture emulation
  (TP-nexus-e2e-064..068).

### Changed

- **Desktop reading column** (follow-up to the mobile density rework #26;
  central-DB test plan `hn-test-plan-2026-08-01-mobile-density`, cases 062–063):
  at 1280px a reading page showed three competing widths — card ~1030px,
  heading hairlines ~710px, prose ~551px — a wide card holding a left-pinned
  column with an empty right third. The split rule: pages whose main content
  is prose (digest, plan, agent/skill README, knowledge doc, conversation
  thread) wrap in `.reading-col` — the card narrows to hug the measure and
  centres, so card edge, hairlines, and prose share one edge; row/table pages
  (indexes, Stations) stay full width. Tokens: `--measure-col` (551px, the
  54ch measure resolved at the desktop reading face — `ch` resolves against
  each element's own font, so the sans column can't consume `--measure`
  directly) and `--reading-col-max`; `--lh-reading` 1.6→1.5 at root (phone
  1.55 override untouched). Desktop body stays 17px (mid 16–20px band;
  shrinking it to fill width would trade readability for apparent density).
  cpl unchanged at 47.2/69.3/69.3 (375/768/1280); phone metrics byte-identical.
  Guards: TP-nexus-e2e-062 (card content box = prose width ±8px on a reading
  page) and 063 (index card stays full width); 055's chrome bound dropped —
  centering margins now dominate viewport−card above the column cap.

- **Mobile density + readability rework** (central-DB test plan
  `hn-test-plan-2026-08-01-mobile-density`): two fixes, separately. Layout —
  chrome at 375px drops from 22% of the viewport to ~12% via responsive
  `--pad-shell-*`/`--pad-card-*` tokens stepped at two documented breakpoints
  (phone 480 / tablet 768, replacing the single 760px query), and the section
  nav wraps instead of forcing horizontal scroll. Density — the reading scale
  steps down to 15px on phones (17px serif tops out at ~44 cpl even at zero
  chrome, so smaller type is what reaches the 45–75 readable band), `--measure`
  tightens 72ch→54ch (72ch rendered ~92 characters of average prose per line —
  Plex Serif's `ch` is ~10.2px vs ~7.95px per average glyph), and vertical
  rhythm tightens (card/heading/paragraph/list margins, `--lh-reading`
  1.65→1.6, 1.55 on phones). Guards: `e2e/responsive-density.spec.js`
  (TP-nexus-e2e-054..057) on shared metrics (`e2e/density-metrics.js`);
  before/after numbers + screenshots from `node e2e/measure-density.js` in
  `docs/density/`. Result at 375px: 36.6→47.2 cpl, chrome 22.4%→11.7%,
  horizontal overflow gone; 768/1280: 82/92→69 cpl.

### Added

- **Per-service dependency panel on the Stations page** (central-DB test plan
  `hn-test-plan-2026-08-01-stations-dep-panel`; the ho-nexus rendering half of the
  workspace `cp-env` per-service rework, workspace `655e1d0`): `cp-env:<svc>` /
  `cp-env:<svc>:<KEY>` checks now group by service — a summary line (state badge +
  ready/off/missing counts) over the FULL labelled capability list, visible on
  healthy services too: what a service depends on, before anything breaks. Three
  states read differently with no new visual devices (the 3px rail one level
  deeper): ready quiet, off dashed-neutral with its what-it-costs note, missing
  oxide alert. Grouping derives from id/name/detail strings alone — the
  `{id, level, name, detail}` trim is untouched — and an old-format bare `cp-env`
  check falls through to the generic check-list so a pre-migration report keeps
  its failure visible. `.env.example` gains `# env-doctor:` capability markers
  ("Google sign-in", "Signed session cookies", "Public address", "Digests,
  Conversations & Plans", "Login bypass", …) so this repo's vars read as
  capabilities, and legitimately-empty optional vars read as off, never missing
  (grammar: workspace SYSTEM.md "Per-service env health").

- **Manual case TP-readme-summ-011 converted to Playwright** (central-DB test plan
  `hn-test-plan-2026-08-01-manual-to-e2e`; backlog 61): the last manual case
  holding `hn-test-plan-2026-07-26-readme-summaries` open is now the e2e case
  TP-nexus-e2e-036 — every Agents/Skills index row must render exactly its curated
  README summary cell, never the frontmatter fallback. The fixture
  `e2e/fixtures/claude/README.md` is rewritten to mirror the real
  `.claude/README.md` shape (prose around the tables, markdown and escaped `\|`
  pipes inside cells, `external — repo` origin cells, trailing non-table section)
  so the parser is exercised against the live document's structure in CI. No
  product code changed.

- **Stations page — the station registry rendered** (central-DB test plan
  `hn-test-plan-2026-07-28-stations-page`; W3 ho-nexus half, decision D1b in
  `environment-setup-streamlining`): a new nav section reading the workspace log
  API's `GET /station?format=json` server-side. Three states read differently —
  healthy (quiet card, "N checks ok"), stale (amber, the control plane's 45-min
  verdict echoed, never recomputed in the browser), and never-reported (muted and
  deliberately normal: a new box or an empty DB is not a failure). Failing
  env-doctor checks (missing `fallbackModel`, unregistered pull task) are the
  headline — visible without interaction; the full check table (tool versions,
  gh scope names) folds behind a native disclosure. Checks are trimmed to
  `{id, level, name, detail}` strings server-side (`data`/raw report dropped), so
  secret-shaped values have no path to the browser. `/stations?stale_minutes=`
  forwards the API's staleness-window override.

- **Curated README summaries on the Agents/Skills indexes** (central-DB test plan
  `hn-test-plan-2026-07-26-readme-summaries`): the index rows now show the
  human-curated one-liners from the workspace `.claude/README.md` tables (Skills
  "What it does", Agents "Role"), parsed at render time — the README stays the one
  home of those summaries, no new metadata file. Frontmatter descriptions are
  model-routing trigger text and move off the indexes, but stay on the detail pages
  labeled "Trigger description (frontmatter)". `/api/skills` and `/api/agents` index
  rows gain a `summary` field (`description` unchanged); a skill/agent without a
  README row — or a missing/unparsable README — degrades per-item to the frontmatter
  description, never an error. No new styles: detail labels reuse the `dl.meta`
  ledger pattern.

### Fixed

- **Frontmatter block scalars rendered as ">" / ">-"** (same test plan,
  TP-readme-summ-012..014): the minimal frontmatter parser only read the same-line
  value after `description:`, so skills using YAML block scalars
  (cicd-pipeline-skill and jest-skill use `>`, cloud-solution-architect `>-`)
  showed a literal indicator character. The parser now consumes the indented
  block — folded style joins lines with spaces (blank line = paragraph break),
  literal style keeps newlines, `-` chomping strips the trailing newline. A sanity
  net asserts every description in the fixture tree (and, when the sibling
  workspace repo is present, the real `.claude` tree) is non-empty and never
  starts with a block-scalar indicator.

- **Skills origin column + sha-pinned upstream links** (central-DB test plan
  `hn-test-plan-2026-07-26-skills-origin`): the Skills index now shows each skill's
  origin — a plain "workspace" chip for skills authored in the workspace repo, or an
  "external ↗" chip for skills vendored from an upstream GitHub repo per
  `.claude/skills/sources.json`. External chips open the upstream tree in a new tab
  (`target="_blank"`, `rel="noopener noreferrer"`), and all upstream URLs (index and
  detail) are now pinned to the vendored commit
  (`https://github.com/<repo>/tree/<sha>/<path>`) instead of a moving `main`; entries
  without a sha degrade to `main`. `/api/skills` carries the same `upstream` object the
  detail endpoint already returned (null = workspace-authored). The skill detail page
  gains a header card with the frontmatter description. Chips are token-driven
  (`--t-fast` transitions, accent/paper/line palette — no new values).

### Changed

- **Visual architecture refactor: Express API + React SPA** (phase 6 of the
  workspace `skills-integration-migration` plan; central-DB test plan
  `hn-test-plan-2026-07-26-react-refactor`): the EJS views retire. Express is now
  strictly the backend — auth wall, `/api/*` JSON endpoints (same data semantics,
  filters, and guards as the old page routes), and static hosting of the Vite/React
  SPA (`client/` → `dist/`, gitignored). Markdown sanitization stays server-side
  (API responses carry sanitized HTML only); CSP tightens to `script-src 'self';
  style-src 'self'` (the inline-script nonce era ends). New token-driven design
  system ("field ledger": IBM Plex Serif/Sans/Mono, 4px grid, explicit type scale,
  viridian accent, 150–300ms transitions, status-rail signature). Behavior parity
  held by the updated unit suite (API-level) and the 30-spec Playwright suite:
  OIDC gate + allowlist, digest date dropdown, plan filters/badges, archive flow,
  upstream-source line, and every comment-modal guard. Multi-stage Dockerfile keeps
  the runtime image dev-dependency-free and caps the build-stage Node heap for the
  1-GB VM. The no-JS `<noscript>` digest fallback retires with the SPA
  (`/digests?date=` links still redirect client-side).

### Removed

- **Dead `DIGESTS_DIR` wiring** (central-DB test plan
  `hn-test-plan-2026-07-24-remove-digests-dir`): removed `config.digestsDir` and its
  `DIGESTS_DIR` env var, the `.env.example` entry, the `DIGESTS_DIR` env + digests
  bind-mount in `docker-compose.yml`, and the leftover file-era `makeDigestsDir` test
  fixture. Digests have read from the DB since PR #11, so nothing in the app read these.
  No behavior change. The production compose file (kept on the VM, not committed here)
  drops its digests mount on the next deploy — safe because the container no longer reads
  those files.

### Changed

- **Digests read from the DB, not files** (central-DB test plan
  `hn-test-plan-2026-07-24-digests-db`): the Digest section now reads the workspace
  log API's `daily-digest` message kind server-side (`GET /message?kind=daily-digest`
  for the date list, `GET /message/:id` for one body) instead of `DIGESTS_DIR` markdown
  files. `LOG_API_URL` + `LOG_API_KEY` stay server-side (X-Api-Key header, never the
  browser), and the section shows a "not configured" page when `LOG_API_URL` is unset —
  the same pattern as Conversations/Plans. The PR #10 single-date-dropdown UX (newest
  preselected + its digest loaded on open, `<noscript>` fallback, page-comments box,
  strict date guard) is unchanged; only the data source moved. A digest's date comes from
  the message `ref`/`subject`, not the row's `date` column; date collisions keep the
  highest message id. (`DIGESTS_DIR` and the digests compose mount, left unused by this
  change, are removed in the "Dead `DIGESTS_DIR` wiring" entry above.)

### Security

- **Markdown output sanitized everywhere** (2026-07-24 audit, finding C): every
  `marked.parse` sink (plans, conversations, digests, agents, skills, knowledge)
  now renders through one shared `renderMarkdown` wrapper (`marked` +
  `sanitize-html`) — `<script>`, event-handler attributes, and `javascript:`
  URLs from stored/external markdown are stripped. A strict per-request
  `Content-Security-Policy` (`script-src 'self' 'nonce-…'`, `object-src 'none'`,
  `frame-ancestors 'none'`) backs it up; the comment-box inline script carries
  the nonce.
- **AUTH_BYPASS production guard** (finding A): `configFromEnv` refuses to start
  when `AUTH_BYPASS=true` and `BASE_URL` is `https://` (the prod signal) instead
  of relying on deploy-time checks alone.
- **Comment box hardening** (findings E/F): Send/Confirm disabled while a request
  is in flight (no double sends); both textareas capped at `maxlength=20000` with
  the limit stated in the 400 message; oversized (>64kb) or malformed bodies get
  JSON-shaped 413/400 errors instead of Express's HTML defaults.
  Test plan: central-DB `hn-test-plan-2026-07-24-audit-remediation`.

### Added

- **Conversation archiving + default-view filters + digest date dropdown**
  (central-DB test plan `hn-test-plan-2026-07-24-archive-filters-digest-dropdown`):
  - Conversations are archivable — an Archive/Unarchive control (POST form → ho-nexus
    route → `PATCH /conversation/:id {status}` server-side; the API key never reaches the
    browser) on both the list and the thread page. The default list requests
    `?status=active`; a status toggle (Active / Archived / All) reaches archived history.
  - The Plans default view requests `?exclude=done,archived`, so terminal and archived
    plans are hidden by default (still reachable via the status filter, which overrides
    the exclude). The exclude is also enforced app-side, so it holds before the workspace
    API deploys `?exclude=`. Conversation rows with no `status` normalize to `active` for
    the same pre-deploy tolerance.
  - The Digest page replaces the date index + prev/next flow with ONE date `<select>`
    (most recent preselected and rendered on load); `/` redirects to the newest digest.
    The strict date guard and the page-comments box are preserved. (The data source moved
    from `DIGESTS_DIR` to the DB in the "Digests read from the DB" change above.)

- **Plan kinds** (`/plans`): plans carry a `kind` badge
  (`plan`/`audit`/`design`/`history`/`test-plan`/`doc`) on index and detail, with
  a `?kind=` filter that combines with the status filter. `history`, `test-plan`,
  and `doc` (added by the logs-retirement migration) are now filterable and each
  has its own badge style. Filtering happens app-side, and rows without the field
  render as `plan`, so the page works before and after the workspace API deploys
  the `kind` column. Test plan: central-DB `hn-test-plan-2026-07-24-plans-six-kinds`.

- **Page comments** (`POST /page-comments` + shared comment-box partial): every content
  detail page (plans, digests, agents, skills, conversations) ends with a comment box —
  submit opens a "Confirm content and send" modal pre-filled with the typed text, and
  only the modal's confirm sends. The server re-fetches the page content through the
  same lib functions that render it and stores a `page-comment` message in the
  workspace log API (contract: central-DB plan `page-comments-design`) for the inbox
  automation to answer by email. Behind the existing Google-login gate; failures keep
  the typed text in the box. Test plan: central-DB `hn-test-plan-2026-07-23-page-comments`.

- **Plans page** (`/plans`, `/plans/:slug`): browse every plan in the central log DB
  (workspace log API `/plan` endpoints) — index newest-updated-first (title, slug,
  status badge, updated date, optional status filter) and a detail view rendering the
  full markdown body. Fetched server-side per request (no caching) with
  `LOG_API_URL`/`LOG_API_KEY` (key never reaches the browser), so a plan is visible
  the moment it is created or updated; behind the existing Google-login gate.
  Unconfigured or unreachable log API degrades to friendly 503/502 pages. Test plan:
  central-DB `hn-test-plan-2026-07-23-plans-page`.

- **Agents & Skills pages** (`/agents`, `/agents/:name`, `/knowledge/:slug`,
  `/skills`, `/skills/:name`): browse the workspace agents (frontmatter meta +
  rendered markdown body), their governing Knowledge docs (workspace `CLAUDE.md`,
  `SETUP.md`), and the workspace skills (rendered `SKILL.md`), read live from
  `WORKSPACE_CLAUDE_DIR` (default `../workspace/.claude`; prod points into the
  `workspace_sources` volume). Behind the existing Google-login gate; detail
  params validated against the directory listing (traversal-safe); missing dir
  degrades to a friendly empty state. Test plan:
  central-DB `hn-test-plan-2026-07-22-agents-skills-pages`.

- **Conversations viewer** (`/conversations`, `/conversations/:id`): browse the email
  ask/response history threaded by the workspace log API — list newest-activity-first
  (title, date, message count) and a readable thread view (Hector's questions, agent
  replies/failure notices, markdown rendered). Server-side authenticated with
  `LOG_API_URL`/`LOG_API_KEY` (key never reaches the browser); behind the existing
  Google-login gate. Unconfigured or unreachable log API degrades to friendly
  503/502 pages. Test plan: central-DB `hn-test-plan-2026-07-17-conversations-viewer`.

## 0.1.0 — 2026-07-16

- Initial release: Google OAuth (owner-only) + daily digest viewer (PR #1),
  production digests volume fix (PR #2), GitHub Actions CI (PR #3).
