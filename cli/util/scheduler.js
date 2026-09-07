// The container's clock — `ws scheduler` replaces supercronic as PID 1 (Phase 2).
// Reads jobs/jobs.json (schedule as data), arms one croner Cron per job with the
// configured timezone, refuses to overlap a job with its own previous run, and
// plays the @reboot role: jobs with catch-up configured run once at boot with the
// args appended (the command itself is idempotent, e.g. ws run-job daily-digest
// --if-missing). Catch-up is config-driven per entry (backlog 1, 2026-07-26): a
// job with a `runJob` block defaults to `--if-missing` catch-up — that contract
// is idempotent by construction (output-file keyed, window from its own cron) —
// unless it sets `catchUp: false` or explicit `catchUpArgs` (which win verbatim).
// The daily-digest-v2 incident: a newly enabled job without catchUpArgs missed
// its slot on restart and did not self-heal; now the default heals it.
// One path (Hector 2026-07-19): no fallback scheduler exists; rollback = git revert.
//
// Self-restart (backlog 1): `ws pull` flags relevant pulled changes via a marker
// in WS_DATA_DIR (cli/util/selfrestart.js). Between fires — never mid-job — the
// scheduler notices it, drains running jobs, logs ONE line (scripted-writer
// exception like pr-watch, agent `self-restart`), and exits 0; Docker's
// `restart: unless-stopped` + the entrypoint pull bring it back on current code.
//
// Log API supervision (backlog 3): on the API host the scheduler also keeps
// server/server.js alive as a managed child — probe/adopt first (old baked
// entrypoints still background server/start.sh), restart on unexpected exit with
// capped backoff, kill on shutdown alongside the jobs (superviseLogApi below).
import { readFileSync, existsSync, mkdirSync, openSync, closeSync } from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { markerExists, consumeMarker, stampState } from './selfrestart.js';
import { tunnelConfig, portOpen } from './tunnel.js';
import { dataDir } from './clock.js';

// --- log API supervision (backlog 3) ----------------------------------------------
// server/server.js used to be backgrounded ONCE by the container entrypoint: a crash
// left /summary dark until a container recreate while every client silently fell
// back to the offline md. The scheduler now supervises it as a managed child —
// WITHOUT requiring an image rebuild: the currently-deployed baked entrypoint still
// backgrounds server/start.sh, so this supervisor PROBES the API port first and
// ADOPTS an already-listening server (no double bind, no fight), spawns its own
// child only when the port is free, restarts it on unexpected exit with capped
// backoff, and kills it on shutdown / self-restart drain alongside the job children.
// Once a server has been seen serving, each confirmed replacement writes ONE `done`
// line (agent api-watch, area log-api — a scripted log-writer exception, CLAUDE.md
// "Logging convention"), rate-limited so a crash-looping server cannot spam the DB
// (console/docker logs keep every event). The first-ever spawn (rebuilt entrypoint,
// nothing ever served) is a normal boot and logs nothing.

/**
 * @param {{root: string, log?: (line: string) => void, env?: NodeJS.ProcessEnv,
 *   probe?: (port: number) => Promise<boolean>,
 *   spawnServer?: () => Promise<import('node:child_process').ChildProcess>,
 *   apiLog?: (entry: {area: string, status: string, message: string, agent: string}) => Promise<unknown>,
 *   pollMs?: number, graceMs?: number, minLogMs?: number, backoffMs?: number, maxBackoffMs?: number}} opts
 * @returns {{stop: () => void}|null} null when this environment must not supervise the API
 */
