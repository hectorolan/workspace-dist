// Self-restart on relevant pulls (backlog 1, 2026-07-26) — closes the gap where a
// pushed change to the scheduler, the job config, the server, or the lockfile sat
// dormant until someone manually restarted the container (the scheduler arms its
// cron table once at boot; 3 manual restarts in 24h forced this feature).
//
// `ws pull` calls flagRestartIfNeeded() every tick: it diffs the repo from the
// last commit this machine checked (state in WS_DATA_DIR — other jobs and the
// entrypoint pull too, so "this tick's pulled range" would miss changes; same
// precedent as the deps self-heal in cli/ws.js), filters for the restart-trigger
// paths, syntax-gates the changed files, and touches a restart marker. The
// scheduler (cli/util/scheduler.js) polls the marker between fires, drains, logs
// ONE line, and exits 0 — Docker's `restart: unless-stopped` plus the entrypoint
// pull bring everything back on current code. One path, no host-side cron.
//
// A broken push must stay on OLD running code, never boot-loop: when the syntax
// gate fails, NO marker is written and one loud `failed` line goes to the central
// log (agent `self-restart` — a scripted log writer like pr-watch, sanctioned in
// CLAUDE.md "Logging convention"). The state still advances, so the fix commit
// (which touches the same trigger paths) re-triggers the check exactly once.
import { readFileSync, writeFileSync, mkdirSync, existsSync, rmSync } from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { dataDir } from './clock.js';
import { log as apiLog } from './apiclient.js';

/** Restart-trigger paths (backlog 1; jobs.json added to the set 2026-07-22). */
const TRIGGERS = ['cli/util/scheduler.js', 'configs/jobs/jobs.json', 'package-lock.json'];

/** @param {string} file repo-relative path (either slash style) */
export function isTriggerPath(file) {
  const f = file.replace(/\\/g, '/');
  return f.startsWith('server/') || TRIGGERS.includes(f);
}

/** Marker consumed by the scheduler; state = last commit this machine checked. */
export function markerPath() {
  return path.join(dataDir(), 'restart', 'restart-requested');
}
function statePath() {
  return path.join(dataDir(), 'restart', 'last-checked');
}

