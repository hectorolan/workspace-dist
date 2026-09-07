'use strict';

/**
 * Stub of the workspace log API, for the Playwright end-to-end suite only.
 *
 * The app talks to the log API server-side for Digests, Conversations, Plans and
 * page comments (see src/lib/*.js). Pointing the browser suite at the real API
 * would make it non-deterministic and would write to the central DB, so the
 * suite runs against this fixture server instead. It implements exactly the
 * endpoints those libs call, with the envelope shapes documented in
 * `workspace/server/README.md`:
 *
 *   GET   /message?kind=daily-digest&format=json&limit=  -> {ok, count, entries[]}
 *   GET   /message/:id                                   -> text/plain header + body
 *   POST  /message                                       -> {ok, id}   (page comments)
 *   GET   /plan?format=json[&status=|&exclude=]          -> {ok, entries[]}
 *   GET   /plan/:slug?format=json                        -> {plan}
 *   GET   /conversation?format=json&limit=[&status=]     -> {ok, conversations[]}
 *   GET   /conversation/:id                              -> {conversation, messages[]}
 *   PATCH /conversation/:id                              -> {ok}
 *   GET   /station?format=json[&stale_minutes=]          -> {ok, stations[], never_reported[]}
 *   GET   /feature?format=json[&stale_minutes=]          -> {ok, stations[], features[]} (feature-major
 *                                                           aggregate, Part B — states are the control
 *                                                           plane's verdicts, hardcoded here)
 *   GET   /thread?doc_kind=&doc_ref=                     -> {ok, entries[]} (document threads, W1)
 *   GET   /thread[?doc_kind=]&format=json                -> {ok, threads[]} (anchor listing + counts, N2;
 *                                                           piece-1 rows carry conversation_id/conversation_status)
 *   GET   /thread?role=[&doc_kind=&limit=]               -> {ok, entries[]} (flat-entries mode, piece 1 —
 *                                                           role=trigger is the artifact reverse lookup)
 *   GET   /identity                                      -> {ok, identity} (fixture identity — naming-is-config)
 *
 * Test-control endpoints (never part of the real API, prefixed `__` so they can
 * never collide with it):
 *   GET  /__captured        -> {posts[]}  every POST /message the app made
 *   POST /__reset           -> clears captures and failure modes
 *   POST /__fail-next       -> the next POST /message answers 502 (failure path)
 *   POST /__fail-features   -> the next GET /feature answers 500 (error-card path)
 *   POST /__fail-stations   -> the next GET /station answers 500 (soft-degrade path:
 *                              the matrix renders with plain header names)
 *   POST /__legacy-thread   -> GET /thread behaves pre-piece-1 until reset (degradation path)
 *
 * Run standalone: `node e2e/fixtures/stub-log-api.js --port 8791`
 */

const http = require('node:http');

/** Instance identity fixture (GET /identity) — deliberately fake values. */
const IDENTITY = { name: 'E2E Fixture Owner', pronouns: 'they/them', hubTitle: 'E2E Fixture Hub' };

const DIGEST_DATES = ['2026-01-01', '2026-01-02', '2026-01-03'];

/**
 * Subjects prove the digest-index title rule (TP-nexus-e2e-078): the newest
 * digest carries a composed headline (the item-72 shape — a report title riding
 * the stored message subject), the middle one the runner's standard subject,
 * and the oldest none at all — its index row must fall back to
 * `Daily Digest — <date>`.
 */
const DIGEST_SUBJECTS = {
  '2026-01-01': null,
  '2026-01-02': 'Daily Digest — 2026-01-02',
  '2026-01-03': 'Quiet markets, loud agents',
};

const digestBody = (date) => `# Daily Digest — ${date}

## World brief

- **Something happened** in the world. [Read more](https://example.com/story)
- Another bullet item.

## Tech news

Plain paragraph with **bold text** and a [link](https://example.com/tech).
`;

const DIGESTS = DIGEST_DATES.map((date, i) => ({
  id: 101 + i,
  ts: `${date}T07:00:00Z`,
  date,
  kind: 'daily-digest',
  subject: DIGEST_SUBJECTS[date],
  ref: i === 0 ? date : `${date}-daily-digest`,
  body: digestBody(date),
}));

const PLANS = [
  {
    slug: 'e2e-active-plan', title: 'E2E active plan', status: 'active', kind: 'plan',
    repo: 'workspace', updated_at: '2026-01-03T10:00:00Z',
    body: '# E2E active plan\n\n## Section one\n\nBody text with **bold**.\n',
  },
  {
    slug: 'e2e-nexus-test-plan', title: 'E2E hub test plan', status: 'active', kind: 'test-plan',
    repo: 'hub', updated_at: '2026-01-02T10:00:00Z',
    body: '# E2E hub test plan\n\n| ID | Case |\n|---|---|\n| TP-e2e-001 | A case |\n',
  },
  {
    slug: 'e2e-done-plan', title: 'E2E done plan', status: 'done', kind: 'design',
    repo: 'workspace', updated_at: '2026-01-01T10:00:00Z',
    body: '# E2E done plan\n\nFinished work.\n',
  },
  // Archived rows keep their ORIGINAL kind (the `history` kind retired
  // 2026-08-02) — this row proves the archived view shows real kind chips.
  // Invisible to default-view specs: the default excludes `archived`.
  {
    slug: 'e2e-archived-audit', title: 'E2E archived audit', status: 'archived', kind: 'audit',
    repo: 'workspace', updated_at: '2026-01-04T10:00:00Z',
    body: '# E2E archived audit\n\nRetired findings.\n',
  },
  // Documents-subtab rows (hn-documents-subtabs-2026-08-15). The HELD test-plan
  // is deliberately the OLDEST open test-plan: its body opens with the pinned
  // CEO blockquote (the plan-close shape), so the Tests subtab must flag it and
  // sort it first anyway (TP-docsub-008).
  {
    slug: 'e2e-held-test-plan', title: 'E2E held test plan', status: 'active', kind: 'test-plan',
    repo: 'workspace', updated_at: '2026-01-01T09:00:00Z',
    body: '> **Needs the CEO**\n> - TP-e2e-099 — flip the DNS switch\n\n# E2E held test plan\n\nManual case pending.\n',
  },
  {
    slug: 'e2e-closed-test-plan', title: 'E2E closed test plan', status: 'done', kind: 'test-plan',
    repo: 'hub', updated_at: '2026-01-03T09:00:00Z',
    body: '# E2E closed test plan\n\nAll cases green.\n',
  },
  // A baseline record (devops regression baseline) — Records subtab material.
  {
    slug: 'e2e-baseline', title: 'E2E workspace baseline', status: 'active', kind: 'baseline',
    repo: 'workspace', updated_at: '2026-01-05T10:00:00Z',
    body: '# E2E workspace baseline\n\nSuites and case IDs.\n',
  },
  // A done kind=plan row: proves the Plans subtab status chips still reach
  // done/archived plans (TP-docsub-007) with the kind pinned to plan.
  {
    slug: 'e2e-retired-plan', title: 'E2E retired plan', status: 'done', kind: 'plan',
    repo: 'workspace', updated_at: '2026-01-01T08:00:00Z',
    body: '# E2E retired plan\n\nShipped.\n',
  },
];