export function superviseLogApi({
  root,
  log = console.log,
  env = process.env,
  probe,
  spawnServer,
  apiLog,
  pollMs = Number(process.env.WS_API_POLL_MS) || 15000,
  graceMs = Number(process.env.WS_API_BOOT_GRACE_MS) || 20000,
  minLogMs = Number(process.env.WS_API_LOG_MIN_MS) || 15 * 60000,
  backoffMs = 1000,
  maxBackoffMs = 60000,
}) {
  // WS_API_SERVER: test seam (points the supervisor at a stub script); production
  // always resolves the real server. Gates: explicit skip (entrypoint semantics),
  // an environment that reaches the API over a tunnel (it is not the host), or no
  // server code at all.
  const serverJs = env.WS_API_SERVER || path.join(root, 'server', 'server.js');
  if (env.SKIP_LOG_API === '1') {
    log('[scheduler] log-api: supervision off (SKIP_LOG_API=1)');
    return null;
  }
  if (tunnelConfig(root)) {
    log('[scheduler] log-api: supervision off (this environment reaches the API over a tunnel — not the API host)');
    return null;
  }
  if (!existsSync(serverJs)) {
    log(`[scheduler] log-api: supervision off (no server at ${serverJs})`);
    return null;
  }
  const port = Number(env.LOG_API_PORT || 8790);
  const probePort = probe || portOpen;

  const defaultSpawn = async () => {
    // node:sqlite is unflagged on the supported runtime — the same probe
    // server/start.sh runs, done in-process (same node binary as the child), so an
    // older node that still needs the flag gets it instead of failing to boot.
    /** @type {string[]} */
    let flags = [];
    try {
      await import('node:sqlite');
    } catch {
      flags = ['--experimental-sqlite'];
    }
    // Same output file the old entrypoint used: <dirname(DB)>/api/log-api.log.
    const dbPath = env.LOG_DB_PATH || path.join(dataDir(), 'logs.db');
    const outDir = path.join(path.dirname(dbPath), 'api');
    mkdirSync(outDir, { recursive: true });
    const fd = openSync(path.join(outDir, 'log-api.log'), 'a');
    const child = spawn(process.execPath, [...flags, serverJs], {
      cwd: path.dirname(serverJs),
      stdio: ['ignore', fd, fd],
      env: /** @type {NodeJS.ProcessEnv} */ (env),
    });
    closeSync(fd);
    return child;
  };
  const startServer = spawnServer || defaultSpawn;

  let stopped = false;
  /** @type {import('node:child_process').ChildProcess|null} */
  let child = null;
  let served = false; // some server (adopted or ours) has been seen serving
  let adopted = false; // the current server is externally owned (old entrypoint's start.sh)
  let lastKind = ''; // what the last serving server was, for the recovery message
  let backoff = backoffMs;
  let notBefore = 0; // earliest next spawn attempt (backoff gate)
  let lastLineAt = 0;
  const sleep = (/** @type {number} */ ms) => new Promise((r) => setTimeout(r, ms));
  const bootAt = Date.now();

  void (async () => {
    while (!stopped) {
      if (child) {
        await sleep(pollMs);
        continue;
      }
      if (await probePort(port)) {
        if (!adopted) {
          adopted = true;
          lastKind = 'adopted';
          log(`[scheduler] log-api: adopted — something already serves :${port} (entrypoint-started or external); a replacement starts if it goes away`);
        }
        served = true;
        await sleep(pollMs);
        continue;
      }
      adopted = false;
      // Boot race: the old baked entrypoint backgrounds start.sh moments before the
      // scheduler starts — give that copy time to bind instead of fighting it.
      if (!served && Date.now() - bootAt < graceMs) {
        await sleep(Math.min(500, pollMs));
        continue;
      }
      const wait = notBefore - Date.now();
      if (wait > 0) {
        await sleep(Math.min(wait, pollMs));
        continue;
      }
      const recovery = served; // replacing a server that used to serve = audit-worthy
      const source = lastKind === 'adopted' ? 'the previously-adopted server went away' : 'an unexpected exit';
      log(`[scheduler] log-api: ${recovery ? 'restarting' : 'starting'} server (${serverJs}) on :${port}`);
      const startedAt = Date.now();
      /** @type {import('node:child_process').ChildProcess} */
      let c;
      try {
        c = await startServer();
      } catch (e) {
        log(`[scheduler] log-api: spawn failed — ${e instanceof Error ? e.message : e}`);
        backoff = Math.min(backoff * 2, maxBackoffMs);
        notBefore = Date.now() + backoff;
        continue;
      }
      child = c;
      let ended = false;
      /** @param {string} label */
      const endChild = (label) => {
        if (ended) return;
        ended = true;
        if (child === c) child = null;
        const ranMs = Date.now() - startedAt;
        backoff = ranMs > 60000 ? backoffMs : Math.min(backoff * 2, maxBackoffMs);
        notBefore = Date.now() + backoff;
        if (!stopped) log(`[scheduler] log-api: ${label} after ${ranMs}ms — next attempt in ${backoff}ms`);
      };
      c.once('error', (e) => endChild(`server error (${e.message})`));
      c.once('exit', (code) => endChild(`server exited (${code})`));
      // Confirm the new server actually serves before calling it a recovery.
      let up = false;
      for (let i = 0; i < 20 && !stopped; i++) {
        await sleep(Math.min(500, pollMs));
        if (child !== c) break; // died already — the exit handler armed the backoff
        if (await probePort(port)) {
          up = true;
          break;
        }
      }
      if (!up) continue;
      served = true;
      lastKind = 'child';
      log(`[scheduler] log-api: serving on :${port}`);
      if (!recovery) continue; // first-ever spawn: normal boot, no line
      if (Date.now() - lastLineAt < minLogMs) {
        log('[scheduler] log-api: recovery line rate-limited (flap guard)');
        continue;
      }
      lastLineAt = Date.now();
      try {
        const send = apiLog || (await import('./apiclient.js')).log;
        await send({
          area: 'log-api',
          status: 'done',
          agent: 'api-watch',
          message: `log API restarted by the scheduler after ${source} — serving again on :${port}`,
        });
      } catch { /* console + docker logs still record the restart */ }
    }
  })();

  return {
    stop() {
      stopped = true;
      if (child) {
        log('[scheduler] log-api: stopping supervised server');
        child.kill();
        child = null;
      }
    },
  };
}

