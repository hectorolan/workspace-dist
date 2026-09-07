// controlplane.js — the control-plane half of env-doctor (test plans
// `ws plan get test-plan-env-doctor-control-plane` and
// `ws plan get test-plan-cp-env-per-service`).
//
// Host-side facts live on the VM HOST, outside every git tree and outside the
// container, so no station-local check can see them — yet each one was hand-fixed
// once (2026-07-20) and silently breaking again would be invisible:
//   1. the crontab line running `setup-scripts/deploy/deploy.sh hub` every 5 min
//      (continuous deployment itself),
//   2. the hub prod deploy wiring deploy.sh names: the compose file
//      `~/agent/hub/docker-compose.prod.yml` and the deploy clone
//      `~/agent/hub/repo` (both exist only on the VM host, in no repo),
//   3. per-service env health: every service deployed under `~/agent` (derived by
//      walking the dir, never a hardcoded list) is judged against ITS OWN repo's
//      `.env.example` — required only where the service that needs it exists. The
//      env file rides at `<svc>/.env` (workspace, staging) or `<svc>/repo/.env`
//      (hub prod compose: `env_file: ./repo/.env`; probed on the VM
//      2026-08-01). Three states per capability group: ready (required &
//      present), missing (required & absent — FAIL, what holds the service), off
//      (optional & unset — INFO, says what is switched off). One result row per
//      capability regardless of state, so the Stations page can render the full
//      list for healthy services too. Capability labels/markers come from the
//      owning repo's `.env.example` comment convention (grammar: SYSTEM.md
//      "Per-service env health"), parsed from LOCAL sibling clones only — free
//      text never rides the SSH wire.
// A station that already holds the read-only SSH path to the VM (its
// `logApiTunnel.sshTarget`) probes them and reports in the same CheckResult shape
// env-doctor emits, so the Stations page renders them with no hub change.
//
// HARD RULES (dispatch constraints, pinned by cli/test/controlplane.test.js):
// - No secret VALUE is ever transmitted, cached, or printed. The remote script emits
//   only counts, present/absent flags, service dir names and var NAMES; values are
//   consulted remotely (length only) and never leave the host. The parser
//   additionally drops anything not identifier-shaped, and result details are built
//   from parsed fields — never from raw ssh output (banners/motd could contain
//   anything).
// - Forward-looking only: every assertion derives from what current repo config
//   declares (deploy.sh's own wiring, each repo's `.env.example`). No legacy
//   names, no denylists.
// - No SSH on the 15-minute tick: the default path attempts at most ONE probe per
//   calendar day (stamp + cache in `<WS_DATA_DIR>/control-plane/checks.json`) and
//   serves the cached results otherwise; `--control-plane` forces a fresh probe.
// - An unreachable or absent SSH path is INFO/skip, never FAIL — an offline station
//   is not a broken control plane.
// - Read-only probes only: `crontab -l`, file-existence tests, `awk` over names.
import os from 'node:os';
import path from 'node:path';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dataDir, today, stamp } from './clock.js';
import { sshBinary } from './tunnel.js';

/** @typedef {'OK'|'WARN'|'FAIL'|'INFO'} Level */
/** @typedef {{id: string, level: Level, name: string, detail: string, data?: Record<string, unknown>}} CheckResult */
/** @typedef {{sshTarget: string, identityFile?: string}} SshPath */
/** @typedef {{day: string, probedAt?: string, results: CheckResult[]}} CpCache */
/** @typedef {{name: string, required: boolean}} EnvVarSpec */
/** @typedef {{label: string|null, marker: 'required'|'optional'|null, offNote: string|null, vars: EnvVarSpec[]}} EnvGroup */
/** @typedef {{name: string, envloc: 'top'|'repo'|null, envfile: boolean|null, envNames: string[]}} ServiceReport */
/** @typedef {(svc: string) => {text: string, source: string}|null} ExampleResolver */

/**
 * The remote probe, sent as ONE ssh argv element (no local shell involved) and run by
 * the remote login shell. Every output line this module will read is `WSCP `-prefixed;
 * anything else (motd, banners) is ignored by the parser. It prints ONLY:
 * counts (`cron=N`), present/absent flags, service DIR names, env var NAMES (awk
 * field $1 — the value field $2 is consulted through length() alone), and a `done`
 * sentinel proving the script ran to completion rather than the connection dying
 * mid-way. Which services exist is DERIVED from `~/agent` (never hardcoded): a dir
 * is a service when it carries an env file at `./.env` or `./repo/.env`, or is a
 * deploy clone / workspace-style clone that SHOULD have one (reported absent).
 */
