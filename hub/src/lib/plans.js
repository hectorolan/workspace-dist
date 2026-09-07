'use strict';

const { renderMarkdown } = require('./render-markdown');

/**
 * Log API client for the Plans section (contract:
 * workspace/logs/plans/plans-db-design.md). All calls run server-side with the
 * X-Api-Key header (config.logApiKey) — nothing API-related ever reaches the
 * browser except the rendered HTML. Fetched per request, never cached: a plan
 * must be visible the moment it is created or updated.
 */

/** Slug guard — rejects anything path-shaped before it reaches the API. */
const SLUG_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

/** Schema's known status set; anything else is ignored as a filter. */
const STATUSES = ['active', 'draft', 'done', 'archived'];

/**
 * Statuses hidden from the default Plans view (R2/R3): terminal (`done`) and
 * soft-deleted (`archived`). Reachable via an explicit `?status=` filter, which
 * overrides the exclude. Sent to the API as `?exclude=done,archived` (server-side
 * NOT IN) AND applied app-side, so the default holds even against an API that does
 * not yet know `?exclude=` — mirror of the app-side `?kind=` filter tolerance.
 */
const DEFAULT_EXCLUDE = ['done', 'archived'];

/**
 * Schema's known kind set (plans-db `kind` column); anything else is ignored as a
 * filter. `test-plan`, `doc` were added by the logs-retirement migration (DB plan
 * `logs-retirement-design`); the `history` kind retired 2026-08-02 — archived
 * items keep their original kind with `status: archived` instead; `baseline`
 * (devops regression baselines) joined the display roster with the Documents
 * subtabs (hn-documents-subtabs-2026-08-15). Kept as an explicit list rather
 * than derived from returned rows: each kind needs its own badge CSS regardless,
 * so a new kind always touches hub anyway, and the list doubles as the
 * `?kind=` injection guard. Mirror any new value with a `.kind-badge.kd-<kind>`
 * rule in client/src/styles/app.css.
 */
const KINDS = ['plan', 'audit', 'design', 'test-plan', 'doc', 'baseline'];

/**
 * The Documents subtab partition (hn-documents-subtabs-2026-08-15) — a
 * DISPLAY-layer grouping only, the stored kinds are untouched: `plan` is the
 * Plans subtab, `test-plan` the Tests subtab, and everything else — design,
 * audit, doc, baseline, and any kind the schema grows later — is a RECORD
 * (the catch-all, so no row is ever orphaned by a new kind). Preferred chip
 * order for the Records view; kinds outside it sort alphabetically after.
 */
const RECORD_KIND_ORDER = ['design', 'audit', 'doc', 'baseline'];
function isRecordKind(kind) {
  return kind !== 'plan' && kind !== 'test-plan';
}

/** Chip roster for a Records row set: preferred order first, then any surprise
 *  kinds alphabetically — derived from rows so a future kind self-registers. */
function recordKindOptions(rows) {
  const present = new Set(rows.map((r) => r.kind));
  const known = RECORD_KIND_ORDER.filter((k) => present.has(k));
  const rest = [...present].filter((k) => !RECORD_KIND_ORDER.includes(k)).sort();
  return [...known, ...rest];
}

/**
 * Repo label for a row. Plans carry an optional `repo` column: project plans (e.g.
 * hub) set it; workspace plans leave it null/empty. Fold the empty case to a stable
 * `workspace` label so the Plans page can filter and badge by origin without a magic null.
 */
const REPO_WORKSPACE = 'workspace';
function repoOf(row) {
  const r = row && row.repo != null ? String(row.repo).trim() : '';
  return r || REPO_WORKSPACE;
}

/**
 * Distinct repos present in a row set for the filter nav: `workspace` always first (it is
 * the default/home origin, offered even when the current view has no workspace rows), then
 * every other repo alphabetically. Derived from returned rows (not a fixed list) so a new
 * project repo appears automatically; the route validates `?repo=` against this set, which
 * doubles as the injection guard (mirrors the `?kind=` KINDS guard).
 */
function repoOptions(rows) {
  const rest = [...new Set(rows.map(repoOf))].filter((r) => r !== REPO_WORKSPACE).sort();
  return [REPO_WORKSPACE, ...rest];
}

/**
 * Normalize a row's `kind`: rows (or APIs) without the field — the pre-`kind`
 * contract — are plain plans, so this page is safe to ship before the API
 * deploys the column (TP-audit-remediation-007). Unknown values pass through
 * (they render with the generic badge style but are never a filter).
 */
function normalizeKind(row) {
  return { ...row, kind: KINDS.includes(row.kind) ? row.kind : row.kind || 'plan' };
}

function isConfigured(config) {
  return Boolean(config.logApiUrl);
}