/** @typedef {{name: string, cron: string, run: string|string[], catchUpArgs?: string[], catchUp?: boolean, runJob?: Record<string, unknown>, retries?: number, retryDelayMin?: number, disabled?: boolean}} JobSpec */

/**
 * @param {{root: string, configPath: string, log?: (line: string) => void}} opts
 * @returns {Promise<never>} runs until the process is signalled
 */
export async function runScheduler({ root, configPath, log = console.log }) {
  let Cron;
  try {
    ({ Cron } = await import('croner'));
  } catch {
    throw new Error('croner is not installed — run `npm ci --ignore-scripts` at the workspace root.');
  }

  /** @type {{timezone?: string, jobs?: JobSpec[]}} */
  const cfg = JSON.parse(readFileSync(configPath, 'utf8'));
  const timezone = cfg.timezone || 'UTC';
  const jobs = cfg.jobs || [];

  // --- schedule ownership (configs/environments.json, Hector 2026-07-19) ---------
  // Exactly ONE environment runs scheduled jobs. The owner is config in git, each
  // environment identifies itself via WS_ENV, and the check re-reads the file
  // before every fire — flipping the owner + pushing migrates the job host within
  // one pull cycle, and double-running is structurally impossible, not just a rule.
  const envsPath = process.env.WS_ENVS_CONFIG || path.join(root, 'configs', 'environments.json');
  const readOwner = () => {
    try {
      return /** @type {{scheduleOwner?: string}} */ (JSON.parse(readFileSync(envsPath, 'utf8'))).scheduleOwner;
    } catch {
      return undefined;
    }
  };
  const self = process.env.WS_ENV;
  const owner = readOwner();
  if (owner === undefined) {
    log('[scheduler] WARN: no environments config — schedule-ownership enforcement off');
  } else if (!self) {
    throw new Error(`WS_ENV is not set, but ${envsPath} declares scheduleOwner='${owner}' — set WS_ENV for this environment (see the config's identifiesAs entries)`);
  } else if (self !== owner) {
    throw new Error(`this environment (WS_ENV=${self}) is not the schedule owner ('${owner}') — refusing to arm jobs (one live job host only)`);
  } else {
    log(`[scheduler] schedule owner: ${owner} — this environment, armed to run`);
  }

  // --- self-restart plumbing (backlog 1) -----------------------------------------
  // A marker present at BOOT is stale by definition: the entrypoint pull already
  // ran, so we are booting on current code — clear it, or a leftover would loop.
  if (consumeMarker()) log('[scheduler] stale restart marker cleared at boot (already on current code)');
  // The code now running IS HEAD — baseline the pull-side diff so a change that
  // arrived via the entrypoint pull never triggers a redundant restart.
  stampState(root);
  let stopping = false;

  // --- log API supervision (backlog 3, see superviseLogApi above) ----------------
  // Only the schedule owner reaches this point, and the gates inside (tunnel
  // config, SKIP_LOG_API, missing server) keep every non-host environment out.
  const apiSup = superviseLogApi({ root, log });

  /** @type {Map<string, import('node:child_process').ChildProcess>} */
  const running = new Map();

  /** @param {string|string[]} run @param {string[]} extra */
  const argvFor = (run, extra) => {
    const tokens = Array.isArray(run) ? [...run] : run.split(/\s+/);
    // "ws <cmd>" resolves to this workspace's CLI with the current node binary.
    if (tokens[0] === 'ws') tokens.splice(0, 1, process.execPath, path.join(root, 'cli', 'ws.js'));
    return [...tokens, ...extra];
  };

  /** @param {JobSpec} job @param {string[]} [extra] @param {number} [attempt] */
  const runJob = (job, extra = [], attempt = 1) =>
    new Promise((resolve) => {
      // Restart pending: no NEW fires while draining — the restart happens
      // between fires, never mid-job; the missed slot self-heals via catch-up
      // on the post-restart boot (the whole point of backlog 1).
      if (stopping) {
        log(`[scheduler] ${job.name}: skipped — restart pending (draining)`);
        resolve(-1);
        return;
      }
      // Re-check ownership on every fire: the config file is pulled fresh every
      // ≤15 min, so a pushed owner flip silences this host within one cycle.
      if (owner !== undefined) {
        const nowOwner = readOwner();
        if (nowOwner !== undefined && nowOwner !== self) {
          log(`[scheduler] ${job.name}: skipped — schedule owner is now '${nowOwner}', this environment is '${self}'`);
          resolve(-1);
          return;
        }
      }
      if (running.has(job.name)) {
        log(`[scheduler] ${job.name}: previous run still active — skipped`);
        resolve(-1);
        return;
      }
      const argv = argvFor(job.run, extra);
      log(`[scheduler] ${job.name}: start ${argv.join(' ')}${attempt > 1 ? ` (attempt ${attempt})` : ''}`);
      const child = spawn(argv[0], argv.slice(1), { cwd: root, stdio: 'inherit', env: process.env });
      running.set(job.name, child);
      /** @param {number} code */
      const finish = (code) => {
        running.delete(job.name);
        log(`[scheduler] ${job.name}: exit ${code}`);
        // Declarative retries (moved here from the old run-job.sh loop): a failed
        // run reschedules itself, up to job.retries extra attempts.
        if (code !== 0 && job.retries && attempt <= job.retries) {
          const delayMin = job.retryDelayMin ?? 10;
          log(`[scheduler] ${job.name}: retry ${attempt}/${job.retries} in ${delayMin} min`);
          setTimeout(() => void runJob(job, extra, attempt + 1), delayMin * 60000);
        }
        resolve(code);
      };
      child.on('error', (e) => {
        log(`[scheduler] ${job.name}: spawn failed — ${e.message}`);
        finish(-1);
      });
      child.on('exit', (code) => finish(code ?? -1));
    });

  for (const job of jobs) {
    // disabled: true = staged, never scheduled (ws run-job still runs it manually)
    if (job.disabled) {
      log(`[scheduler] ${job.name}: disabled — not armed`);
      continue;
    }
    const cron = new Cron(job.cron, { timezone }, () => {
      void runJob(job);
    });
    log(`[scheduler] armed ${job.name} (${job.cron} ${timezone})`);
    // A pattern with no future occurrence is a config bug — say so loudly.
    if (!cron.nextRun()) log(`[scheduler] WARN: ${job.name} will never fire with pattern '${job.cron}'`);
  }

  // Keep the event loop alive unconditionally. Without this, a config whose jobs
  // all have no scheduled timer lets Node exit silently — the one clock must
  // never evaporate; it dies only by signal or crash.
  setInterval(() => {}, 2 ** 31 - 1);

  // Restart-marker poll (backlog 1): between fires, never mid-job. On a marker,
  // stop accepting new fires, drain, log ONE line (scripted-writer exception,
  // agent `self-restart`), exit 0 — the container restart policy + entrypoint
  // pull bring the scheduler back on current code.
  let exiting = false;
  const pollMs = Number(process.env.WS_RESTART_POLL_MS) || 20000;
  setInterval(() => {
    if (!stopping) {
      if (!markerExists()) return;
      stopping = true;
      log(`[scheduler] restart requested by ws pull — draining ${running.size} running job(s), no new fires`);
    }
    if (running.size > 0 || exiting) return;
    exiting = true;
    void (async () => {
      const reason = consumeMarker()?.detail || 'pulled change to restart-trigger paths';
      log(`[scheduler] restarting to load pulled changes: ${reason}`);
      try {
        const { log: apiLog } = await import('./apiclient.js');
        await apiLog({
          area: 'scheduler',
          status: 'done',
          agent: 'self-restart',
          message: `scheduler drained and restarted to load pulled changes (${reason}) — container restart policy brings it back on current code`,
        });
      } catch { /* console + docker logs still record the restart */ }
      apiSup?.stop(); // the restarted container brings the API back (adopt or spawn)
      process.exit(0);
    })();
  }, pollMs);

  // Boot catch-up: explicit catchUpArgs win; a runJob-block job defaults to
  // --if-missing (idempotent by contract) unless catchUp: false opts out.
  /** @param {JobSpec} job */
  const catchUpArgsFor = (job) =>
    job.catchUpArgs ?? (job.runJob && job.catchUp !== false ? ['--if-missing'] : undefined);
  if (process.env.SKIP_CATCHUP !== '1') {
    for (const job of jobs) {
      const cu = catchUpArgsFor(job);
      if (cu && !job.disabled) void runJob(job, cu);
    }
  }

  /** @param {string} sig */
  const shutdown = (sig) => {
    log(`[scheduler] ${sig} — stopping ${running.size} running job(s)`);
    for (const child of running.values()) child.kill();
    apiSup?.stop(); // the supervised log API dies with the scheduler, like the jobs
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  return new Promise(() => {}); // the container lives exactly as long as we do
}