const CONVERSATIONS = [
  {
    id: '4001', title: 'E2E active thread', status: 'active',
    created_at: '2026-01-02T08:00:00Z', updated_at: '2026-01-02T09:00:00Z', message_count: 2,
    messages: [
      // Real store kinds, so the CEO-side speaker renders the /identity fixture
      // name with the generic `ceo` rail class (TP-ceoconf-013).
      { id: 1, kind: 'inbox-request', date: '2026-01-02', ts: '2026-01-02T08:00:00Z', body: 'What is the **status**?' },
      { id: 2, kind: 'inbox-reply', date: '2026-01-02', ts: '2026-01-02T09:00:00Z', body: 'All green.' },
    ],
  },
  {
    id: '4002', title: 'E2E archived thread', status: 'archived',
    created_at: '2026-01-01T08:00:00Z', updated_at: '2026-01-01T08:30:00Z', message_count: 1,
    messages: [
      { id: 3, kind: 'inbox', date: '2026-01-01', ts: '2026-01-01T08:00:00Z', body: 'Older question.' },
    ],
  },
  // The page-born thread conv-8100's BACKING conversation row (piece 1: a
  // page-comment opener is always assigned one — archive state lives here).
  // The merged index must never list it as its own row (opener dedupe,
  // TP-convarch-008); archive round-trips PATCH it and read the state back
  // through the anchor listing's conversation_status.
  {
    id: '4101', title: 'Conversation: Wire the beach house alarm', status: 'active',
    created_at: '2026-01-03T12:00:00Z', updated_at: '2026-01-03T12:15:00Z', message_count: 2,
    messages: [
      { id: 708, kind: 'page-comment', date: '2026-01-03', ts: '2026-01-03T12:00:00Z', body: '## Instruction\nWire the **beach house** alarm to the dashboard.\n' },
      { id: 709, kind: 'inbox-reply', date: '2026-01-03', ts: '2026-01-03T12:15:00Z', body: 'Wired — see the *stations* page.' },
    ],
  },
];

/**
 * Station registry fixture (`GET /station?format=json`, workspace/server/README.md
 * "Stations"). Verdicts are control-plane-side: the stub stands in for the control
 * plane, so IT computes `stale` from each row's fixed age vs `?stale_minutes=`
 * (default 45) — which also lets specs force the stale rendering via the override.
 * station-green is all-OK (age 4m) and carries the NEW per-service cp-env shape
 * (`cp-env:<svc>` summaries + `cp-env:<svc>:<KEY>` capability rows — the
 * dependency panel, TP-nexus-e2e-050..052); station-red is failing AND stale
 * (age 120m) with a missing capability; station-legacy holds an OLD-format
 * report (bare `cp-env` FAIL, the shape a station stores until its first
 * post-migration tick — TP-nexus-e2e-053); station-silent is configured but has
 * never reported. Some green/red rows carry env-doctor's plain-language
 * `explain` string (C-2 follow-up, test plan check-explainers-hub-2026-08-27);
 * station-legacy deliberately does NOT — it doubles as the pre-explain
 * cached-report population (TP-checkexp-e2e-007).
 */
