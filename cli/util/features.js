// features.js — loader/validator for the DECLARED feature registry
// (configs/features.json; design: ws plan get features-ui-restructure-design) plus
// the pure state-derivation helpers GET /feature builds its cells from.
//
// The registry is hand-authored catalog (repo = the system's definition); liveness
// is DERIVED at read time from existing evidence — station reports (env-doctor
// check ids), jobs.json (existence + disabled), and runner log rows. Nothing here
// declares liveness, and nothing here fakes it: evidence that cannot be found
// reads `unmeasured`, never `ready`.
//
// Evidence grammar (finalized 2026-08-27, test plan features-registry-2026-08-27 —
// prefixed strings, because a bare token cannot distinguish a jobs.json name from
// an env-doctor check id like `pull-task`):
//   check:<env-doctor-check-id>   per-station evidence, judged from station reports
//   job:<jobs.json-name>          schedule-owner evidence: disabled flag + last run
//   runner-log:<area>             the runner's log area when it differs from the
//                                 job name (db-backup logs area `backup`)
// Scope grammar: all | schedule-owner | env:<name> | kind:<station-kind>.
import { readFileSync } from 'node:fs';

/** @typedef {'job'|'service'|'page'|'tool'|'check'} FeatureKind */
/** @typedef {{id: string, title: string, kind: FeatureKind, scope: string, description: string, evidence: string[], note?: string}} Feature */
/** @typedef {{features: Feature[]}} Registry */
/** @typedef {{form: 'all'|'schedule-owner'|'env'|'kind', value: string|null}} ParsedScope */
/** @typedef {'ready'|'off'|'missing'|'warn'|'stale'|'unmeasured'} CheckState */

export const FEATURE_KINDS = ['job', 'service', 'page', 'tool', 'check'];
const ID_RE = /^[a-z0-9][a-z0-9-]*$/;
const EVIDENCE_RE = /^(check|job|runner-log):(\S.*)$/;

/**
 * Parse a scope string into its form. Returns null on any unknown form —
 * the validator turns that into a refusal, never a silent default.
 * @param {unknown} scope
 * @returns {ParsedScope|null}
 */
export function parseScope(scope) {
  if (typeof scope !== 'string') return null;
  if (scope === 'all' || scope === 'schedule-owner') return { form: scope, value: null };
  const m = /^(env|kind):(.+)$/.exec(scope);
  if (!m) return null;
  const value = m[2].trim();
  if (!value) return null;
  return { form: /** @type {'env'|'kind'} */ (m[1]), value };
}

/**
 * Does a feature's scope include a given station? Pure — the caller supplies the
 * environments config facts.
 * @param {string} scope
 * @param {string} env station name (a configs/environments.json key)
 * @param {{scheduleOwner?: string, environments?: Record<string, {kind?: string}>}} envsCfg
 * @returns {boolean}
 */
export function scopeIncludes(scope, env, envsCfg) {
  const p = parseScope(scope);
  if (!p) return false;
  if (p.form === 'all') return true;
  if (p.form === 'schedule-owner') return env === envsCfg.scheduleOwner;
  if (p.form === 'env') return env === p.value;
  return (envsCfg.environments?.[env]?.kind || null) === p.value;
}

/**
 * Validate a parsed registry against the environments and jobs configs.
 * Pure; returns every error found (empty = valid). Refuses: non-array features,
 * malformed ids/titles/descriptions/kinds, duplicate ids, unknown scope forms, unknown envs or
 * station kinds, malformed evidence strings, and `job:` names jobs.json does not
 * declare. Check ids and runner-log areas are shape-validated only — cp-env ids
 * are derived from the VM at probe time, so a static list would drift by design.
 * @param {unknown} registry
 * @param {{scheduleOwner?: string, environments?: Record<string, {kind?: string}>}} envsCfg
 * @param {{jobs?: {name?: string}[]}} jobsCfg
 * @returns {string[]}
 */