export const REMOTE_SCRIPT = [
  'set -u',
  // deploy.sh's own header names this exact cron line; hub-staging deploys via
  // the CD workflow, so only the prod target is cron-asserted. Output is a COUNT.
  'C=$(crontab -l 2>/dev/null | grep -v "^ *#" | grep -Ec "deploy\\.sh +hub( |$)")',
  'echo "WSCP cron=${C:-0}"',
  'if [ -f "$HOME/agent/hub/docker-compose.prod.yml" ]; then echo "WSCP compose=present"; else echo "WSCP compose=absent"; fi',
  'if [ -d "$HOME/agent/hub/repo/.git" ]; then echo "WSCP clone=present"; else echo "WSCP clone=absent"; fi',
  'for d in "$HOME"/agent/*/; do',
  '  n=$(basename "$d")',
  '  f=""; loc=""',
  '  if [ -f "$d.env" ]; then f="$d.env"; loc=top; elif [ -f "${d}repo/.env" ]; then f="${d}repo/.env"; loc=repo; fi',
  '  if [ -n "$f" ]; then',
  '    echo "WSCP service=$n"; echo "WSCP envloc=$loc"; echo "WSCP envfile=present"',
  '    awk -F= \'/^[A-Za-z_][A-Za-z0-9_]*=/ { if (length($2)) print "WSCP envname=" $1 }\' "$f"',
  '  elif [ -d "${d}repo/.git" ] || { [ -d "$d.git" ] && [ -f "$d.env.example" ]; }; then',
  '    echo "WSCP service=$n"; echo "WSCP envfile=absent"',
  '  fi',
  'done',
  'echo "WSCP done"',
].join('\n');

// --- the .env.example comment convention (grammar: SYSTEM.md "Per-service env
// health"; the repo owning a var owns its label — never a mapping table here) ---
const MARKER_RE = /^#\s*env-doctor:\s*(.*)$/i;
const OFF_RE = /^#\s*env-doctor-off:\s*(.*)$/i;
const VAR_RE = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/;

/**
 * `# env-doctor: [required|optional] [— ]<label>` → marker + label. Both parts
 * optional: a leading `required`/`optional` word (case-insensitive) is the marker,
 * the remainder (leading dash/colon separators stripped) is the label.
 * @param {string} rest text after the `env-doctor:` prefix
 * @returns {{marker: 'required'|'optional'|null, label: string|null}}
 */
function parseMarker(rest) {
  /** @type {'required'|'optional'|null} */
  let marker = null;
  let label = String(rest || '').trim();
  const m = /^(required|optional)\b/i.exec(label);
  if (m) {
    marker = /** @type {'required'|'optional'} */ (m[1].toLowerCase());
    label = label.slice(m[0].length).trim();
  }
  label = label.replace(/^[—–:-]+\s*/, '').trim();
  return { marker, label: label || null };
}

/**
 * Parse a repo's `.env.example` into capability groups. A group is a run of
 * uncommented `KEY=` lines: comment lines between vars do NOT split it, a blank
 * line or the next `# env-doctor:` marker does. A marker (and an
 * `# env-doctor-off:` note) annotates the next group. Degrade rules (the naive
 * "uncommented KEY= means required" rule is dead — it caused the 2026-07-30
 * false FAIL): no marker + empty example value ⇒ required; no marker +
 * non-empty example value ⇒ documented default ⇒ optional; no label ⇒ callers
 * fall back to the var names. Commented `#KEY=` alternates never join a group
 * (they ride ENV_ALTERNATES instead).
 * @param {string} text
 * @returns {EnvGroup[]}
 */