const STATIONS = [
  {
    env: 'station-green', ts: '2026-01-03T10:00:00Z', date: '2026-01-03', platform: 'win32',
    ok: true, public_ip: '203.0.113.7', age_minutes: 4, configured: true,
    report: {
      results: [
        { id: 'node', level: 'OK', name: 'node', detail: 'v24.18.0', explain: "Verifies the Node.js runtime installed here is at least the minimum version the workspace's code is written for. If it fails, scripts may crash or misbehave until Node.js is upgraded on this machine." },
        { id: 'harness', level: 'OK', name: 'harness', detail: '~/.claude/settings.json matches desired fallbackModel', explain: "Compares the Claude Code settings file in this machine's home directory against the settings the workspace declares every machine of this kind should have." },
        { id: 'tool:gh', level: 'OK', name: 'tool gh', detail: '2.96.0' },
        { id: 'pull-task', level: 'OK', name: 'pull-task', detail: 'registered (Enabled), LastResult=0', explain: 'Verifies the Windows scheduled task that refreshes this machine every 15 minutes exists and is healthy.' },
        { id: 'gh-scopes', level: 'INFO', name: 'gh-scopes', detail: 'scopes: gist, read:org, repo, workflow' },
        { id: 'cp-env:hub', level: 'OK', name: 'cp-env:hub', detail: '~/agent/hub/repo/.env: 4 ready, 1 off, 0 missing of 5 capabilities (names from hub/.env.example; values never leave the host)' },
        { id: 'cp-env:hub:GOOGLE_OAUTH_CLIENT_ID', level: 'OK', name: 'hub: Google sign-in', detail: 'ready — GOOGLE_OAUTH_CLIENT_ID, GOOGLE_OAUTH_CLIENT_SECRET set in ~/agent/hub/repo/.env' },
        { id: 'cp-env:hub:BASE_URL', level: 'OK', name: 'hub: Public address', detail: 'ready — BASE_URL set in ~/agent/hub/repo/.env' },
        { id: 'cp-env:hub:SESSION_SECRET', level: 'OK', name: 'hub: Signed session cookies', detail: 'ready — SESSION_SECRET set in ~/agent/hub/repo/.env' },
        { id: 'cp-env:hub:LOG_API_URL', level: 'OK', name: 'hub: Digests, Conversations & Plans', detail: 'ready — LOG_API_URL, LOG_API_KEY set in ~/agent/hub/repo/.env' },
        { id: 'cp-env:hub:AUTH_BYPASS', level: 'INFO', name: 'hub: Login bypass', detail: 'off — optional not set: AUTH_BYPASS, AUTH_BYPASS_EMAIL — off is correct in production — dev/test only; the real Google login runs' },
        { id: 'cp-env:workspace', level: 'OK', name: 'cp-env:workspace', detail: '~/agent/workspace/.env: 2 ready, 0 off, 0 missing of 2 capabilities (names from workspace/.env.example; values never leave the host)' },
        { id: 'cp-env:workspace:CLAUDE_CODE_OAUTH_TOKEN', level: 'OK', name: 'workspace: Agent sessions (Claude auth)', detail: 'ready — CLAUDE_CODE_OAUTH_TOKEN set in ~/agent/workspace/.env' },
        { id: 'cp-env:workspace:GITHUB_TOKEN', level: 'OK', name: 'workspace: GitHub sync, PRs & deploys', detail: 'ready — GITHUB_TOKEN set in ~/agent/workspace/.env' },
      ],
    },
  },
  {
    env: 'station-red', ts: '2026-01-03T08:00:00Z', date: '2026-01-03', platform: 'win32',
    ok: false, public_ip: '203.0.113.8', age_minutes: 120, configured: true,
    report: {
      results: [
        { id: 'node', level: 'OK', name: 'node', detail: 'v24.18.0' },
        { id: 'harness', level: 'FAIL', name: 'harness', detail: "~/.claude/settings.json 'fallbackModel' not set — desired 'opus'", explain: 'A mismatch is fixed by hand-editing that settings file to the desired values the message names.' },
        { id: 'pull-task', level: 'FAIL', name: 'pull-task', detail: 'Claude-WorkspacePull not registered', explain: 'Verifies the Windows scheduled task that refreshes this machine every 15 minutes exists and is healthy. If it is missing or disabled, syncing and queued log delivery stop until it is re-registered.' },
        { id: 'deps', level: 'WARN', name: 'deps', detail: 'lockfile drift' },
        { id: 'cp-env:workspace', level: 'FAIL', name: 'cp-env:workspace', detail: '~/agent/workspace/.env: 1 ready, 0 off, 1 missing of 2 capabilities (names from workspace/.env.example; values never leave the host)' },
        { id: 'cp-env:workspace:GITHUB_TOKEN', level: 'OK', name: 'workspace: GitHub sync, PRs & deploys', detail: 'ready — GITHUB_TOKEN set in ~/agent/workspace/.env' },
        { id: 'cp-env:workspace:GMAIL_APP_PASSWORD', level: 'FAIL', name: 'workspace: Report email delivery', detail: 'missing — required var(s) absent from ~/agent/workspace/.env: GMAIL_APP_PASSWORD' },
      ],
    },
  },
  {
    env: 'station-legacy', ts: '2026-01-03T02:00:00Z', date: '2026-01-03', platform: 'linux',
    ok: false, public_ip: '203.0.113.9', age_minutes: 480, configured: true,
    report: {
      results: [
        { id: 'node', level: 'OK', name: 'node', detail: 'v22.17.0' },
        { id: 'cp-env', level: 'FAIL', name: 'cp-env', detail: '~/agent/workspace/.env missing 2 of 14 required vars: GOOGLE_OAUTH_CLIENT_ID, GOOGLE_OAUTH_CLIENT_SECRET' },
      ],
    },
  },
  // A reporter that is NOT in configs (`configured: false`): never a matrix
  // column (the feature feed's roster is configured stations only), so the
  // merged surface must keep it visible through the "Also reporting" strip and
  // its detail page, badge intact (TP-fsm-e2e-014/025).
  {
    env: 'station-rogue', ts: '2026-01-03T09:50:00Z', date: '2026-01-03', platform: 'linux',
    ok: true, public_ip: '203.0.113.10', age_minutes: 14, configured: false,
    report: {
      results: [
        { id: 'node', level: 'OK', name: 'node', detail: 'v22.17.0' },
        { id: 'tool:gh', level: 'OK', name: 'tool gh', detail: '2.96.0' },
      ],
    },
  },
];

const NEVER_REPORTED = ['station-silent'];

/**
 * Feature-registry aggregate fixture (`GET /feature?format=json`, workspace
 * `server/README.md` "Feature registry" — Part B). The stub stands in for the
 * control plane, so cell states are HARDCODED verdicts (the derivation itself is
 * Part A's tested job): one row per state the matrix must render distinctly —
 * ready / off (disabled job) / missing / warn / stale / never-reported /
 * unmeasured (declared, `evidence: []`) / n/a (out of scope). Stations mirror
 * the /station fixture (green fresh, red + legacy stale, silent silent);
 * schedule owner is station-green, so job cells live on its column only.
 */
const FEATURE_STATIONS = ['station-green', 'station-red', 'station-legacy', 'station-silent'];

const featureCells = (green, rest) => ({
  'station-green': green,
  'station-red': rest['station-red'] || { state: 'n/a' },
  'station-legacy': rest['station-legacy'] || { state: 'n/a' },
  'station-silent': rest['station-silent'] || { state: 'n/a' },
});

const STALE_REST = {
  'station-red': { state: 'stale', age_minutes: 120 },
  'station-legacy': { state: 'stale', age_minutes: 480 },
  'station-silent': { state: 'never-reported' },
};

