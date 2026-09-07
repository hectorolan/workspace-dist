'use strict';

/**
 * Log API client for the Features section (feature registry, Part B — contract:
 * `workspace/server/README.md` "Feature registry"). One call,
 * `GET /feature?format=json`, made server-side with the X-Api-Key header; fetched
 * per request, never cached — the page must show the verdict of the moment.
 *
 * The endpoint is SERVER-AGGREGATED: the log API joins the declared registry
 * (`configs/features.json`) against station reports and runner log rows and
 * answers one feature-major matrix. This lib never derives liveness and never
 * widens the station check-data trim — it only maps the aggregate onto a
 * whitelisted, strings-only surface (the stations.js posture, TP-hubfeat-002):
 * every field is coerced to string/number/boolean, unknown feed fields are
 * dropped wholesale, so no secret-shaped value has a path to the browser.
 *
 * Cell states are the control plane's findings, echoed verbatim (`ready` / `off`
 * / `missing` / `warn` / `stale` / `unmeasured` / `never-reported` / `n/a`) —
 * nothing here recomputes health, staleness, or scope membership.
 */

function isConfigured(config) {
  return Boolean(config.logApiUrl);
}

async function apiGet(config, apiPath) {
  const headers = {};
  if (config.logApiKey) headers['X-Api-Key'] = config.logApiKey;
  return fetch(config.logApiUrl + apiPath, { headers });
}

/** One evidence row inside a cell — strings only, `via` kept (cross-station probe). */
function trimEvidence(c) {
  return {
    id: String((c && c.id) || ''),
    state: String((c && c.state) || 'unmeasured'),
    ...(c && c.level ? { level: String(c.level) } : {}),
    ...(c && c.detail ? { detail: String(c.detail) } : {}),
    ...(c && c.via ? { via: String(c.via) } : {}),
  };
}

/** One per-station cell. A missing cell folds to unmeasured — never fake liveness. */
function trimCell(c) {
  return {
    state: String((c && c.state) || 'unmeasured'),
    ...(c && Number.isFinite(c.age_minutes) ? { ageMinutes: c.age_minutes } : {}),
    checks: c && Array.isArray(c.checks) ? c.checks.map(trimEvidence) : [],
  };
}

/**
 * One feature row. `job.last_run` is trimmed to outcome + date (message/ts/area
 * dropped — the matrix shows the outcome, the log stays in the DB).
 */
function trimFeature(f, stations) {
  const cells = {};
  for (const env of stations) cells[env] = trimCell(f && f.cells ? f.cells[env] : null);
  const job =
    f && f.job
      ? {
          name: String(f.job.name || ''),
          cron: f.job.cron ? String(f.job.cron) : '',
          disabled: Boolean(f.job.disabled),
          lastRun: f.job.last_run
            ? { date: String(f.job.last_run.date || ''), status: String(f.job.last_run.status || '') }
            : null,
        }
      : null;
  return {
    id: String((f && f.id) || ''),
    title: String((f && f.title) || ''),
    // C-2: the registry's REQUIRED colloquial explanation, passed through
    // verbatim — the row's second line. The UI never hardcodes per-feature
    // prose; an older feed without it folds to '' (tolerance, never a crash).
    description: String((f && f.description) || ''),
    kind: String((f && f.kind) || ''),
    scope: String((f && f.scope) || ''),
    note: f && f.note ? String(f.note) : '',
    measured: !f || f.measured !== false,
    ...(job ? { job } : {}),
    cells,
  };
}

/**
 * The feature-major matrix. `staleMinutes` (positive integer) forwards the
 * feed's `?stale_minutes=` override; anything else sends none (default 45).
 */
async function listFeatures(config, staleMinutes) {
  const override = Number.isInteger(staleMinutes) && staleMinutes > 0 ? `&stale_minutes=${staleMinutes}` : '';
  const res = await apiGet(config, `/feature?format=json${override}`);
  if (!res.ok) throw new Error(`log API responded ${res.status}`);
  const data = await res.json();
  const stations = (Array.isArray(data.stations) ? data.stations : []).map(String);
  return {
    stations,
    scheduleOwner: data.schedule_owner ? String(data.schedule_owner) : '',
    staleMinutes: Number.isFinite(data.stale_minutes) ? data.stale_minutes : 45,
    features: (Array.isArray(data.features) ? data.features : []).map((f) => trimFeature(f, stations)),
  };
}

module.exports = { isConfigured, listFeatures };