export function parseEnvExample(text) {
  /** @type {EnvGroup[]} */
  const groups = [];
  /** @type {EnvGroup|null} */
  let cur = null;
  /** @type {EnvGroup|null} annotation awaiting its var group (vars stays empty until adopted) */
  let pending = null;
  for (const raw of String(text).split('\n')) {
    const line = raw.trim();
    if (!line) { cur = null; continue; } // blank closes the group; a pending marker still awaits its group
    const mm = MARKER_RE.exec(line);
    if (mm) {
      const parsed = parseMarker(mm[1]);
      pending = { marker: parsed.marker, label: parsed.label, offNote: pending && !cur ? pending.offNote : null, vars: [] };
      cur = null;
      continue;
    }
    const om = OFF_RE.exec(line);
    if (om) {
      const note = om[1].trim() || null;
      if (cur) cur.offNote = note;
      else if (pending) pending.offNote = note;
      else pending = { marker: null, label: null, offNote: note, vars: [] };
      continue;
    }
    if (line.startsWith('#')) continue; // ordinary comments neither join nor split a group
    const vm = VAR_RE.exec(line);
    if (!vm) continue;
    if (!cur) {
      cur = { label: pending ? pending.label : null, marker: pending ? pending.marker : null, offNote: pending ? pending.offNote : null, vars: [] };
      groups.push(cur);
      pending = null;
    }
    const required = cur.marker ? cur.marker === 'required' : vm[2].trim() === '';
    cur.vars.push({ name: vm[1], required });
  }
  return groups;
}

/**
 * Documented either-of pairs (`.env.example`: "set ONE of these").
 * @type {Record<string, string[]>}
 */
const ENV_ALTERNATES = {
  CLAUDE_CODE_OAUTH_TOKEN: ['ANTHROPIC_API_KEY'],
  ANTHROPIC_API_KEY: ['CLAUDE_CODE_OAUTH_TOKEN'],
};

/**
 * Is a var satisfied by the names present on the host — directly, or via a
 * documented alternate?
 * @param {string} name @param {string[]} presentNames
 * @returns {boolean}
 */
export function envSatisfied(name, presentNames) {
  if (presentNames.includes(name)) return true;
  return (ENV_ALTERNATES[name] || []).some((alt) => presentNames.includes(alt));
}

/**
 * One capability group's state against the names present on the host.
 * ready = everything present; missing = a REQUIRED var absent (holds the
 * service); off = only optional vars absent (feature switched off).
 * @param {EnvGroup} group @param {string[]} presentNames
 * @returns {{state: 'ready'|'off'|'missing', missing: string[], unset: string[]}}
 */
export function envGroupState(group, presentNames) {
  const unset = group.vars.filter((v) => !envSatisfied(v.name, presentNames)).map((v) => v.name);
  const missing = group.vars.filter((v) => v.required && !envSatisfied(v.name, presentNames)).map((v) => v.name);
  return { state: missing.length ? 'missing' : unset.length ? 'off' : 'ready', missing, unset };
}

// Service dir names ride into result ids/details, so they are shape-validated like
// env names (defense in depth: nothing value-shaped can smuggle through `service=`).
const SERVICE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/**
 * Parse the remote report. Reads ONLY `WSCP `-prefixed lines; env names must be
 * identifier-shaped and service names dir-name-shaped (defense in depth — nothing
 * value-shaped can ride into results, cache, or the Stations page; an invalid
 * service name drops the env lines that follow it too). `done` proves the script
 * completed.
 * @param {string} out raw ssh stdout
 * @returns {{done: boolean, cron: number|null, compose: boolean|null, clone: boolean|null, services: ServiceReport[]}}
 */
export function parseReport(out) {
  const report = {
    done: false,
    cron: /** @type {number|null} */ (null),
    compose: /** @type {boolean|null} */ (null),
    clone: /** @type {boolean|null} */ (null),
    services: /** @type {ServiceReport[]} */ ([]),
  };
  /** @type {ServiceReport|null} */
  let cur = null;
  for (const raw of String(out || '').split('\n')) {
    const line = raw.replace(/\r$/, '').trim();
    if (line === 'WSCP done') { report.done = true; continue; }
    const m = /^WSCP ([a-z]+)=(.*)$/.exec(line);
    if (!m) continue;
    const [, key, value] = m;
    if (key === 'cron' && /^\d+$/.test(value)) report.cron = Number(value);
    else if (key === 'compose' || key === 'clone') report[key] = value === 'present' ? true : value === 'absent' ? false : null;
    else if (key === 'service') {
      cur = SERVICE_RE.test(value) ? { name: value, envloc: null, envfile: null, envNames: [] } : null;
      if (cur) report.services.push(cur);
    } else if (key === 'envloc' && cur) cur.envloc = value === 'top' || value === 'repo' ? value : null;
    else if (key === 'envfile' && cur) cur.envfile = value === 'present' ? true : value === 'absent' ? false : null;
    else if (key === 'envname' && cur && /^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) cur.envNames.push(value);
  }
  return report;
}