const FEATURES = [
  {
    id: 'daily-digest', title: 'Daily digest',
    description: "Composes and emails the morning digest so the day starts with one briefing.", kind: 'job', scope: 'schedule-owner', measured: true,
    job: { name: 'daily-digest', cron: '0 7 * * *', disabled: false, last_run: { date: '2026-01-03', status: 'done' } },
    cells: featureCells({ state: 'ready', age_minutes: 4 }, {}),
  },
  {
    id: 'db-backup', title: 'Daily DB backup',
    description: "Copies the central database to a safe place every night in case the live one is lost.", kind: 'job', scope: 'schedule-owner', measured: true,
    job: { name: 'db-backup', cron: '30 2 * * *', disabled: true, last_run: null },
    cells: featureCells({ state: 'off', age_minutes: 4 }, {}),
  },
  {
    id: 'service-hub', title: 'Hub prod service env',
    description: "The settings the hub website needs on its production host to sign people in and show data.", kind: 'service', scope: 'env:station-green', measured: true,
    cells: featureCells(
      { state: 'ready', age_minutes: 4, checks: [{ id: 'cp-env:hub', state: 'ready', level: 'OK', detail: '4 ready, 1 off, 0 missing of 5 capabilities' }] },
      {}
    ),
  },
  {
    id: 'tool-gh', title: 'gh CLI',
    description: "The GitHub command-line tool agents use to open and check pull requests.", kind: 'tool', scope: 'all', measured: true,
    cells: featureCells(
      { state: 'ready', age_minutes: 4, checks: [{ id: 'tool:gh', state: 'ready', level: 'OK', detail: '2.96.0' }] },
      STALE_REST
    ),
  },
  {
    id: 'tool-claude', title: 'claude CLI',
    description: "The Claude command-line tool that runs the agents themselves; without it no agent can work here.", kind: 'tool', scope: 'all', measured: true,
    cells: featureCells(
      { state: 'missing', age_minutes: 4, checks: [{ id: 'tool:claude', state: 'missing', level: 'FAIL', detail: 'claude not found on PATH' }] },
      STALE_REST
    ),
  },
  {
    id: 'tool-az', title: 'az CLI',
    description: "The Azure command-line tool for managing the cloud VM; optional on most machines.", kind: 'tool', scope: 'all', measured: true,
    cells: featureCells(
      { state: 'warn', age_minutes: 4, checks: [{ id: 'tool:az', state: 'warn', level: 'WARN', detail: 'az not installed — optional' }] },
      STALE_REST
    ),
  },
  {
    id: 'tunnel-transport', title: 'ssh tunnel transport',
    description: "The always-on secure tunnel that lets the control plane reach each PC.", kind: 'check', scope: 'kind:interactive + rollback host', measured: true,
    cells: featureCells({ state: 'n/a' }, { 'station-red': { state: 'stale', age_minutes: 120 } }),
  },
  {
    id: 'hub-pages', title: 'Hub pages inventory',
    description: "A catalog of the hub website's pages; declared but nothing measures it yet.", kind: 'page', scope: 'all', measured: false, note: 'no machine evidence yet',
    cells: featureCells({ state: 'unmeasured', age_minutes: 4 }, STALE_REST),
  },
  {
    // An UNKNOWN kind: the kind tab row derives from the data, so this must get
    // its own tab automatically (hub-features-kind-tabs-2026-08-27) — never a
    // hardcoded kind list, never a dropped row.
    id: 'probe-net', title: 'Network probe',
    description: "A future-kind feature proving new kinds surface automatically.", kind: 'probe', scope: 'all', measured: false, note: 'no machine evidence yet',
    cells: featureCells({ state: 'unmeasured', age_minutes: 4 }, STALE_REST),
  },
];

/**
 * Document-thread fixtures (design: nexus-document-threads-design; W1 contract:
 * GET /thread entries join thread_entry rows with their message bodies). Keys are
 * `doc_kind/doc_ref` — the anchors the app derives from pageType/slug. Role-`ceo`
 * bodies carry the intake contract shape (## Instruction + ## Page context) so
 * the app's instruction-only display is exercised against live-shaped data.
 * `plan/e2e-done-plan` and the other digests deliberately have NO thread — the
 * empty state (just the comment box). The trigger entry's `created` is LATEST on
 * purpose: it must still render first (TP-nexus-e2e-066) — and its message
 * date/ts diverge from that `created`, the backfilled-history bug shape: the
 * page must display the MESSAGE's date, never the link time (TP-nexus-e2e-078_2).
 * `conversation_id` is the message's source conversation (workspace de7b932):
 * agent replies carry one, CEO comments and the trigger are explicit null — the
 * provenance line renders both shapes (TP-nexus-e2e-079_2 and TP-nexus-e2e-080_2;
 * suffixed IDs are written out in full, never as an A/B run).
 */
const ceoCommentBody = (instruction, pageType, slug) =>
  `## Instruction\n${instruction}\n\n## Page context (${pageType}/${slug})\nCONTEXT-ECHO-MUST-NOT-RENDER\n`;

const threadEntry = (id, role, created, message) => ({ id, role, created, message_id: 700 + id, message });

