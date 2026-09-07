'use strict';

/**
 * Log API client for the Stations section (station registry, W3/D1b — contract:
 * `workspace/server/README.md` "Stations"). One call, `GET /station?format=json`,
 * made server-side with the X-Api-Key header; fetched per request, never cached —
 * the page must show the verdict of the moment.
 *
 * Two rules this lib exists to enforce:
 *
 * 1. **The control plane judges; this app renders.** `stale`, `age_minutes` and
 *    `never_reported` are findings of the API read path (a station whose tunnel is
 *    down is exactly the one that cannot file a report, so absence/staleness must
 *    be judged where the reports land). They pass through verbatim — nothing here
 *    recomputes health from timestamps (TP-stations-002).
 * 2. **Checks are trimmed to strings.** Each env-doctor result is forwarded as
 *    `{id, level, name, detail}` plus the ONE optional prose field `explain`
 *    (string-only, capped, dropped otherwise — never coerced); the `data` objects
 *    and the raw `report` are dropped wholesale (TP-stations-003, widened by
 *    check-explainers-hub-2026-08-27) — belt-and-braces on top of the API's own
 *    redaction, so a secret-shaped value has no path to the browser. gh scopes
 *    surface as names inside `detail`, which is all the page needs. `explain` is
 *    env-doctor's plain-language explainer (what the check verifies, what a
 *    failure means — C-2 follow-up); the prose is authored ONLY there, never here.
 */

function isConfigured(config) {
  return Boolean(config.logApiUrl);
}

async function apiGet(config, apiPath) {
  const headers = {};
  if (config.logApiKey) headers['X-Api-Key'] = config.logApiKey;
  return fetch(config.logApiUrl + apiPath, { headers });
}

/** Longest real env-doctor explainer is ~350 chars; anything past this is not prose. */
const MAX_EXPLAIN_CHARS = 1000;

/** One env-doctor result, strings only (level is OK/WARN/FAIL/INFO by contract). */
function trimCheck(c) {
  const out = {
    id: String((c && c.id) || ''),
    level: String((c && c.level) || ''),
    name: String((c && c.name) || ''),
    detail: String((c && c.detail) || ''),
  };
  // `explain` is drop-not-coerce (TP-checkexp-002): a non-string value must never
  // ride the prose field as '[object Object]', an oversized one is not a sentence,
  // and an absent one stays absent — older cached reports render exactly as before.
  if (c && typeof c.explain === 'string' && c.explain.length > 0 && c.explain.length <= MAX_EXPLAIN_CHARS) {
    out.explain = c.explain;
  }
  return out;
}

/** One reported station row, feed fields renamed to the app's camelCase surface. */
function trimStation(r) {
  const results = r.report && Array.isArray(r.report.results) ? r.report.results : [];
  return {
    env: String(r.env || ''),
    ts: String(r.ts || ''),
    ok: Boolean(r.ok),
    stale: Boolean(r.stale), // the server's verdict, echoed — never recomputed
    ageMinutes: Number.isFinite(r.age_minutes) ? r.age_minutes : null,
    configured: r.configured !== false,
    platform: r.platform ? String(r.platform) : '',
    publicIp: r.public_ip ? String(r.public_ip) : '',
    checks: results.map(trimCheck),
  };
}

/**
 * The roster: reported stations (feed order — the API orders by env) plus the
 * configured-but-silent list. `staleMinutes` (positive integer) forwards the
 * feed's `?stale_minutes=` override; anything else sends none (default 45).
 */
async function listStations(config, staleMinutes) {
  const override = Number.isInteger(staleMinutes) && staleMinutes > 0 ? `&stale_minutes=${staleMinutes}` : '';
  const res = await apiGet(config, `/station?format=json${override}`);
  if (!res.ok) throw new Error(`log API responded ${res.status}`);
  const data = await res.json();
  return {
    stations: (Array.isArray(data.stations) ? data.stations : []).map(trimStation),
    neverReported: (Array.isArray(data.never_reported) ? data.never_reported : []).map(String),
    staleMinutes: Number.isFinite(data.stale_minutes) ? data.stale_minutes : 45,
  };
}

module.exports = { isConfigured, listStations };