/**
 * Turn a parsed report into CheckResults. Pure — details are built from parsed
 * fields only, never raw output. Per service: one summary headline
 * (`cp-env:<svc>`, FAIL only when a required var is missing) followed by one row
 * per capability REGARDLESS of state (ready→OK, off→INFO, missing→FAIL), each
 * self-sufficient for rendering: data.service / data.capability / data.vars /
 * data.state / data.note.
 * @param {ReturnType<typeof parseReport>} report
 * @param {ExampleResolver} exampleFor local `.env.example` lookup per service
 * @param {{sshTarget: string, probedAt: string}} ctx
 * @returns {CheckResult[]}
 */
export function controlPlaneResults(report, exampleFor, { sshTarget, probedAt }) {
  /** @type {CheckResult[]} */
  const results = [{
    id: 'control-plane',
    level: 'INFO',
    name: 'control-plane',
    detail: `VM host state probed read-only via ${sshTarget} at ${probedAt} (refreshed daily; force with env-doctor --control-plane)`,
    data: { sshTarget, probedAt },
  }];
  /** @type {(id: string, level: Level, detail: string, data?: Record<string, unknown>) => void} */
  const add = (id, level, detail, data) => results.push({ id, level, name: id, detail, data: { probedAt, ...(data || {}) } });

  if (report.cron === null) add('cp-cron', 'WARN', 'remote report carried no crontab fact — probe output incomplete');
  else if (report.cron >= 1) add('cp-cron', 'OK', `deploy cron line present (runs deploy.sh hub every 5 min)`);
  else add('cp-cron', 'FAIL', 'no crontab line runs setup-scripts/deploy/deploy.sh hub — continuous deployment is OFF (the line is documented in deploy.sh\'s header)');

  if (report.compose === null) add('cp-compose', 'WARN', 'remote report carried no compose fact — probe output incomplete');
  else if (report.compose) add('cp-compose', 'OK', '~/agent/hub/docker-compose.prod.yml present (the COMPOSE file deploy.sh wires)');
  else add('cp-compose', 'FAIL', '~/agent/hub/docker-compose.prod.yml missing — deploy.sh cannot compose; this file exists only on the VM host, in no repo');

  if (report.clone === null) add('cp-clone', 'WARN', 'remote report carried no deploy-clone fact — probe output incomplete');
  else if (report.clone) add('cp-clone', 'OK', '~/agent/hub/repo is a git clone (deploy.sh\'s REPO_DIR)');
  else add('cp-clone', 'FAIL', '~/agent/hub/repo is not a git clone — deploy.sh reports "app not installed" and exits');

  if (!report.services.length) {
    add('cp-env', 'WARN', 'remote report carried no service env facts — probe output incomplete');
    return results;
  }
  for (const svc of report.services) {
    const envPath = svc.envloc === 'repo' ? `~/agent/${svc.name}/repo/.env` : `~/agent/${svc.name}/.env`;
    const spec = exampleFor(svc.name);
    if (!spec) {
      add(`cp-env:${svc.name}`, 'INFO', `service ${svc.name} deployed on the VM but this station has no ${svc.name}/.env.example to compare against (clone ${svc.name} as a sibling under sources/) — capabilities not assertable`, { service: svc.name });
      continue;
    }
    if (svc.envfile === null) {
      add(`cp-env:${svc.name}`, 'WARN', `remote report carried no .env fact for service ${svc.name} — probe output incomplete`, { service: svc.name });
      continue;
    }
    const groups = parseEnvExample(spec.text);
    const present = svc.envfile ? svc.envNames : [];
    /** @type {CheckResult[]} */
    const rows = [];
    let nReady = 0, nOff = 0, nMissing = 0;
    for (const g of groups) {
      if (!g.vars.length) continue;
      const { state, missing, unset } = envGroupState(g, present);
      const label = g.label || g.vars.map((v) => v.name).join(', ');
      const names = g.vars.map((v) => v.name);
      const level = state === 'ready' ? 'OK' : state === 'off' ? 'INFO' : 'FAIL';
      // A group of ONLY optional vars that are all present is "set", not "ready".
      // The probe sees presence, never values (by design), so for a toggle like
      // AUTH_BYPASS "ready" reads as "the bypass is armed" when all we actually
      // know is that the var exists — it may well be `false`. That false alarm on
      // a security-shaped setting is exactly the kind that gets the panel ignored
      // (audit 2026-08-01). "set" claims only what was measured.
      const optionalOnly = g.vars.every((v) => !v.required);
      const detail = state === 'ready'
        ? (optionalOnly
          ? `set — ${names.join(', ')} present in ${envPath} (value not visible from here)`
          : `ready — ${names.join(', ')} set in ${envPath}`)
        : state === 'off'
          ? `off — optional not set: ${unset.join(', ')} — ${g.offNote || 'this capability stays switched off'}`
          : `missing — required var(s) absent from ${envPath}: ${missing.join(', ')}${g.offNote ? ` — ${g.offNote}` : ''}`;
      if (state === 'ready') nReady += 1; else if (state === 'off') nOff += 1; else nMissing += 1;
      rows.push({
        id: `cp-env:${svc.name}:${names[0]}`,
        level,
        name: `${svc.name}: ${label}`,
        detail,
        data: { probedAt, service: svc.name, capability: g.label, vars: names, state, ...(g.offNote ? { note: g.offNote } : {}) },
      });
    }
    if (svc.envfile === false) {
      add(`cp-env:${svc.name}`, 'FAIL', `no .env for service ${svc.name} on the VM host (neither ~/agent/${svc.name}/.env nor ~/agent/${svc.name}/repo/.env) — every required var is missing (names from ${spec.source})`, { service: svc.name, ready: nReady, off: nOff, missing: nMissing });
    } else {
      add(`cp-env:${svc.name}`, nMissing ? 'FAIL' : 'OK', `${envPath}: ${nReady} ready, ${nOff} off, ${nMissing} missing of ${rows.length} capabilities (names from ${spec.source}; values never leave the host)`, { service: svc.name, ready: nReady, off: nOff, missing: nMissing });
    }
    results.push(...rows);
  }
  return results;
}