const THREADS = {
  'plan/e2e-active-plan': [
    threadEntry(1, 'ceo', '2026-01-03T11:00:00Z', {
      id: 701, ts: '2026-01-03T11:00:00Z', date: '2026-01-03', kind: 'page-comment', conversation_id: null,
      subject: 'Page comment: E2E active plan (plans/e2e-active-plan)', ref: 'page-comment-9001',
      meta: '{"source":"hub","pageType":"plans","slug":"e2e-active-plan"}',
      body: ceoCommentBody('Please split **section one** into tasks.', 'plans', 'e2e-active-plan'),
    }),
    threadEntry(2, 'agent', '2026-01-03T11:14:00Z', {
      id: 702, ts: '2026-01-03T11:14:00Z', date: '2026-01-03', kind: 'inbox-reply', conversation_id: 12,
      subject: 'Re: E2E active plan', ref: 'page-comment-9001-reply', meta: null,
      body: 'Split into three tasks — see the *updated* plan body.',
    }),
  ],
  'plan/e2e-nexus-test-plan': [
    threadEntry(3, 'ceo', '2026-01-02T12:00:00Z', {
      id: 703, ts: '2026-01-02T12:00:00Z', date: '2026-01-02', kind: 'page-comment', conversation_id: null,
      subject: 'Page comment: E2E hub test plan (plans/e2e-nexus-test-plan)', ref: 'page-comment-9002',
      meta: '{"source":"hub","pageType":"plans","slug":"e2e-nexus-test-plan"}',
      body: ceoCommentBody('Cover the failure path too.', 'plans', 'e2e-nexus-test-plan'),
    }),
    threadEntry(4, 'agent', '2026-01-02T12:15:00Z', {
      id: 704, ts: '2026-01-02T12:15:00Z', date: '2026-01-02', kind: 'inbox-reply', conversation_id: 15,
      subject: 'Re: E2E hub test plan', ref: 'page-comment-9002-reply', meta: null,
      body: 'Failure path case added.',
    }),
    threadEntry(5, 'trigger', '2026-01-02T13:00:00Z', {
      id: 705, ts: '2026-01-01T09:00:00Z', date: '2026-01-01', kind: 'page-comment', conversation_id: null,
      subject: 'The conversation that created this document', ref: 'page-comment-8000', meta: null,
      body: 'We need a test plan for the e2e suite — please draft one.',
    }),
  ],
  'digest/2026-01-02': [
    threadEntry(6, 'ceo', '2026-01-02T08:30:00Z', {
      id: 706, ts: '2026-01-02T08:30:00Z', date: '2026-01-02', kind: 'page-comment', conversation_id: null,
      subject: 'Page comment: Digest 2026-01-02 (digests/2026-01-02)', ref: 'page-comment-9003',
      meta: '{"source":"hub","pageType":"digests","slug":"2026-01-02"}',
      body: ceoCommentBody('Expand the tech section tomorrow.', 'digests', '2026-01-02'),
    }),
    threadEntry(7, 'agent', '2026-01-02T08:45:00Z', {
      id: 707, ts: '2026-01-02T08:45:00Z', date: '2026-01-02', kind: 'inbox-reply', conversation_id: null,
      subject: 'Re: Digest 2026-01-02', ref: 'page-comment-9003-reply', meta: null,
      body: 'Noted — tomorrow\'s digest will go deeper on tech.',
    }),
  ],
  // A page-born (document-less) conversation — the N2 thread-only page. The
  // opener body is instruction-only: a new conversation has no page to quote.
  // Piece-1 shape: the opener's message ref IS the conv-* doc_ref, and BOTH
  // messages carry the backing conversation row 4101 (archive state lives
  // there; the old always-null opener modeled a pre-piece-1 API, now covered by
  // the __legacy-thread control instead).
  'conversation/conv-8100': [
    threadEntry(8, 'ceo', '2026-01-03T12:00:00Z', {
      id: 708, ts: '2026-01-03T12:00:00Z', date: '2026-01-03', kind: 'page-comment', conversation_id: 4101,
      subject: 'Conversation: Wire the beach house alarm (conversations/conv-8100)', ref: 'conv-8100',
      meta: '{"source":"hub","pageType":"conversations","slug":"conv-8100"}',
      body: '## Instruction\nWire the **beach house** alarm to the dashboard.\n',
    }),
    threadEntry(9, 'agent', '2026-01-03T12:15:00Z', {
      id: 709, ts: '2026-01-03T12:15:00Z', date: '2026-01-03', kind: 'inbox-reply', conversation_id: 4101,
      subject: 'Re: Wire the beach house alarm', ref: 'conv-8100-reply', meta: null,
      body: 'Wired — see the *stations* page.',
    }),
  ],
  // N3 anchors — the remaining md-backed pages. e2e-devops, e2e-external-skill
  // and knowledge/setup-md deliberately have NO thread (empty state: box only).
  'agent/e2e-orchestrator': [
    threadEntry(12, 'ceo', '2026-01-03T09:00:00Z', {
      id: 712, ts: '2026-01-03T09:00:00Z', date: '2026-01-03', kind: 'page-comment', conversation_id: null,
      subject: 'Page comment: Agent: e2e-orchestrator (agents/e2e-orchestrator)', ref: 'page-comment-9006',
      meta: '{"source":"hub","pageType":"agents","slug":"e2e-orchestrator"}',
      body: ceoCommentBody('Tighten the **dispatch** rules.', 'agents', 'e2e-orchestrator'),
    }),
    threadEntry(13, 'agent', '2026-01-03T09:15:00Z', {
      id: 713, ts: '2026-01-03T09:15:00Z', date: '2026-01-03', kind: 'inbox-reply', conversation_id: 31,
      subject: 'Re: Agent: e2e-orchestrator', ref: 'page-comment-9006-reply', meta: null,
      body: 'Dispatch rules *tightened*.',
    }),
  ],
  'skill/e2e-internal-skill': [
    threadEntry(14, 'ceo', '2026-01-03T09:30:00Z', {
      id: 714, ts: '2026-01-03T09:30:00Z', date: '2026-01-03', kind: 'page-comment', conversation_id: null,
      subject: 'Page comment: Skill: e2e-internal-skill (skills/e2e-internal-skill)', ref: 'page-comment-9007',
      meta: '{"source":"hub","pageType":"skills","slug":"e2e-internal-skill"}',
      body: ceoCommentBody('Add a **worked example** to this skill.', 'skills', 'e2e-internal-skill'),
    }),
    threadEntry(15, 'agent', '2026-01-03T09:45:00Z', {
      id: 715, ts: '2026-01-03T09:45:00Z', date: '2026-01-03', kind: 'inbox-reply', conversation_id: 32,
      subject: 'Re: Skill: e2e-internal-skill', ref: 'page-comment-9007-reply', meta: null,
      body: 'Worked example added to the skill.',
    }),
  ],
  'knowledge/claude-md': [
    threadEntry(16, 'ceo', '2026-01-03T10:00:00Z', {
      id: 716, ts: '2026-01-03T10:00:00Z', date: '2026-01-03', kind: 'page-comment', conversation_id: null,
      subject: 'Page comment: CLAUDE.md — workspace conventions (knowledge/claude-md)', ref: 'page-comment-9008',
      meta: '{"source":"hub","pageType":"knowledge","slug":"claude-md"}',
      body: ceoCommentBody('Clarify the **logging** convention.', 'knowledge', 'claude-md'),
    }),
    threadEntry(17, 'agent', '2026-01-03T10:15:00Z', {
      id: 717, ts: '2026-01-03T10:15:00Z', date: '2026-01-03', kind: 'inbox-reply', conversation_id: 33,
      subject: 'Re: CLAUDE.md — workspace conventions', ref: 'page-comment-9008-reply', meta: null,
      body: 'Logging convention clarified in the doc.',
    }),
  ],
  // Comments left ON legacy conversation 4001's page (numeric anchor): they
  // render below that conversation's transcript, never as a standalone row.
  'conversation/4001': [
    threadEntry(10, 'ceo', '2026-01-02T10:00:00Z', {
      id: 710, ts: '2026-01-02T10:00:00Z', date: '2026-01-02', kind: 'page-comment', conversation_id: null,
      subject: 'Page comment: E2E active thread (conversations/4001)', ref: 'page-comment-9005',
      meta: '{"source":"hub","pageType":"conversations","slug":"4001"}',
      body: ceoCommentBody('Keep this thread warm.', 'conversations', '4001'),
    }),
    threadEntry(11, 'agent', '2026-01-02T10:10:00Z', {
      id: 711, ts: '2026-01-02T10:10:00Z', date: '2026-01-02', kind: 'inbox-reply', conversation_id: 27,
      subject: 'Re: E2E active thread', ref: 'page-comment-9005-reply', meta: null,
      body: 'Warm and threaded.',
    }),
  ],
};

