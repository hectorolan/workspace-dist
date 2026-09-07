// env-doctor — verify this station's wiring AND its capability to do work, in one call,
// zero tokens.
// Usage:
//   node cli/util-tools/env-doctor.js                  human report (exit 0 = healthy, 1 = FAIL present)
//   node cli/util-tools/env-doctor.js --json           the same results as a structured payload
//   node cli/util-tools/env-doctor.js --control-plane  force a fresh read-only SSH probe of the
//                                                      VM host (default: at most one probe/day,
//                                                      cached — see cli/util/controlplane.js)
//
// Vocabulary (plan `environment-setup-streamlining`): one CONTROL PLANE + N STATIONS.
// `configs/environments.json` is the station's DEFINITION (identity, kind/role, tunnel,
// activeProjectRepos); this tool compares the machine against that definition.
//
// Connectivity: node version, WS_ENV identity + schedule ownership, dependency freshness,
// git clone state vs origin/main, log API reachability.
// Capability (all kind-aware — a container is never failed for missing Docker Desktop or a
// Windows task): per-machine harness config vs configs/harness-settings.json, active project
// repos cloned as siblings under sources/, tool presence + reported versions, git on the
// MACHINE PATH (an S4U scheduled task cannot see user PATH), the NSG ssh allowlist vs this
// station's public IP (cli/util/nsgcheck.js - a rotated home IP silently closes port 22 and
// kills the log-API tunnel; the only FAIL is a measured mismatch, and it prints the az
// command the CEO runs), Claude-WorkspacePull registration, and the gh OAuth scope set
// (informational).
// Control plane (cli/util/controlplane.js — backlog item 2): the VM HOST state git cannot
// see (deploy crontab line, hub prod compose wiring, and per-service env health —
// every service under ~/agent judged against ITS OWN repo's .env.example, three states
// per capability), probed read-only over the station's existing SSH path at most once per
// day (cached in <WS_DATA_DIR>/control-plane/); unreachable = INFO/skip, and no secret
// value ever rides the wire.
//
// Every check row also carries `explain` — one or two plain-language sentences for an
// operator not familiar with the system (what the check verifies; roughly what a failure
// means and what kind of action fixes it). One home: explainCheck() below; the hub's
// station-detail check table renders it and never hardcodes per-check prose (the C-2
// rule, `ws plan get features-ui-restructure-design`).
//
// HARD RULE (plan D5): this tool READS, PROBES, COMPARES and REPORTS. It never performs a
// credential action, and it never echoes a secret value.
import { readFileSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { probe as sharedProbe } from '../util/probe.js';
import { execFileSync, spawnSync } from 'node:child_process';
import { workspaceDir, health, stamp } from '../util/index.js';
import { collectControlPlaneChecks } from '../util/controlplane.js';
import { loadFeatures, scopeIncludes } from '../util/features.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const LOG_API_DEFAULT = 'http://127.0.0.1:8790';

/** @typedef {'OK'|'WARN'|'FAIL'|'INFO'} Level */
/** @typedef {{id: string, level: Level, name: string, detail: string, explain?: string, data?: Record<string, unknown>}} CheckResult */
/** @typedef {{level: Level, msg: string}} Finding */

// ---------------------------------------------------------------------------
// Pure helpers (exported for cli/test/env-doctor.test.js)
// ---------------------------------------------------------------------------

/** Keys whose VALUE is never printed, whatever a config declares (D5: never echo a secret). */
const SECRETISH = /token|key|secret|password|credential/i;
/** @param {string} k @param {unknown} v */
const showValue = (k, v) => (SECRETISH.test(k) ? '<redacted>' : JSON.stringify(v));

/** @param {unknown} v @returns {string} */
const asList = (v) => JSON.stringify(Array.isArray(v) ? v : [v]);

/**
 * Desired-vs-actual comparison for the per-machine harness config
 * (`~/.claude/settings.json`). This file CANNOT be DB-backed: the Claude Code harness
 * reads it from a fixed path at startup, before any workspace code runs — so the repo
 * carries the DESIRED state (`configs/harness-settings.json`) and this compares.
 * Scalar and single-element-array forms are treated as equal (`"opus"` == `["opus"]`).
 * @param {Record<string, unknown>} desired
 * @param {Record<string, unknown>|null} actual null when the file is missing/unreadable
 * @returns {Finding[]} empty = matches
 */
export function compareHarnessSettings(desired, actual) {
  if (!actual) {
    return [{ level: 'FAIL', msg: 'missing or unreadable — apply the desired keys from configs/harness-settings.json by hand' }];
  }
  /** @type {Finding[]} */
  const findings = [];
  for (const [k, want] of Object.entries(desired)) {
    if (k.startsWith('_')) continue;
    const got = actual[k];
    if (got === undefined) {
      findings.push({ level: 'FAIL', msg: `'${k}' not set — desired ${showValue(k, want)} (configs/harness-settings.json)` });
    } else if (asList(want) !== asList(got)) {
      findings.push({ level: 'FAIL', msg: `'${k}' is ${showValue(k, got)} — desired ${showValue(k, want)} (configs/harness-settings.json)` });
    }
  }
  return findings;
}

/**
 * Which tools this station must have, from its own definition. Kind-aware by construction:
 * nothing here is asserted because "a station usually has it" — each entry is tied to a
 * capability the station's kind/role/tunnel actually claims. Versions are REPORTED, never
 * gated: no minimum versions are established (node's `engines` floor is the exception,
 * checked separately and read from package.json so it never restates the pin).
 * @param {{kind?: string, role?: string, hasTunnel?: boolean}|null} station null = identity unresolved
 * @returns {{name: string, argv: string[], requirement: 'required'|'optional'|'n/a', why: string}[]}
 */
export function toolPlan(station) {
  const kindRole = `${station?.kind || ''} ${station?.role || ''}`;
  const rollback = /rollback/i.test(kindRole);
  const hasTunnel = Boolean(station?.hasTunnel);
  /** @param {boolean} yes @param {'required'|'optional'} level */
  const when = (yes, level) => (yes ? level : /** @type {'n/a'} */ ('n/a'));
  return [
    { name: 'node', argv: ['--version'], requirement: 'required', why: 'everything' },
    { name: 'git', argv: ['--version'], requirement: 'required', why: 'sync + credential helper' },
    { name: 'gh', argv: ['--version'], requirement: 'required', why: 'PR flow, git credentials' },
    { name: 'claude', argv: ['--version'], requirement: 'required', why: 'the harness / headless agent runs' },
    { name: 'ssh', argv: ['-V'], requirement: when(hasTunnel, 'required'), why: 'the log API SSH tunnel (logApiTunnel in configs/environments.json)' },
    { name: 'docker', argv: ['--version'], requirement: when(rollback, 'required'), why: 'the rollback lane this station declares' },
    { name: 'az', argv: ['version'], requirement: 'optional', why: 'VM ops, SSH key install, NSG checks' },
  ];
}

/**
 * First version-looking token in a tool's `--version` output (ssh prints to stderr, az
 * prints JSON, git prints a sentence — one regex covers all of them).
 * @param {string} out @returns {string}
 */
export function parseVersion(out) {
  const text = String(out || '').replace(/\r/g, '').trim();
  const m = /(\d+\.\d+[\w.+-]*)/.exec(text);
  return m ? m[1] : text.split('\n')[0].slice(0, 60) || 'unknown';
}

/**
 * Expand `%VAR%` references the way the Windows registry stores them in REG_EXPAND_SZ.
 * @param {string} value @param {Record<string, string|undefined>} env
 * @returns {string}
 */
export function expandWinVars(value, env) {
  return String(value).replace(/%([^%]+)%/g, (whole, name) => {
    const hit = Object.keys(env).find((k) => k.toLowerCase() === String(name).toLowerCase());
    return hit && env[hit] !== undefined ? String(env[hit]) : whole;
  });
}

/**
 * The `Path` value out of `reg query "HKLM\...\Environment" /v Path` output.
 * @param {string} out @returns {string|null}
 */
export function parseRegPath(out) {
  const m = /^\s*Path\s+REG_(?:EXPAND_)?SZ\s+(.*)$/im.exec(String(out || ''));
  return m ? m[1].trim() : null;
}

/**
 * Does the MACHINE (system) PATH contain a directory holding git? An S4U scheduled task —
 * which is how `Claude-WorkspacePull` runs — cannot see the user PATH, so git being only on
 * the user PATH is invisible until the task fails silently.
 * @param {string|null} machinePath raw HKLM Path value
 * @param {(dir: string) => boolean} hasGit probe for a git executable in a directory
 * @param {Record<string, string|undefined>} env
 * @returns {string|null} the directory that provides git, or null
 */
export function machinePathGitDir(machinePath, hasGit, env) {
  if (!machinePath) return null;
  for (const raw of String(machinePath).split(';')) {
    const dir = expandWinVars(raw.trim().replace(/^"|"$/g, ''), env).replace(/[\\/]+$/, '');
    if (!dir) continue;
    if (hasGit(dir)) return dir;
  }
  return null;
}

/**
 * `schtasks /Query /TN <name> /V /FO LIST` output → the facts that matter for the
 * 15-minute tick (it is also the SSH tunnel's only keeper and the fallback-log replay).
 * @param {string} out @param {number} status exit code of the query
 * @returns {{found: boolean, state: string|null, lastResult: string|null, nextRun: string|null}}
 */
export function parseSchtasks(out, status) {
  const text = String(out || '');
  if (status !== 0 || !/TaskName:/i.test(text)) return { found: false, state: null, lastResult: null, nextRun: null };
  /** @param {RegExp} re */
  const field = (re) => {
    const m = re.exec(text);
    return m ? m[1].trim() : null;
  };
  return {
    found: true,
    state: field(/^\s*Scheduled Task State:\s*(.+)$/im) || field(/^\s*Status:\s*(.+)$/im),
    lastResult: field(/^\s*Last Result:\s*(.+)$/im),
    nextRun: field(/^\s*Next Run Time:\s*(.+)$/im),
  };
}

/**
 * OAuth scopes out of `gh auth status` output. Informational: scope sets are cumulative per
 * account and no scope list is asserted here.
 * @param {string} out @returns {string[]}
 */
export function parseGhScopes(out) {
  const m = /Token scopes:\s*(.+)/i.exec(String(out || ''));
  if (!m) return [];
  return m[1]
    .split(',')
    .map((s) => s.trim().replace(/^['"]|['"]$/g, ''))
    .filter(Boolean);
}

/**
 * Active project repos must be cloned as SIBLINGS of workspace/ under sources/ — never
 * inside the workspace repo's working tree (CLAUDE.md "GitHub sync" rule 6). An interactive
 * station holding only workspace/ cannot start any project work, which is exactly the gap a
 * connectivity-only doctor missed.
 * @param {string[]} repos from configs/environments.json activeProjectRepos
 * @param {(repo: string) => {sibling: boolean, isGit: boolean, insideWorkspace: boolean}} probe
 * @returns {Finding[]}
 */
export function projectRepoFindings(repos, probe) {
  /** @type {Finding[]} */
  const findings = [];
  for (const repo of repos) {
    const seen = probe(repo);
    if (seen.insideWorkspace) {
      findings.push({ level: 'FAIL', msg: `${repo}: cloned INSIDE the workspace repo — project repos are siblings under sources/ (CLAUDE.md GitHub sync rule 6)` });
      continue;
    }
    if (!seen.sibling) {
      findings.push({ level: 'FAIL', msg: `${repo}: not cloned as a sibling under sources/ — this station cannot start project work (.claude/SETUP.md bootstrap step 3)` });
      continue;
    }
    if (!seen.isGit) findings.push({ level: 'FAIL', msg: `${repo}: directory exists but is not a git clone` });
  }
  return findings;
}

/**
 * Is a probed tool actually present? Under `shell: true` a missing command still produces
 * output ("'az' is not recognized as an internal or external command"), and some tools
 * report their version with a non-zero exit (`ssh -V` on several builds) — so neither the
 * exit code nor the output alone is a reliable signal.
 * @param {{ok: boolean, out: string}} r
 * @returns {boolean}
 */
export function toolFound(r) {
  if (/not recognized|command not found|No such file|is not recognized/i.test(r.out)) return false;
  return r.ok || /\d+\.\d+/.test(r.out);
}

/** @param {CheckResult[]} results @returns {boolean} */
export function checksFailed(results) {
  return results.some((r) => r.level === 'FAIL');
}

/**
 * Registry-vs-reality drift for the declared feature catalog (configs/features.json —
 * plan `features-drift-check-2026-08-27`). The validator (cli/util/features.js)
 * deliberately leaves check ids shape-only ("a static list would drift by design");
 * this is its runtime complement, run on every station tick so drift surfaces as
 * WARN rows on the station report. Rules:
 *  - broken/unloadable registry → one FAIL row (it also breaks GET /feature — 500);
 *  - a jobs.json job no feature cites (`job:<name>`) → WARN (disabled jobs too —
 *    staged is not unregistered);
 *  - a toolPlan tool no feature cites (`check:tool:<name>`) → WARN (the SAME
 *    enumeration the `tool:<name>` checks use — the forged-tool scripts in
 *    cli/util-tools/ are cataloged in cli/README.md, not the registry);
 *  - a `check:<id>` evidence of a feature whose scope includes THIS station that
 *    neither this run (any level — an INFO skip still proves the id exists) nor any
 *    stored station report emits → WARN (mirrors GET /feature's cross-station `via`
 *    lookup, so evidence another station legitimately owns is never flagged);
 *  - roster unreachable → unresolved ids get one INFO row, never a guessed WARN;
 *  - no drift → one OK summary row.
 * @param {{loaded: {registry: {features: {id: string, scope: string, evidence: string[]}[]}|null, errors: string[]},
 *          jobsCfg: {jobs?: {name?: string}[]},
 *          toolNames: string[],
 *          self: string|null,
 *          envsCfg: {scheduleOwner?: string, environments?: Record<string, {kind?: string}>},
 *          emittedIds: Set<string>,
 *          remoteIds: Set<string>|null}} args
 * @returns {CheckResult[]}
 */
export function featureDriftChecks({ loaded, jobsCfg, toolNames, self, envsCfg, emittedIds, remoteIds }) {
  /** @type {CheckResult[]} */
  const out = [];
  /** @type {(level: Level, detail: string, data?: Record<string, unknown>) => void} */
  const row = (level, detail, data) => out.push({ id: 'feature-registry', level, name: 'features', detail, ...(data ? { data } : {}) });
  if (!loaded.registry) {
    row('FAIL', `configs/features.json invalid or unloadable — GET /feature answers 500 until it is fixed: ${loaded.errors.join('; ')}`, { errors: loaded.errors });
    return out;
  }
  const features = loaded.registry.features;
  const cited = new Set(features.flatMap((f) => f.evidence));
  let drift = 0;
  const jobNames = (jobsCfg.jobs || []).map((j) => j?.name).filter((n) => typeof n === 'string');
  for (const name of jobNames) {
    if (cited.has(`job:${name}`)) continue;
    drift += 1;
    row('WARN', `job '${name}' (configs/jobs/jobs.json) has no registry feature citing it — add a feature with evidence 'job:${name}' to configs/features.json, or remove the job`, { job: name });
  }
  for (const name of toolNames) {
    if (cited.has(`check:tool:${name}`)) continue;
    drift += 1;
    row('WARN', `tool '${name}' is checked on stations (tool:${name}) but no registry feature cites 'check:tool:${name}' — add it to configs/features.json, or retire the tool from toolPlan`, { tool: name });
  }
  /** @type {string[]} */
  const unresolved = [];
  if (self) {
    for (const f of features) {
      if (!scopeIncludes(f.scope, self, envsCfg)) continue; // the station in scope judges it
      for (const ev of f.evidence) {
        if (!ev.startsWith('check:')) continue; // job:/runner-log: are the validator's territory
        const id = ev.slice('check:'.length);
        if (emittedIds.has(id)) continue;
        if (remoteIds === null) {
          unresolved.push(`${f.id} -> ${id}`);
          continue;
        }
        if (remoteIds.has(id)) continue; // cross-station evidence another station owns (`via`)
        drift += 1;
        row('WARN', `feature '${f.id}' cites 'check:${id}' but neither this station's run nor any stored station report emits that id — fix the evidence id in configs/features.json, or remove the feature`, { feature: f.id, check: id });
      }
    }
  }
  if (unresolved.length) {
    row('INFO', `${unresolved.length} evidence id(s) not verifiable — station roster unreachable, skipped rather than guessed: ${unresolved.join(', ')}`, { unresolved });
  }
  if (!drift) row('OK', `configs/features.json in sync with reality (${features.length} features; ${jobNames.length} jobs and ${toolNames.length} tools all registered)`, { features: features.length, jobs: jobNames.length, tools: toolNames.length });
  return out;
}

// ---------------------------------------------------------------------------
// Colloquial explainers (C-2 follow-up, the CEO 2026-08-28 — test plan
// `ws plan get check-explainers-workspace-2026-08-27`)
// ---------------------------------------------------------------------------
// Every check row carries `explain`: one or two plain-language sentences for an
// operator NOT familiar with the system — what the check verifies, and roughly what
// a failure means / what kind of action fixes it. This map is the ONE home for that
// prose (the hub's station-detail check table renders it, never hardcodes it —
// same rule C-2 set for feature descriptions). Applied as a decoration pass at the
// end of collectChecks() so rows born in cli/util/nsgcheck.js, cli/util/controlplane.js,
// and even pre-change cached control-plane results all carry it. A new check id with
// no entry here is left undecorated, and TP-check-explain-001 fails the suite — an
// explain is part of shipping a check, not an afterthought.

/** @type {Record<string, string>} */
const EXPLAIN = {
  node: 'Verifies the Node.js runtime installed here is at least the minimum version the workspace\'s code is written for. If it fails, scripts may crash or misbehave until Node.js is upgraded on this machine.',
  identity: 'Verifies this machine knows which station it is: its station name must be set and must match an entry in the shared roster of environments. Until that is fixed, checks cannot be tailored to this machine\'s role and its reports cannot be filed under the right name.',
  deps: 'Verifies the third-party libraries installed on this machine match what the current code expects. A warning usually clears itself — the automatic 15-minute refresh reinstalls them — or run the dependency install command the message names.',
  'ci-guard-gates': 'Verifies the safety gates that test code before it is pushed (type checking and the test suites) are able to run on this machine. If they cannot, pushes from here go out unverified and could land broken code on the shared main branch; installing the project dependencies restores the gates.',
  git: 'Verifies this machine\'s copy of the workspace matches the shared one on GitHub — not missing recent changes and, above all, not holding commits that were never pushed. Unpushed work is invisible to every other machine, so a failure means pushing (or pulling) here before anything else.',
  'log-api': 'Verifies the central record-keeping service — where activity logs, plans and reports live — answers from this machine. While it is unreachable, new log entries queue up in a local file and are delivered automatically once the connection returns.',
  harness: 'Compares the Claude Code settings file in this machine\'s home directory against the settings the workspace declares every machine of this kind should have. A mismatch is fixed by hand-editing that settings file to the desired values the message names.',
  'project-repos': 'Verifies every project this station is expected to work on has been downloaded (cloned) into the right place, next to the workspace folder. A missing or misplaced project means work on it cannot start here until it is cloned correctly.',
  'git-machine-path': 'Verifies Git is reachable from the system-wide program path — the one Windows background tasks see — not just from the logged-in user\'s own path. If Git is only on the user path, the automatic 15-minute background refresh fails silently; the fix is adding Git\'s folder to the system-wide path.',
  'pull-task': 'Verifies the Windows scheduled task that refreshes this machine every 15 minutes exists and is healthy. That same task keeps the connection to the central record-keeping service alive and delivers queued log entries, so if it is missing or disabled those stop too until it is re-registered.',
  'gh-scopes': 'Lists which permissions this machine\'s GitHub login currently carries — for information only, nothing is asserted about them. A warning simply means nobody is logged in to GitHub here, which the GitHub login command fixes.',
  'nsg-ssh-allowlist': 'Verifies the cloud firewall in front of the central server still allows connections from this machine\'s current internet address, which home connections rotate from time to time. A failure means this machine has silently lost its line to the server; the message includes the exact one-line command an operator runs to allow the new address.',
  'control-plane': 'Reports on the once-a-day, read-only inspection of the central server itself, taken over a secure connection from this machine. This row says whether that inspection ran, reused today\'s earlier result, or was skipped because this machine has no connection path to the server.',
  'cp-cron': 'Verifies the central server still has its every-five-minutes schedule entry that automatically deploys the latest version of the web app. If it is gone, new versions stop reaching production until that schedule line is restored on the server.',
  'cp-compose': 'Verifies the configuration file the deploy process uses to run the production web app still exists on the central server — it lives only there, in no code repository. If it is missing, deploys fail until the file is recreated on the server.',
  'cp-clone': 'Verifies the working copy of the web app\'s source code that the deploy process updates still exists on the central server. Without it, the deploy script considers the app not installed and stops.',
  'cp-env': 'Summarizes whether the daily inspection of the central server brought back facts about the settings of each service running there. A warning means the inspection\'s answer was incomplete, so nothing could be judged this time.',
  'feature-registry': 'Compares the workspace\'s declared catalog of features against what actually exists: scheduled jobs, the tools stations check for, and the health checks stations report. A warning means the catalog has drifted from reality — something running is not cataloged, or a catalog entry points at nothing — and the catalog file needs a matching edit.',
};

/**
 * The plain-language explainer for a check id. Exact ids first, then the templated
 * families composed per instance (`tool:<name>`, `cp-env:<svc>`, `cp-env:<svc>:<KEY>`)
 * so each row reads naturally on its own. Unknown id → null, NEVER filler — that gap
 * is what lets the coverage test refuse a future check shipped without prose.
 * @param {string} id
 * @returns {string|null}
 */
export function explainCheck(id) {
  const key = String(id || '');
  if (EXPLAIN[key]) return EXPLAIN[key];
  if (key.startsWith('tool:')) {
    const tool = key.slice('tool:'.length);
    return `Verifies the '${tool}' program is installed and answers on this machine, and records which version it is. If a tool this station needs is missing, work that depends on it fails until the tool is installed; a tool this kind of machine does not need is only noted, never a failure.`;
  }
  if (key.startsWith('cp-env:')) {
    const parts = key.split(':');
    const svc = parts[1];
    if (!svc) return null;
    if (parts.length === 2) {
      return `Summarizes the settings of the '${svc}' service running on the central server: how many of its capabilities are ready, switched off, or missing a required setting. A failure means at least one required setting is absent on the server, which holds that part of the service until it is added there.`;
    }
    return `Reports one capability of the '${svc}' service on the central server, judged by whether the settings it needs are present there (only setting names are inspected — values never leave the server). "Missing" means a required setting is absent and blocks the capability; "off" just means an optional feature is not turned on.`;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Probes
// ---------------------------------------------------------------------------

/**
 * Run a probe command and return its combined output. Fixed literal argv only (no user
 * input reaches the shell). Platform split and the DEP0190 rationale live in
 * `cli/util/probe.js` — ONE owner, shared with station-bootstrap.
 * @param {string} cmd @param {string[]} argv @param {number} [timeout]
 * @returns {{ok: boolean, out: string, status: number|null}}
 */
const probe = (cmd, argv, timeout = 30000) => sharedProbe(cmd, argv, { timeout });

// ---------------------------------------------------------------------------
// The check set
// ---------------------------------------------------------------------------

/**
 * Run every check and return structured results. Printing is the caller's job — the payload
 * is reusable (W3 has `ws pull` report it to the DB).
 * @param {{controlPlane?: 'auto'|'force'|'off'}} [opts] control-plane gate: 'auto' (default —
 *   at most one SSH probe per day, cached), 'force' (--control-plane), 'off'
 * @returns {Promise<CheckResult[]>}
 */
export async function collectChecks({ controlPlane = 'auto' } = {}) {
  /** @type {CheckResult[]} */
  const results = [];
  /** @type {(id: string, level: Level, name: string, detail: string, data?: Record<string, unknown>) => void} */
  const add = (id, level, name, detail, data) => {
    results.push(data ? { id, level, name, detail, data } : { id, level, name, detail });
  };

  // --- node version vs engines (the one established minimum) ---
  // The floor is READ from package.json, never restated here: `engines.node` tracks the
  // Dockerfile major (asserted by cli/test/runtime-version.test.js), so a runtime bump
  // reaches every station's doctor without a second edit. A hardcoded literal silently
  // passed stations a major behind production until 2026-08-15.
  const major = Number(process.versions.node.split('.')[0]);
  let floor = 0;
  try {
    const engines = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8')).engines?.node;
    floor = Number(/(\d+)/.exec(engines || '')?.[1] ?? 0);
  } catch {
    /* unreadable package.json is reported by the deps check, not here */
  }
  const nodeOk = !floor || major >= floor;
  add('node', nodeOk ? 'OK' : 'FAIL', 'node', `v${process.versions.node}${nodeOk ? '' : ` — engines require >= ${floor}`}`, {
    version: process.versions.node,
    floor,
  });

  // --- identity + schedule ownership (also the source of kind/role for every check below) ---
  const self = process.env.WS_ENV;
  /** @type {any} */
  let envs = null;
  /** @type {{kind?: string, role?: string, hasTunnel?: boolean}|null} */
  let station = null;
  try {
    envs = JSON.parse(readFileSync(path.join(ROOT, 'configs', 'environments.json'), 'utf8'));
    const entry = self ? envs.environments?.[self] : null;
    if (!self) add('identity', 'FAIL', 'identity', `WS_ENV not set (owner is '${envs.scheduleOwner}') — see configs/environments.json identifiesAs`);
    else if (!entry) add('identity', 'FAIL', 'identity', `WS_ENV='${self}' has no entry in configs/environments.json`);
    else {
      station = { kind: entry.kind, role: entry.role, hasTunnel: Boolean(entry.logApiTunnel) };
      add('identity', 'OK', 'identity', `WS_ENV=${self}${self === envs.scheduleOwner ? ' — SCHEDULE OWNER (jobs arm here)' : ` (owner: ${envs.scheduleOwner})`}`, { env: self, kind: entry.kind, scheduleOwner: envs.scheduleOwner });
    }
  } catch (e) {
    add('identity', 'FAIL', 'identity', `cannot read configs/environments.json: ${e instanceof Error ? e.message : e}`);
  }
  const kindRole = `${station?.kind || ''} ${station?.role || ''}`;
  const interactive = /interactive/i.test(kindRole);
  const windowsStation = process.platform === 'win32';

  // --- dependency freshness (same marker ensure-deps maintains) ---
  const lock = path.join(ROOT, 'package-lock.json');
  const marker = path.join(ROOT, 'node_modules', '.ws-lock');
  if (!existsSync(path.join(ROOT, 'node_modules'))) add('deps', 'WARN', 'deps', 'node_modules missing — run `node cli/ws.js ensure-deps` (only `ws email/scheduler/run-*` need it)');
  else if (!existsSync(marker)) add('deps', 'WARN', 'deps', 'install marker missing — next `ws pull` tick will reconcile');
  else {
    const inSync = readFileSync(marker, 'utf8') === readFileSync(lock, 'utf8');
    add('deps', inSync ? 'OK' : 'WARN', 'deps', inSync ? 'in sync with lockfile' : 'stale vs lockfile — next `ws pull` tick reconciles');
  }

  // --- ci-guard gates armed on this station ---
  // A gate that cannot run degrades to "push allowed" by design, so a broken
  // toolchain never locks a station out of `ws sync` (SYSTEM.md "Pre-push CI gate").
  // Safe — but INVISIBLE: a station can sync for days with no gate running at all and
  // nothing says so out loud, which is how the windows-pc gate skip went unnoticed on
  // 2026-08-17. This asks exactly what `gateCommand` asks at sync time (fs only, no
  // spawn, sub-ms), so the Stations page shows an ungated station as ungated.
  {
    const { gateCommand } = await import('../util/ciguard.js');
    const gates = ['typecheck', 'server-tests', 'cli-tests'];
    const dead = gates.filter((g) => !gateCommand(ROOT, g));
    if (!dead.length) add('ci-guard-gates', 'OK', 'ci-guard', `all pre-push gates runnable here (${gates.join(', ')})`, { gates });
    else add('ci-guard-gates', 'WARN', 'ci-guard', `${dead.join(', ')} cannot run here — \`ws sync\` skips ${dead.length === 1 ? 'that gate' : 'those gates'} and pushes unverified (\`node cli/ws.js ensure-deps\`)`, { dead });
  }

  // --- git clone state ---
  try {
    const git = (/** @type {string[]} */ args) => execFileSync('git', ['-C', workspaceDir(), ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    git(['fetch', '-q', 'origin', 'main']);
    const behind = Number(git(['rev-list', '--count', 'HEAD..origin/main']));
    const ahead = Number(git(['rev-list', '--count', 'origin/main..HEAD']));
    if (ahead > 0) add('git', 'FAIL', 'git', `${ahead} unpushed commit(s) — unpushed work is invisible to every other environment`, { ahead, behind });
    else add('git', behind === 0 ? 'OK' : 'WARN', 'git', behind === 0 ? 'in sync with origin/main' : `${behind} commit(s) behind — pull (or wait for the freshness net)`, { ahead, behind });
  } catch {
    add('git', 'WARN', 'git', `fetch failed — offline, or no clone at ${workspaceDir()}`);
  }

  // --- log API ---
  const apiUrl = process.env.LOG_API_URL || LOG_API_DEFAULT;
  try {
    const h = JSON.parse(await health());
    add('log-api', h.ok ? 'OK' : 'FAIL', 'log-api', h.ok ? `reachable, ${h.entries} entries (${apiUrl})` : 'responded not-ok', { url: apiUrl, entries: h.entries });
  } catch {
    add('log-api', 'FAIL', 'log-api', `unreachable at ${apiUrl} — audit lines will fall back to <WS_DATA_DIR>/fallback/log.md (ws pull replays them)`, { url: apiUrl });
  }

  // --- (a) per-machine harness config vs desired state declared in the repo ---
  {
    const desiredPath = path.join(ROOT, 'configs', 'harness-settings.json');
    const settingsPath = path.join(os.homedir(), '.claude', 'settings.json');
    /** @type {any} */
    let desiredCfg = null;
    try {
      desiredCfg = JSON.parse(readFileSync(desiredPath, 'utf8'));
    } catch (e) {
      add('harness', 'FAIL', 'harness', `cannot read configs/harness-settings.json: ${e instanceof Error ? e.message : e}`);
    }
    if (desiredCfg) {
      const kinds = Array.isArray(desiredCfg.appliesToKinds) ? desiredCfg.appliesToKinds.map(String) : [];
      const applies = station?.kind ? kinds.includes(String(station.kind)) : false;
      if (!station) add('harness', 'INFO', 'harness', 'skipped — station kind unresolved (fix identity first)');
      else if (!applies) add('harness', 'INFO', 'harness', `not required for kind '${station.kind}' (configs/harness-settings.json appliesToKinds)`);
      else {
        /** @type {Record<string, unknown>|null} */
        let actual = null;
        try {
          actual = JSON.parse(readFileSync(settingsPath, 'utf8'));
        } catch {
          actual = null;
        }
        const desired = /** @type {Record<string, unknown>} */ (desiredCfg.userSettings || {});
        const findings = compareHarnessSettings(desired, actual);
        const keys = Object.keys(desired).filter((k) => !k.startsWith('_'));
        if (!findings.length) add('harness', 'OK', 'harness', `~/.claude/settings.json matches desired ${keys.join(', ')}`, { path: settingsPath, keys });
        else for (const f of findings) add('harness', f.level, 'harness', `~/.claude/settings.json ${f.msg}`, { path: settingsPath });
      }
    }
  }

  // --- (b) active project repos cloned as siblings under sources/ ---
  {
    const repos = Array.isArray(envs?.activeProjectRepos) ? envs.activeProjectRepos.map(String) : null;
    const sourcesDir = path.dirname(workspaceDir());
    if (repos === null) add('project-repos', 'FAIL', 'project-repos', 'configs/environments.json has no activeProjectRepos array — nothing declares which repos a station must carry');
    else if (!interactive) add('project-repos', 'INFO', 'project-repos', `skipped — ${station ? `kind '${station.kind}' does no project work` : 'station kind unresolved'} (${repos.length} active: ${repos.join(', ') || 'none'})`, { repos });
    else {
      const findings = projectRepoFindings(repos, (repo) => ({
        sibling: existsSync(path.join(sourcesDir, repo)),
        isGit: existsSync(path.join(sourcesDir, repo, '.git')),
        insideWorkspace: existsSync(path.join(workspaceDir(), repo, '.git')),
      }));
      // Config cross-check: a repo cannot be both active here and retired in configs/repos.json.
      try {
        const retired = JSON.parse(readFileSync(path.join(ROOT, 'configs', 'repos.json'), 'utf8')).retired || [];
        for (const r of repos) if (retired.includes(r)) findings.push({ level: 'WARN', msg: `${r}: listed active here but retired in configs/repos.json — one of the two is wrong` });
      } catch {
        /* repos.json absent = nothing retired (see cli/util/repos.js) */
      }
      if (!findings.length) add('project-repos', 'OK', 'project-repos', `${repos.length} active repo(s) cloned as siblings in ${sourcesDir}: ${repos.join(', ')}`, { repos, sourcesDir });
      else for (const f of findings) add('project-repos', f.level, 'project-repos', f.msg, { repos, sourcesDir });
    }
  }

  // --- (c) tool presence + reported versions ---
  /** @type {Record<string, string>} */
  const versions = {};
  for (const t of toolPlan(station)) {
    if (t.requirement === 'n/a') {
      add(`tool:${t.name}`, 'INFO', `tool ${t.name}`, `not required here (${t.why})`);
      continue;
    }
    const r = probe(t.name, t.argv);
    // A missing tool under `shell: true` still WRITES output ("'x' is not recognized"), so
    // presence is: clean exit, or a version-looking answer that is not a shell error.
    if (!toolFound(r)) {
      add(`tool:${t.name}`, t.requirement === 'required' ? 'FAIL' : 'WARN', `tool ${t.name}`, `not found on PATH — needed for ${t.why}`);
      continue;
    }
    const v = parseVersion(r.out);
    versions[t.name] = v;
    add(`tool:${t.name}`, 'OK', `tool ${t.name}`, `${v}${t.requirement === 'optional' ? ' (optional)' : ''}`, { version: v, requirement: t.requirement });
  }

  // --- (c2) git on the MACHINE PATH — invisible until an S4U task fails silently ---
  if (!windowsStation) {
    add('git-machine-path', 'INFO', 'git-machine', 'n/a — machine vs user PATH is a Windows distinction');
  } else {
    const r = probe('reg', ['query', '"HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment"', '/v', 'Path'], 15000);
    const machinePath = parseRegPath(r.out);
    if (!machinePath) add('git-machine-path', 'WARN', 'git-machine', 'could not read the system PATH from the registry');
    else {
      const dir = machinePathGitDir(machinePath, (d) => existsSync(path.join(d, 'git.exe')) || existsSync(path.join(d, 'git.cmd')), process.env);
      if (dir) add('git-machine-path', 'OK', 'git-machine', `git on the MACHINE PATH (${dir})`, { dir });
      else add('git-machine-path', 'FAIL', 'git-machine', 'git is NOT on the machine (system) PATH — an S4U scheduled task cannot see the user PATH, so Claude-WorkspacePull fails silently');
    }
  }

  // --- (d) Claude-WorkspacePull registration (Windows stations only) ---
  if (!windowsStation || !interactive) {
    add('pull-task', 'INFO', 'pull-task', windowsStation ? 'skipped — not an interactive station' : 'n/a — scheduled pull runs as a container job here (configs/jobs/jobs.json)');
  } else {
    const r = probe('schtasks', ['/Query', '/TN', 'Claude-WorkspacePull', '/V', '/FO', 'LIST'], 20000);
    const t = parseSchtasks(r.out, r.status ?? 1);
    if (!t.found) {
      add('pull-task', 'FAIL', 'pull-task', 'Claude-WorkspacePull not registered — its 15-min tick is also the SSH tunnel\'s only keeper and the fallback-log replay; register with setup-scripts\\windows\\register-pull-task.cmd');
    } else if (t.state && /disabled/i.test(t.state)) {
      add('pull-task', 'FAIL', 'pull-task', `registered but ${t.state} — no tunnel keeper, no fallback replay between sessions`, { state: t.state });
    } else if (t.lastResult && !/^0(x0)?$/i.test(t.lastResult)) {
      add('pull-task', 'WARN', 'pull-task', `registered (${t.state || 'state unknown'}) but LastResult=${t.lastResult}`, { state: t.state, lastResult: t.lastResult, nextRun: t.nextRun });
    } else {
      add('pull-task', 'OK', 'pull-task', `registered, ${t.state || 'state unknown'}, next run ${t.nextRun || 'unknown'}`, { state: t.state, lastResult: t.lastResult, nextRun: t.nextRun });
    }
  }

  // --- (d2) NSG ssh allowlist vs this station's public IP ---
  // A rotated home IP silently drops port 22 at the NSG, which kills the log-API SSH
  // tunnel with no message anywhere (lived 2026-08-25). Compares the measured public IP
  // against the control plane's ssh rule and, on a mismatch, prints the exact
  // `az network nsg rule update` the CEO runs — this tool never runs it (D5).
  // Cost-gated inside the check: the az read is skipped while the cached verdict is
  // `covered` for the same IP, so the 15-minute tick pays only the IP probe.
  try {
    const { nsgAllowlistCheck } = await import('../util/nsgcheck.js');
    results.push(await nsgAllowlistCheck({ root: ROOT, env: self, hasTunnel: Boolean(station?.hasTunnel) }));
  } catch (e) {
    add('nsg-ssh-allowlist', 'INFO', 'nsg-ssh', `check errored — skipped (${e instanceof Error ? e.message : e})`);
  }

  // --- (e) gh OAuth scope set (informational — scopes are cumulative per account) ---
  {
    const r = probe('gh', ['auth', 'status'], 20000);
    const scopes = parseGhScopes(r.out);
    if (!r.ok) add('gh-scopes', 'WARN', 'gh-scopes', 'gh auth status failed — not logged in on this station (`gh auth login`)');
    else if (!scopes.length) add('gh-scopes', 'INFO', 'gh-scopes', 'authenticated; no scope line reported');
    else add('gh-scopes', 'INFO', 'gh-scopes', `scopes: ${scopes.join(', ')}`, { scopes });
  }

  // --- control plane: VM host state git cannot see, probed read-only over SSH ---
  // Kind-aware by construction: only a station with a logApiTunnel.sshTarget can probe
  // (the container gets an INFO skip). Gated so the 15-min tick never adds SSH
  // round-trips beyond one attempt/day; a failed probe is INFO, never FAIL.
  if (controlPlane !== 'off') {
    const tunnel = /** @type {{sshTarget: string, identityFile?: string}|null} */ (
      (self && envs?.environments?.[self]?.logApiTunnel?.sshTarget) ? envs.environments[self].logApiTunnel : null
    );
    try {
      results.push(...await collectControlPlaneChecks({ workspaceRoot: ROOT, tunnel, force: controlPlane === 'force' }));
    } catch (e) {
      results.push({ id: 'control-plane', level: 'INFO', name: 'control-plane', detail: `probe errored — skipped (${e instanceof Error ? e.message : e})` });
    }
  }

  // --- (f) feature registry vs reality (drift check) ---
  // Runs LAST so it can judge `check:` evidence against every id this run emitted.
  // Rules + rationale: featureDriftChecks above; spec: SYSTEM.md "Feature-registry
  // drift check". The roster read powers the cross-station lookup — unreachable API
  // degrades to INFO for unresolved ids, never a guessed WARN.
  try {
    const loaded = loadFeatures({
      featuresPath: path.join(ROOT, 'configs', 'features.json'),
      envsPath: path.join(ROOT, 'configs', 'environments.json'),
      jobsPath: path.join(ROOT, 'configs', 'jobs', 'jobs.json'),
    });
    /** @type {{jobs?: {name?: string}[]}} */
    let jobsCfg = {};
    try {
      jobsCfg = JSON.parse(readFileSync(path.join(ROOT, 'configs', 'jobs', 'jobs.json'), 'utf8'));
    } catch {
      /* an unreadable jobs.json already surfaces through loadFeatures' errors */
    }
    /** @type {Set<string>|null} */
    let remoteIds = null;
    try {
      const { stationList } = await import('../util/apiclient.js');
      const roster = /** @type {{stations?: {report?: {results?: {id?: unknown}[]}}[]}} */ (JSON.parse(await stationList({ format: 'json' })));
      remoteIds = new Set((roster.stations || []).flatMap((s) => (s?.report?.results || []).map((c) => c?.id)).filter((x) => typeof x === 'string'));
    } catch {
      /* roster unreachable — unresolved ids report INFO, never a guessed WARN */
    }
    results.push(...featureDriftChecks({
      loaded,
      jobsCfg,
      toolNames: toolPlan(station).map((t) => t.name),
      self: self || null,
      envsCfg: envs || {},
      emittedIds: new Set(results.map((r) => r.id)),
      remoteIds,
    }));
  } catch (e) {
    add('feature-registry', 'INFO', 'features', `drift check errored — skipped (${e instanceof Error ? e.message : e})`);
  }

  // --- decoration: the colloquial explainer rides every row (see explainCheck) ---
  for (const r of results) {
    if (r.explain === undefined) {
      const e = explainCheck(r.id);
      if (e) r.explain = e;
    }
  }

  return results;
}

/**
 * The reusable payload (W3 has `ws pull` report this to the DB).
 * @param {CheckResult[]} results
 */
export function payload(results) {
  return {
    env: process.env.WS_ENV || null,
    platform: process.platform,
    at: stamp(),
    ok: !checksFailed(results),
    results,
  };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const results = await collectChecks({ controlPlane: process.argv.includes('--control-plane') ? 'force' : 'auto' });
  if (process.argv.includes('--json')) {
    console.log(JSON.stringify(payload(results), null, 2));
  } else {
    for (const r of results) console.log(`${r.level.padEnd(4)} ${r.name.padEnd(14)} ${r.detail}`);
  }
  process.exit(checksFailed(results) ? 1 : 0);
}