/** @param {string} dir @param {string[]} args */
function git(dir, args) {
  return execFileSync('git', ['-C', dir, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

/** @param {string} p @param {string} content */
function writeFile(p, content) {
  mkdirSync(path.dirname(p), { recursive: true });
  writeFileSync(p, content, 'utf8');
}

/**
 * Syntax-gate the changed trigger files: `node --check` per changed .js (ESM is
 * fine — node respects the nearest package.json `type`), JSON.parse + croner
 * pattern validation for jobs.json (a bad cron pattern would crash-loop the
 * scheduler at boot — worse than the stale-schedule bug this module fixes), no
 * check for the lockfile (ensureDeps already gated it: `ws pull` returns before
 * this check when the install fails). Deleted files are not checkable; their
 * deletion still flags a restart.
 * @param {string} root
 * @param {string[]} files repo-relative changed trigger files
 * @returns {Promise<string[]>} failures, empty = pass
 */
export async function checkFiles(root, files) {
  const failures = [];
  for (const file of files) {
    const abs = path.join(root, file);
    if (!existsSync(abs)) continue; // deleted — nothing to syntax-check
    if (file.replace(/\\/g, '/') === 'configs/jobs/jobs.json') {
      try {
        const cfg = JSON.parse(readFileSync(abs, 'utf8'));
        try {
          const { Cron } = await import('croner');
          for (const job of cfg.jobs || []) {
            if (job.disabled) continue;
            const c = new Cron(job.cron, { timezone: cfg.timezone, paused: true });
            c.stop();
          }
        } catch (e) {
          // croner import failure is not a config failure; a pattern error is.
          if (!(e instanceof Error && /Cannot find|ERR_MODULE_NOT_FOUND/.test(e.message))) {
            failures.push(`${file}: ${e instanceof Error ? e.message : e}`);
          }
        }
      } catch (e) {
        failures.push(`${file}: ${e instanceof Error ? e.message : e}`);
      }
    } else if (file.endsWith('.js')) {
      // Caveat (observed Node 24): without a nearest package.json `type`, --check
      // lets detected-ESM sources pass unparsed. Both real trigger trees carry one
      // (cli: "type":"module"; server: CJS package.json), so the gate is honest here.
      try {
        execFileSync(process.execPath, ['--check', abs], {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe'],
        });
      } catch (e) {
        const err = /** @type {{stderr?: string, message?: string}} */ (e);
        const lines = String(err.stderr || err.message || 'syntax check failed').trim().split('\n');
        failures.push(`${file}: ${lines.find((l) => /Error/.test(l)) || lines[lines.length - 1]}`);
      }
    }
  }
  return failures;
}

/**
 * The `ws pull` tick: diff last-checked..HEAD, flag a restart when trigger paths
 * changed and pass the syntax gate. Inert off the schedule owner (spec: the PC
 * must never restart anything — and must not duplicate the container's `failed`
 * line on the same broken push). Never throws for the caller's benefit beyond
 * git/env oddities — `ws pull` wraps it like pr-watch anyway.
 * @param {{root: string, env?: NodeJS.ProcessEnv}} opts
 * @returns {Promise<{status: string, detail?: string, failures?: string[]}>}
 */
export async function flagRestartIfNeeded({ root, env = process.env }) {
  // Ownership: only the environment that runs the scheduler acts on triggers.
  const envsPath = env.WS_ENVS_CONFIG || path.join(root, 'configs', 'environments.json');
  try {
    const owner = /** @type {{scheduleOwner?: string}} */ (
      JSON.parse(readFileSync(envsPath, 'utf8'))
    ).scheduleOwner;
    if (owner !== undefined && env.WS_ENV && env.WS_ENV !== owner) return { status: 'not-owner' };
  } catch { /* no environments config — enforcement off, proceed (test/bootstrap) */ }

  let head;
  try {
    head = git(root, ['rev-parse', 'HEAD']);
  } catch {
    return { status: 'no-git' };
  }

  const state = statePath();
  if (!existsSync(state)) {
    writeFile(state, head);
    return { status: 'initialized' }; // baseline only — no restart storm on rollout
  }
  const last = readFileSync(state, 'utf8').trim();
  if (last === head) return { status: 'unchanged' };

  /** @type {string[]} */
  let changed;
  let baselineUnknown = false;
  try {
    changed = git(root, ['diff', '--name-only', last, head]).split('\n').filter(Boolean);
  } catch {
    // Baseline commit no longer exists (history rewrite). We cannot know what
    // changed — restart conservatively, gated on the canonical trigger entries.
    baselineUnknown = true;
    changed = ['cli/util/scheduler.js', 'server/server.js', 'configs/jobs/jobs.json'];
  }
  const relevant = baselineUnknown ? changed : changed.filter(isTriggerPath);
  if (relevant.length === 0) {
    writeFile(state, head);
    return { status: 'no-relevant-changes' };
  }

  const failures = await checkFiles(root, relevant);
  writeFile(state, head); // advance either way — the FIX commit re-triggers once
  if (failures.length > 0) {
    // Loud, never silent: the push is refused, old running code stays up.
    await apiLog({
      area: 'scheduler',
      status: 'failed',
      agent: 'self-restart',
      message: `pulled change to restart-trigger paths REFUSED — syntax check failed, old code keeps running (no restart, no boot-loop): ${failures.join('; ')}`,
    });
    return { status: 'check-failed', failures };
  }

  const detail = `${relevant.join(', ')} @ ${last.slice(0, 7)}..${head.slice(0, 7)}${baselineUnknown ? ' (baseline unknown — conservative)' : ''}`;
  writeFile(markerPath(), JSON.stringify({ flaggedAt: Date.now(), detail }) + '\n');
  return { status: 'flagged', detail };
}

/** @returns {boolean} */
export function markerExists() {
  return existsSync(markerPath());
}

/**
 * Consume (read + delete) the restart marker. Null when absent.
 * @returns {{flaggedAt?: number, detail?: string}|null}
 */
export function consumeMarker() {
  const p = markerPath();
  if (!existsSync(p)) return null;
  /** @type {{flaggedAt?: number, detail?: string}} */
  let content = {};
  try {
    content = JSON.parse(readFileSync(p, 'utf8'));
  } catch { /* hand-touched marker — still a valid restart request */ }
  try {
    rmSync(p);
  } catch { /* already gone */ }
  return content;
}

/**
 * Scheduler boot: the code now running IS HEAD, so stamp the baseline (a change
 * that arrived via the entrypoint pull must not trigger a redundant restart).
 * Silent no-op when root is not a git repo (unit-test fixtures).
 * @param {string} root
 */
export function stampState(root) {
  try {
    writeFile(statePath(), git(root, ['rev-parse', 'HEAD']));
  } catch { /* not a git repo — nothing to baseline */ }
}