/**
 * Artifact-linkage triggers (piece 1, hub-conversation-archive-api-2026-08-17):
 * role-`trigger` entries served ONLY by the `?role=` flat-entries mode — kept
 * out of THREADS so the anchor counts and thread renders the rest of the suite
 * pins stay byte-identical. One links legacy conversation 4001 (by the trigger
 * message's conversation_id) to plan e2e-closed-test-plan; one links the
 * page-born conv-8100 (by message_ref = the opener's conv-* ref, and by its
 * backing conversation 4101) to plan e2e-active-plan. 4002 stays unlinked —
 * the no-badge control (TP-convarch-010).
 */
const TRIGGERS = [
  { doc_kind: 'plan', doc_ref: 'e2e-closed-test-plan',
    entry: threadEntry(60, 'trigger', '2026-01-04T08:00:00Z', {
      id: 1, ts: '2026-01-02T08:00:00Z', date: '2026-01-02', kind: 'inbox-request', conversation_id: 4001,
      subject: 'E2E active thread', ref: 'inbox-4001-opener', meta: null, body: 'What is the **status**?',
    }) },
  { doc_kind: 'plan', doc_ref: 'e2e-active-plan',
    entry: threadEntry(61, 'trigger', '2026-01-04T09:00:00Z', {
      id: 708, ts: '2026-01-03T12:00:00Z', date: '2026-01-03', kind: 'page-comment', conversation_id: 4101,
      subject: 'Conversation: Wire the beach house alarm (conversations/conv-8100)', ref: 'conv-8100', meta: null,
      body: '## Instruction\nWire the **beach house** alarm to the dashboard.\n',
    }) },
];

/** The W1 intake pageType -> doc_kind map (workspace server/threads.js) — the stub
 *  emulates anchor capture at POST /message so a posted comment appears in its
 *  thread on the next fetch (TP-nexus-e2e-067). */
const PAGE_TYPE_TO_DOC_KIND = {
  plans: 'plan',
  digests: 'digest',
  agents: 'agent',
  skills: 'skill',
  knowledge: 'knowledge',
  conversations: 'conversation',
};

/** Mutable per-process test state (reset via POST /__reset). `threadExtras` holds
 *  role-`ceo` entries the intake emulation appended for posted page comments —
 *  layered over the fixed THREADS fixtures so reset restores the baseline.
 *  `legacyThreadApi` (armed via POST /__legacy-thread) makes GET /thread behave
 *  pre-piece-1: `role=` ignored (text-line anchor listing back), no
 *  conversation_id/conversation_status on anchor rows — the degradation path
 *  (TP-convarch-013). Reset also restores conversation statuses the archive
 *  round-trips flipped. */
function newState() {
  return { posts: [], failNext: false, failFeaturesNext: false, failStationsNext: false, statusPatches: [], threadExtras: [], legacyThreadApi: false };
}

const BASELINE_STATUSES = new Map(CONVERSATIONS.map((c) => [c.id, c.status]));

function json(res, code, payload) {
  res.statusCode = code;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(payload));
}

async function readJson(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    return {};
  }
}