/**
 * Probe at most once per calendar day unless forced.
 * @param {CpCache|null} cache @param {string} todayStr @param {boolean} force
 * @returns {boolean}
 */
export function shouldRefresh(cache, todayStr, force) {
  return force || !cache || cache.day !== todayStr;
}

/**
 * One-shot read-only ssh run of the remote script. Same option set as the tunnel's
 * ssh (BatchMode, StrictHostKeyChecking=yes — no TOFU), no local shell (the script
 * travels as a single argv element), stdout only (stderr may carry banner junk).
 * @param {SshPath} tunnel @param {string} script @param {number} [timeoutMs]
 * @returns {{ok: boolean, out: string}}
 */
export function runSshProbe(tunnel, script, timeoutMs = 45000) {
  const args = [
    '-T',
    '-o', 'BatchMode=yes',
    '-o', 'ConnectTimeout=10',
    '-o', 'StrictHostKeyChecking=yes',
    '-o', 'LogLevel=ERROR',
  ];
  const key = tunnel.identityFile || path.join(os.homedir(), '.ssh', 'id_rsa');
  if (existsSync(key)) args.push('-i', key);
  args.push(tunnel.sshTarget, script);
  const r = spawnSync(sshBinary(), args, { encoding: 'utf8', timeout: timeoutMs, windowsHide: true });
  return { ok: r.status === 0 && !r.error, out: String(r.stdout || '') };
}

/** @returns {string} cache/stamp file (per-machine data dir, never git) */
export function cacheFile() {
  return path.join(dataDir(), 'control-plane', 'checks.json');
}

/** @returns {CpCache|null} */
function readCacheFile() {
  try {
    const parsed = JSON.parse(readFileSync(cacheFile(), 'utf8'));
    return Array.isArray(parsed?.results) && typeof parsed?.day === 'string' ? parsed : null;
  } catch {
    return null;
  }
}