async function apiGet(config, apiPath) {
  const headers = {};
  if (config.logApiKey) headers['X-Api-Key'] = config.logApiKey;
  return fetch(config.logApiUrl + apiPath, { headers });
}

/**
 * Plan index rows [{slug, title, status, kind, repo, updated_at, body_length}],
 * newest updated first (sorted here — the requirement holds regardless of API order).
 *
 * Filtering (R3): an explicit known `status` is passed as `?status=` (equality) and
 * OVERRIDES the default exclude. With no explicit status, the default view sends
 * `?exclude=done,archived` (server-side NOT IN) AND drops those rows app-side, so
 * terminal/archived plans stay hidden by default even against an API that does not yet
 * know `?exclude=` (TP-plan-exclude-001/002). `kind` (optional) is filtered HERE, after
 * the fetch, not via an API param — same tolerance (TP-audit-remediation-008).
 * The list envelope key follows the GET /message convention (`entries`); `plans`
 * and `rows` are tolerated while the server side lands in parallel (TP-plans-page-012).
 */
async function listPlans(config, status, kind) {
  const hasStatus = STATUSES.includes(status);
  const query = hasStatus ? `&status=${status}` : `&exclude=${DEFAULT_EXCLUDE.join(',')}`;
  const res = await apiGet(config, `/plan?format=json${query}`);
  if (!res.ok) throw new Error(`log API responded ${res.status}`);
  const data = await res.json();
  let rows = (data.entries || data.plans || data.rows || []).map(normalizeKind);
  // App-side backstop for the default exclude view (pre-deploy the API may ignore
  // ?exclude= and return everything). Skipped when an explicit status is chosen.
  if (!hasStatus) rows = rows.filter((r) => !DEFAULT_EXCLUDE.includes(r.status));
  if (KINDS.includes(kind)) rows = rows.filter((r) => r.kind === kind);
  return rows.slice().sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)));
}

/**
 * Every plan row across ALL statuses, normalized and sorted newest updated
 * first — the one upstream fetch behind the Documents subtab views
 * (hn-documents-subtabs-2026-08-15): the views partition open/closed/archived
 * themselves, so the default `?exclude=` must NOT apply here.
 */
async function listPlansAll(config) {
  const res = await apiGet(config, '/plan?format=json');
  if (!res.ok) throw new Error(`log API responded ${res.status}`);
  const data = await res.json();
  const rows = (data.entries || data.plans || data.rows || []).map(normalizeKind);
  return rows.slice().sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)));
}

/** Cap on per-row body fetches for the held-plan check — open test-plans are
 *  few by nature; the cap keeps a pathological DB from fanning out. */
const HELD_CHECK_MAX = 20;

/**
 * Which of these rows carry a pinned CEO block (hn-documents-subtabs assumption
 * 6): `plan-close` pins the block as a blockquote at the VERY TOP of a held
 * test-plan's body, so a body whose first character is `>` is held. Display
 * heuristic only — needs the raw body, so it fetches each row's detail,
 * best-effort: any failure just drops the marker (TP-docsub-010), never a 500.
 * Returns a Set of held slugs.
 */
async function heldPlanSlugs(config, rows) {
  const checks = rows.slice(0, HELD_CHECK_MAX).map(async (row) => {
    if (!SLUG_RE.test(String(row.slug))) return null; // same guard as loadPlan
    try {
      const res = await apiGet(config, `/plan/${row.slug}?format=json`);
      if (!res.ok) return null;
      const data = await res.json();
      const body = String((data.plan || data || {}).body || '');
      return body.trimStart().startsWith('>') ? row.slug : null;
    } catch {
      return null;
    }
  });
  return new Set((await Promise.all(checks)).filter(Boolean));
}

/**
 * One plan with its markdown body rendered for display, or null when the slug is
 * invalid (TP-plans-page-006) or unknown (404 from the API). Tolerates both
 * `{plan: row}` and bare-row detail envelopes.
 */
async function loadPlan(config, slug) {
  if (!SLUG_RE.test(String(slug))) return null;
  const res = await apiGet(config, `/plan/${slug}?format=json`);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`log API responded ${res.status}`);
  const data = await res.json();
  const row = data.plan || data;
  if (!row || !row.slug) return null;
  return { ...normalizeKind(row), html: renderMarkdown(row.body) }; // sanitized (TP-audit-remediation-001)
}

module.exports = {
  isConfigured,
  listPlans,
  listPlansAll,
  loadPlan,
  heldPlanSlugs,
  isRecordKind,
  recordKindOptions,
  repoOf,
  repoOptions,
  STATUSES,
  KINDS,
  REPO_WORKSPACE,
};