function createStub() {
  const state = newState();
  const server = http.createServer(async (req, res) => {
    const u = new URL(req.url, 'http://stub');
    const p = u.pathname;

    // --- test control -------------------------------------------------------
    if (p === '/__captured') return json(res, 200, { ok: true, posts: state.posts, statusPatches: state.statusPatches });
    if (p === '/__reset') {
      Object.assign(state, newState());
      for (const c of CONVERSATIONS) c.status = BASELINE_STATUSES.get(c.id);
      return json(res, 200, { ok: true });
    }
    if (p === '/__fail-next') { state.failNext = true; return json(res, 200, { ok: true }); }
    if (p === '/__fail-features') { state.failFeaturesNext = true; return json(res, 200, { ok: true }); }
    if (p === '/__fail-stations') { state.failStationsNext = true; return json(res, 200, { ok: true }); }
    if (p === '/__legacy-thread') { state.legacyThreadApi = true; return json(res, 200, { ok: true }); }

    // --- identity (naming-is-config) ----------------------------------------
    // FIXTURE values on purpose (TP-ceoconf-012/013): assertions key on these —
    // a test asserting a real person's name is the bug the CEO-is-config sweep
    // exists to kill.
    if (p === '/identity' && req.method === 'GET') {
      return json(res, 200, { ok: true, identity: IDENTITY });
    }

    // --- messages (digests + page comments) ---------------------------------
    if (p === '/message' && req.method === 'GET' && u.searchParams.get('kind') === 'daily-digest') {
      const limit = Math.min(Number(u.searchParams.get('limit') || 20), 200);
      const entries = DIGESTS.slice()
        .sort((a, b) => b.id - a.id)
        .slice(0, limit)
        .reverse()
        .map(({ body, ...row }) => ({ ...row, body_length: body.length }));
      return json(res, 200, { ok: true, count: entries.length, entries });
    }
    if (p === '/message' && req.method === 'POST') {
      const body = await readJson(req);
      if (state.failNext) {
        state.failNext = false;
        return json(res, 502, { ok: false, error: 'stub: forced failure' });
      }
      state.posts.push({ ...body, apiKey: req.headers['x-api-key'] || null });
      const id = 900 + state.posts.length;
      // W1 intake anchor capture: a page comment with mappable hub meta
      // becomes a role-`ceo` entry on its document's thread (never fails the store).
      if (body.kind === 'page-comment') {
        try {
          const meta = JSON.parse(body.meta || 'null');
          const docKind = meta && PAGE_TYPE_TO_DOC_KIND[meta.pageType];
          if (docKind && meta.slug) {
            state.threadExtras.push({
              anchor: `${docKind}/${meta.slug}`,
              entry: threadEntry(100 + state.threadExtras.length, 'ceo', new Date().toISOString(), {
                id, ts: new Date().toISOString(), date: new Date().toISOString().slice(0, 10),
                kind: 'page-comment', subject: body.subject, ref: body.ref, meta: body.meta, body: body.body, conversation_id: null,
              }),
            });
          }
        } catch { /* unmappable meta: comment stores, no thread — as in W1 */ }
      }
      return json(res, 200, { ok: true, id });
    }
    const msg = p.match(/^\/message\/(\d+)$/);
    if (msg && req.method === 'GET') {
      const e = DIGESTS.find((d) => String(d.id) === msg[1]);
      if (!e) { res.statusCode = 404; return res.end('not found\n'); }
      res.setHeader('Content-Type', 'text/plain');
      const header = `${e.id} | ${e.date} | ${e.kind} | ${e.subject || '-'} | ${e.ref} | ${e.body.length} chars`;
      return res.end(`# ${header}\n\n${e.body}\n`);
    }

    // --- plans --------------------------------------------------------------
    if (p === '/plan' && req.method === 'GET') {
      const status = u.searchParams.get('status');
      const exclude = (u.searchParams.get('exclude') || '').split(',').filter(Boolean);
      let rows = PLANS.map(({ body, ...r }) => ({ ...r, body_length: body.length }));
      if (status) rows = rows.filter((r) => r.status === status);
      else if (exclude.length) rows = rows.filter((r) => !exclude.includes(r.status));
      return json(res, 200, { ok: true, count: rows.length, entries: rows });
    }
    const plan = p.match(/^\/plan\/([a-z0-9-]+)$/i);
    if (plan && req.method === 'GET') {
      const row = PLANS.find((x) => x.slug === plan[1]);
      if (!row) return json(res, 404, { ok: false, error: 'not found' });
      return json(res, 200, { plan: row });
    }

    // --- stations -----------------------------------------------------------
    if (p === '/station' && req.method === 'GET') {
      if (state.failStationsNext) {
        state.failStationsNext = false;
        return json(res, 500, { ok: false, error: 'stub: forced stations failure' });
      }
      const staleMin = Number(u.searchParams.get('stale_minutes')) > 0 ? Number(u.searchParams.get('stale_minutes')) : 45;
      const stations = STATIONS.map((r) => ({ ...r, stale: r.age_minutes > staleMin }));
      return json(res, 200, { ok: true, count: stations.length, stale_minutes: staleMin, stations, never_reported: NEVER_REPORTED });
    }

    // --- feature registry (Part B) ------------------------------------------
    if (p === '/feature' && req.method === 'GET') {
      if (state.failFeaturesNext) {
        state.failFeaturesNext = false;
        return json(res, 500, { ok: false, error: 'stub: forced features failure' });
      }
      const staleMin = Number(u.searchParams.get('stale_minutes')) > 0 ? Number(u.searchParams.get('stale_minutes')) : 45;
      return json(res, 200, {
        ok: true,
        count: FEATURES.length,
        stale_minutes: staleMin,
        schedule_owner: 'station-green',
        stations: FEATURE_STATIONS,
        features: FEATURES,
      });
    }

    // --- document threads ---------------------------------------------------
    // ?role= — the flat-entries mode (piece 1): every entry of one role joined
    // with its message's ref + conversation_id, newest first. role=trigger is
    // the one-call conversation -> generated-artifacts reverse lookup the
    // Conversations index renders badges from. In legacy mode the param is
    // ignored (a pre-piece-1 server falls through to the anchor listing).
    if (p === '/thread' && req.method === 'GET' && u.searchParams.get('role') && !state.legacyThreadApi) {
      const role = u.searchParams.get('role');
      if (!['ceo', 'agent', 'trigger'].includes(role)) {
        return json(res, 400, { ok: false, error: `invalid role: ${role} (expected ceo|agent|trigger)` });
      }
      if (u.searchParams.get('doc_ref')) {
        return json(res, 400, { ok: false, error: 'role cannot combine with doc_ref' });
      }
      const kindFilter = u.searchParams.get('doc_kind');
      const all = [];
      for (const [anchor, entries] of Object.entries(THREADS)) for (const e of entries) all.push({ anchor, e });
      for (const x of state.threadExtras) all.push({ anchor: x.anchor, e: x.entry });
      for (const t of TRIGGERS) all.push({ anchor: `${t.doc_kind}/${t.doc_ref}`, e: t.entry });
      const entries = all
        .filter(({ e }) => e.role === role)
        .map(({ anchor, e }) => {
          const slash = anchor.indexOf('/');
          return {
            id: e.id,
            doc_kind: anchor.slice(0, slash),
            doc_ref: anchor.slice(slash + 1),
            role: e.role,
            created: e.created,
            message_id: e.message_id,
            message_ref: (e.message && e.message.ref) || null,
            conversation_id: (e.message && e.message.conversation_id) ?? null,
            subject: (e.message && e.message.subject) || null,
          };
        })
        .filter((r) => !kindFilter || r.doc_kind === kindFilter)
        .sort((a, b) => String(b.created).localeCompare(String(a.created)));
      return json(res, 200, { ok: true, count: entries.length, entries });
    }
    if (p === '/thread' && req.method === 'GET' && !u.searchParams.get('doc_ref')) {
      // The anchor listing (W1 shape, consumed by the N2 count joins + the
      // Plans conversation view): entry counts + last activity + the opening
      // entry's subject per anchor, newest activity first; ?doc_kind= filters.
      // Piece-1 fields per row: the opener's conversation_id + its live
      // conversation_status (how the index reads page-born archive state) —
      // both withheld in legacy mode. Like the real API, no format=json means
      // text lines — which is exactly what a pre-piece-1 server answers to the
      // format-less ?role= reverse lookup the app must degrade on.
      const kindFilter = u.searchParams.get('doc_kind');
      const byAnchor = new Map();
      const add = (anchor, entry) => {
        if (!byAnchor.has(anchor)) byAnchor.set(anchor, []);
        byAnchor.get(anchor).push(entry);
      };
      for (const [anchor, entries] of Object.entries(THREADS)) for (const e of entries) add(anchor, e);
      for (const x of state.threadExtras) add(x.anchor, x.entry);
      const rows = [...byAnchor.entries()]
        .map(([anchor, entries]) => {
          const slash = anchor.indexOf('/');
          const sorted = entries.slice().sort((a, b) => String(a.created).localeCompare(String(b.created)));
          const openerConvId = (sorted[0].message && sorted[0].message.conversation_id) ?? null;
          const backing = openerConvId != null ? CONVERSATIONS.find((c) => String(c.id) === String(openerConvId)) : null;
          return {
            doc_kind: anchor.slice(0, slash),
            doc_ref: anchor.slice(slash + 1),
            entries: entries.length,
            first: sorted[0].created,
            last: sorted[sorted.length - 1].created,
            subject: (sorted[0].message && sorted[0].message.subject) || null,
            ...(state.legacyThreadApi
              ? {}
              : { conversation_id: openerConvId, conversation_status: backing ? backing.status : null }),
          };
        })
        .filter((t) => !kindFilter || t.doc_kind === kindFilter)
        .sort((a, b) => String(b.last).localeCompare(String(a.last)));
      if (u.searchParams.get('format') !== 'json') {
        res.setHeader('Content-Type', 'text/plain');
        return res.end(
          rows.map((t) => `${t.doc_kind} | ${t.doc_ref} | ${t.entries} entries | ${String(t.last).slice(0, 10)} | ${t.subject || '-'}`).join('\n') + '\n'
        );
      }
      return json(res, 200, { ok: true, count: rows.length, threads: rows });
    }
    if (p === '/thread' && req.method === 'GET') {
      const key = `${u.searchParams.get('doc_kind')}/${u.searchParams.get('doc_ref')}`;
      let entries = [
        ...(THREADS[key] || []),
        ...state.threadExtras.filter((x) => x.anchor === key).map((x) => x.entry),
      ];
      // Legacy mode models the OLDEST API shape: messages without
      // conversation_id — the page-born archive path must 404 cleanly, never
      // break the page (TP-convarch-013).
      if (state.legacyThreadApi) {
        entries = entries.map((e) => {
          if (!e.message) return e;
          const { conversation_id, ...message } = e.message;
          return { ...e, message };
        });
      }
      return json(res, 200, {
        ok: true,
        doc_kind: u.searchParams.get('doc_kind'),
        doc_ref: u.searchParams.get('doc_ref'),
        count: entries.length,
        entries,
      });
    }

    // --- conversations ------------------------------------------------------
    if (p === '/conversation' && req.method === 'GET') {
      const status = u.searchParams.get('status');
      const rows = CONVERSATIONS
        .filter((c) => !status || c.status === status)
        .map(({ messages, ...c }) => c);
      return json(res, 200, { ok: true, count: rows.length, conversations: rows });
    }
    const conv = p.match(/^\/conversation\/([\w-]+)$/);
    if (conv) {
      const row = CONVERSATIONS.find((c) => c.id === conv[1]);
      if (!row) return json(res, 404, { ok: false, error: 'not found' });
      if (req.method === 'PATCH') {
        const body = await readJson(req);
        state.statusPatches.push({ id: row.id, status: body.status });
        row.status = body.status;
        return json(res, 200, { ok: true });
      }
      const { messages, ...conversation } = row;
      return json(res, 200, { ok: true, conversation, messages });
    }

    return json(res, 404, { ok: false, error: `stub: no route for ${req.method} ${p}` });
  });
  return { server, state };
}

module.exports = { createStub, DIGESTS, PLANS, CONVERSATIONS, DIGEST_DATES, STATIONS, NEVER_REPORTED, FEATURES, FEATURE_STATIONS, THREADS, TRIGGERS };

if (require.main === module) {
  const i = process.argv.indexOf('--port');
  const port = Number(i === -1 ? process.env.STUB_PORT || 8791 : process.argv[i + 1]);
  const { server } = createStub();
  server.listen(port, '127.0.0.1', () => console.log(`stub-log-api listening on http://127.0.0.1:${port}`));
}