export function validateFeatures(registry, envsCfg, jobsCfg) {
  /** @type {string[]} */
  const errors = [];
  const features = /** @type {{features?: unknown}} */ (registry ?? {}).features;
  if (!Array.isArray(features)) return ['registry has no `features` array'];
  const envNames = Object.keys(envsCfg.environments || {});
  const kinds = new Set(envNames.map((e) => envsCfg.environments?.[e]?.kind).filter((k) => typeof k === 'string'));
  const jobNames = new Set((jobsCfg.jobs || []).map((j) => j?.name).filter((n) => typeof n === 'string'));
  const seen = new Set();
  features.forEach((raw, i) => {
    const f = /** @type {Partial<Feature>} */ (raw ?? {});
    const label = typeof f.id === 'string' && f.id ? `feature '${f.id}'` : `feature #${i}`;
    if (typeof f.id !== 'string' || !ID_RE.test(f.id)) errors.push(`${label}: id must be a lowercase slug`);
    else if (seen.has(f.id)) errors.push(`${label}: duplicate id`);
    else seen.add(f.id);
    if (typeof f.title !== 'string' || !f.title.trim()) errors.push(`${label}: missing title`);
    // C-2 (design plan features-ui-restructure-design): every feature carries a
    // colloquial description for an operator unfamiliar with the system — required,
    // so the UI never has to invent or hardcode prose per feature.
    if (typeof f.description !== 'string' || !f.description.trim()) errors.push(`${label}: missing description (plain-language explanation, required — C-2)`);
    if (!FEATURE_KINDS.includes(/** @type {FeatureKind} */ (f.kind))) errors.push(`${label}: kind must be one of ${FEATURE_KINDS.join('|')}`);
    const scope = parseScope(f.scope);
    if (!scope) errors.push(`${label}: unknown scope form '${String(f.scope)}' (all | schedule-owner | env:<name> | kind:<station-kind>)`);
    else if (scope.form === 'env' && !envNames.includes(String(scope.value))) errors.push(`${label}: scope names unknown env '${scope.value}' (configs/environments.json)`);
    else if (scope.form === 'kind' && !kinds.has(String(scope.value))) errors.push(`${label}: scope names unknown station kind '${scope.value}' (configs/environments.json)`);
    if (!Array.isArray(f.evidence)) errors.push(`${label}: evidence must be an array (may be empty — declared, unmeasured)`);
    else for (const ev of f.evidence) {
      const m = typeof ev === 'string' ? EVIDENCE_RE.exec(ev) : null;
      if (!m) errors.push(`${label}: malformed evidence '${String(ev)}' (check:<id> | job:<name> | runner-log:<area>)`);
      else if (m[1] === 'job' && !jobNames.has(m[2])) errors.push(`${label}: evidence names unknown job '${m[2]}' (configs/jobs/jobs.json)`);
    }
    if (f.note !== undefined && typeof f.note !== 'string') errors.push(`${label}: note must be a string`);
  });
  return errors;
}

/**
 * Read + validate the registry against the environments and jobs config files.
 * Never throws: any unreadable/invalid input surfaces in `errors` and the caller
 * decides how loud to be (GET /feature answers 500; tests assert emptiness).
 * @param {{featuresPath: string, envsPath: string, jobsPath: string, readFile?: (f: string) => string}} paths
 * @returns {{registry: Registry|null, errors: string[]}}
 */
export function loadFeatures({ featuresPath, envsPath, jobsPath, readFile = (f) => readFileSync(f, 'utf8') }) {
  /** @param {string} file @param {string} what @returns {unknown} */
  const parse = (file, what) => {
    try {
      return JSON.parse(readFile(file));
    } catch (e) {
      errors.push(`cannot read ${what}: ${e instanceof Error ? e.message : e}`);
      return null;
    }
  };
  /** @type {string[]} */
  const errors = [];
  const registry = parse(featuresPath, 'features registry');
  const envsCfg = parse(envsPath, 'environments config');
  const jobsCfg = parse(jobsPath, 'jobs config');
  if (errors.length) return { registry: null, errors };
  errors.push(...validateFeatures(registry, /** @type {any} */ (envsCfg), /** @type {any} */ (jobsCfg)));
  return errors.length ? { registry: null, errors } : { registry: /** @type {Registry} */ (registry), errors: [] };
}

// ---------------------------------------------------------------------------
// Pure state derivation (used by GET /feature; unit-tested in cli/test)
// ---------------------------------------------------------------------------

/**
 * One evidence check's capability state. A cp-env row's own `data.state`
 * (ready/off/missing — the three-state contract in SYSTEM.md "Per-service env
 * health") wins over the level; otherwise the env-doctor level maps
 * OK→ready, WARN→warn, FAIL→missing, INFO→off.
 * @param {{level?: string, data?: {state?: string}}} check
 * @returns {CheckState}
 */
export function checkState(check) {
  const s = check?.data?.state;
  if (s === 'ready' || s === 'off' || s === 'missing') return s;
  const level = check?.level;
  if (level === 'OK') return 'ready';
  if (level === 'WARN') return 'warn';
  if (level === 'FAIL') return 'missing';
  return 'off';
}

/** Worst-wins severity order for a cell's evidence states. */
const SEVERITY = ['missing', 'warn', 'stale', 'off', 'unmeasured', 'ready'];

/**
 * Fold several evidence states into one cell state — worst wins, so a cell is
 * `ready` only when every evidence agrees. Empty input is `unmeasured`
 * (declared, unmeasured — never fake liveness).
 * @param {CheckState[]} states
 * @returns {CheckState}
 */
export function combineStates(states) {
  if (!states.length) return 'unmeasured';
  for (const s of SEVERITY) if (states.includes(/** @type {CheckState} */ (s))) return /** @type {CheckState} */ (s);
  return 'unmeasured';
}

/**
 * The schedule-owner cell state a `job:` evidence contributes: a disabled job is
 * `off` (staged, deliberately not armed); the last runner run decides otherwise —
 * done/sent → ready, failed → missing, any other recorded status → warn, and no
 * run rows at all → unmeasured (some jobs write no per-run rows by design).
 * @param {{disabled?: boolean, lastRunStatus?: string|null}} job
 * @returns {CheckState}
 */
export function jobCellState({ disabled = false, lastRunStatus = null }) {
  if (disabled) return 'off';
  if (lastRunStatus === null || lastRunStatus === undefined) return 'unmeasured';
  if (lastRunStatus === 'done' || lastRunStatus === 'sent') return 'ready';
  if (lastRunStatus === 'failed') return 'missing';
  return 'warn';
}