/** @param {CpCache} cache */
function writeCacheFile(cache) {
  try {
    mkdirSync(path.dirname(cacheFile()), { recursive: true });
    writeFileSync(cacheFile(), JSON.stringify(cache, null, 2));
  } catch { /* a read-only data dir must not break the doctor */ }
}

/**
 * The control-plane check group. Every seam is injectable for tests; production
 * callers use collectControlPlaneChecks() below.
 * @param {{
 *   tunnel: SshPath|null,
 *   force: boolean,
 *   todayStr: string,
 *   probedAt: string,
 *   exampleFor: ExampleResolver,
 *   readCache: () => CpCache|null,
 *   writeCache: (c: CpCache) => void,
 *   runSsh: (tunnel: SshPath, script: string) => {ok: boolean, out: string},
 * }} opts
 * @returns {Promise<CheckResult[]>}
 */
export async function collectControlPlane({ tunnel, force, todayStr, probedAt, exampleFor, readCache, writeCache, runSsh }) {
  if (!tunnel || !tunnel.sshTarget) {
    return [{
      id: 'control-plane',
      level: 'INFO',
      name: 'control-plane',
      detail: 'no SSH path from this station (logApiTunnel.sshTarget in configs/environments.json) — control-plane probes run from a tunneled station',
    }];
  }
  const cache = readCache();
  if (!shouldRefresh(cache, todayStr, force) && cache) return cache.results;
  const r = runSsh(tunnel, REMOTE_SCRIPT);
  const report = parseReport(r.out);
  /** @type {CheckResult[]} */
  const results = (r.ok && report.done)
    ? controlPlaneResults(report, exampleFor, { sshTarget: tunnel.sshTarget, probedAt })
    : [{
        id: 'control-plane',
        level: 'INFO',
        name: 'control-plane',
        detail: `SSH probe to ${tunnel.sshTarget} did not complete — skipped (an offline path is not a broken control plane; retried tomorrow, or now with --control-plane)`,
        data: { sshTarget: tunnel.sshTarget, probedAt },
      }];
  // Stamp the ATTEMPT, success or not: at most one SSH round-trip per day rides the
  // 15-minute tick; --control-plane is the retry-now lever.
  writeCache({ day: todayStr, probedAt, results });
  return results;
}

/**
 * Resolve a remote service name to the LOCAL `.env.example` that declares its
 * desired state: the workspace repo's own file for `workspace`, a sibling clone
 * `sources/<svc>/.env.example` otherwise, with a `-staging` service falling back
 * to its base repo (deploy.sh names staging targets `<repo>-staging`). Labels are
 * free text, so they can only come from local files — never the SSH wire.
 * @param {string} workspaceRoot
 * @param {(file: string) => string} [readFile] seam for tests (throws when absent)
 * @returns {ExampleResolver}
 */
export function localExampleResolver(workspaceRoot, readFile = (f) => readFileSync(f, 'utf8')) {
  const sourcesDir = path.dirname(workspaceRoot);
  return (svc) => {
    /** @type {{file: string, source: string}[]} */
    const candidates = [];
    if (svc === 'workspace') candidates.push({ file: path.join(workspaceRoot, '.env.example'), source: 'workspace/.env.example' });
    else {
      candidates.push({ file: path.join(sourcesDir, svc, '.env.example'), source: `${svc}/.env.example` });
      if (svc.endsWith('-staging')) {
        const base = svc.slice(0, -'-staging'.length);
        candidates.push({ file: path.join(sourcesDir, base, '.env.example'), source: `${base}/.env.example` });
      }
    }
    for (const c of candidates) {
      try {
        return { text: readFile(c.file), source: c.source };
      } catch { /* try next candidate */ }
    }
    return null;
  };
}

/**
 * Production entry used by env-doctor: real ssh, local sibling `.env.example`
 * files, the data-dir cache, clock.js time.
 * @param {{workspaceRoot: string, tunnel: SshPath|null, force?: boolean}} opts
 * @returns {Promise<CheckResult[]>}
 */
export async function collectControlPlaneChecks({ workspaceRoot, tunnel, force = false }) {
  return collectControlPlane({
    tunnel,
    force,
    todayStr: today(),
    probedAt: stamp(),
    exampleFor: localExampleResolver(workspaceRoot),
    readCache: readCacheFile,
    writeCache: writeCacheFile,
    runSsh: runSshProbe,
  });
}
