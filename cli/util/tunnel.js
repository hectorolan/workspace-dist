// SSH tunnel to the central log API — the encrypted transport for environments that
// are not the API's host (today: the Windows PC → Azure VM).
//
// Why: the API listens on plain HTTP. Reaching it across the public internet would put
// `X-Api-Key`, plan bodies and comment instructions on the wire in cleartext (audit
// finding WS-M5). SSH already exists between these two hosts, so the client talks to
// `http://127.0.0.1:<localPort>` and ssh carries the bytes.
//
// Config is per-environment and non-secret (`configs/environments.json` →
// `environments.<WS_ENV>.logApiTunnel`); an environment without that key (the container,
// which owns the API locally) no-ops everywhere in this module.
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { existsSync, readFileSync, writeFileSync, appendFileSync, mkdirSync, statSync, truncateSync } from 'node:fs';
import { spawn, execFileSync } from 'node:child_process';
import { workspaceDir, dataDir, stamp } from './clock.js';

/**
 * @typedef {{sshTarget: string, localPort: number, remotePort: number, identityFile?: string}} TunnelConfig
 */

/**
 * Tunnel config for THIS environment, or null when this environment has none
 * (the API host itself, or any environment that reaches the API directly).
 * @param {string} [root] workspace root (defaults to the resolved workspace dir)
 * @returns {TunnelConfig|null}
 */
export function tunnelConfig(root) {
  const dir = root || workspaceDir();
  const file = path.join(dir, 'configs', 'environments.json');
  const env = process.env.WS_ENV;
  if (!env || !existsSync(file)) return null;
  let cfg;
  try {
    cfg = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
  const t = cfg?.environments?.[env]?.logApiTunnel;
  if (!t || typeof t.sshTarget !== 'string' || !t.sshTarget) return null;
  return {
    sshTarget: t.sshTarget,
    localPort: Number(t.localPort) || 8790,
    remotePort: Number(t.remotePort) || Number(t.localPort) || 8790,
    identityFile: typeof t.identityFile === 'string' ? t.identityFile : undefined,
  };
}

/**
 * Is something accepting connections on the local tunnel port?
 * Used both as the liveness check and as the "another supervisor already owns this
 * port" lock — no pidfiles, no stale state.
 * @param {number} port
 * @param {number} [timeoutMs]
 * @returns {Promise<boolean>}
 */
export function portOpen(port, timeoutMs = 1500) {
  return new Promise((resolve) => {
    const sock = net.connect({ host: '127.0.0.1', port });
    const done = (/** @type {boolean} */ ok) => {
      sock.destroy();
      resolve(ok);
    };
    sock.setTimeout(timeoutMs);
    sock.once('connect', () => done(true));
    sock.once('timeout', () => done(false));
    sock.once('error', () => done(false));
  });
}

/** @returns {string} the ssh binary (Windows OpenSSH's absolute path when present) */
export function sshBinary() {
  const win = 'C:\\Windows\\System32\\OpenSSH\\ssh.exe';
  if (process.platform === 'win32' && existsSync(win)) return win;
  return 'ssh';
}

/**
 * ssh arguments for a port-forward-only session that dies (rather than hangs) when
 * the forward or the link is broken, so the supervisor can restart it.
 * @param {TunnelConfig} cfg
 * @returns {string[]}
 */
export function sshArgs(cfg) {
  const key = cfg.identityFile || path.join(os.homedir(), '.ssh', 'id_rsa');
  const args = [
    '-N', '-T',
    '-o', 'BatchMode=yes',
    '-o', 'ExitOnForwardFailure=yes',
    '-o', 'ServerAliveInterval=30',
    '-o', 'ServerAliveCountMax=3',
    '-o', 'ConnectTimeout=15',
    '-o', 'StrictHostKeyChecking=yes',
    '-L', `127.0.0.1:${cfg.localPort}:127.0.0.1:${cfg.remotePort}`,
  ];
  if (existsSync(key)) args.push('-i', key);
  args.push(cfg.sshTarget);
  return args;
}

/** @returns {string} supervisor log file (per-machine data dir, never git) */
export function tunnelLogFile() {
  return path.join(dataDir(), 'tunnel', 'log-api-tunnel.log');
}

/** @param {string} line */
function note(line) {
  const file = tunnelLogFile();
  try {
    mkdirSync(path.dirname(file), { recursive: true });
    // self-truncating: this file has no pruner of its own
    try {
      if (statSync(file).size > 256 * 1024) truncateSync(file, 0);
    } catch { /* no file yet */ }
    appendFileSync(file, `${stamp()} ${line}\n`);
  } catch { /* logging must never break the tunnel */ }
}

// --- respawn observability (backlog 48a) -----------------------------------------
// The supervisor used to respawn ssh with only a local note, so the central audit
// trail dead-ended on a failure line while the replacement forward served for hours
// (observed 2026-07-26). Now a RESPAWNED session that is confirmed serving writes ONE
// central `done` line (agent tunnel-watch, area tunnel — a scripted log-writer
// exception, CLAUDE.md "Logging convention"), rate-limited so a flapping tunnel
// cannot spam the DB; the local note file still records every event. Boot's first
// session is not a respawn and never logs.

/**
 * @param {{cfg: TunnelConfig, minMs?: number, confirmDelayMs?: number,
 *   probe?: typeof portOpen,
 *   logFn?: (entry: {area: string, status: string, message: string, agent: string}) => Promise<{ok: true, line: string}|{ok: false, fallback: string}>,
 *   noteFn?: (line: string) => void}} opts
 * @returns {{onSpawn: (child: {exitCode: number|null}) => Promise<string>|null}}
 */
export function makeRespawnReporter({ cfg, minMs, confirmDelayMs = 5000, probe = portOpen, logFn, noteFn = note }) {
  const windowMs = minMs ?? (Number(process.env.WS_TUNNEL_RESPAWN_LOG_MIN_MS) || 30 * 60000);
  let sessions = 0;
  let lastLoggedAt = 0;
  /** @param {{exitCode: number|null}} child @param {number} session */
  const report = async (child, session) => {
    if (child.exitCode !== null) return 'died'; // the replacement is already gone — not a recovery
    if (!(await probe(cfg.localPort))) return 'not-serving';
    if (Date.now() - lastLoggedAt < windowMs) {
      noteFn('respawned ssh serving — central tunnel-watch line rate-limited (flap guard)');
      return 'rate-limited';
    }
    lastLoggedAt = Date.now();
    try {
      const send = logFn || (await import('./apiclient.js')).log;
      const r = await send({
        area: 'tunnel',
        status: 'done',
        agent: 'tunnel-watch',
        message: `log-api tunnel respawned — replacement ssh forward serving on 127.0.0.1:${cfg.localPort} → ${cfg.sshTarget} (session ${session} of this supervisor)`,
      });
      noteFn(r.ok ? 'respawn logged centrally (tunnel-watch)' : `respawn line queued to offline fallback (${r.fallback})`);
      return 'logged';
    } catch (e) {
      noteFn(`respawn central log failed — ${e instanceof Error ? e.message : e}`); // never breaks the tunnel
      return 'log-failed';
    }
  };
  return {
    onSpawn(child) {
      const session = ++sessions;
      if (session < 2) return null; // boot session: silent by design
      return new Promise((resolve) => {
        const t = setTimeout(() => resolve(report(child, session)), confirmDelayMs);
        if (typeof t === 'object') t.unref();
      });
    },
  };
}

// --- connect-failure diagnosis (CEO decision 2026-08-26) ---------------------------
// A rotated home IP drops port 22 at the Azure NSG, and the supervisor's answer used to
// be blind respawns for hours with nothing anywhere naming the cause (lived 2026-08-25).
// When a session dies of a NETWORK-path failure, ask the shared check whether the NSG ssh
// rule still admits this station, and put the answer — with the exact `az` command the CEO
// runs — in the supervisor log; a PROVEN mismatch also writes ONE central `blocked` line
// (agent tunnel-watch, area tunnel — the same scripted log-writer exception), rate-limited
// machine-wide by a stamp file so several supervisors cannot each file it. Never a
// speculative line: any verdict but FAIL stays local. Nothing here ever runs the `az`
// update, and nothing here can throw into the supervisor loop.

/** @returns {string} the rate-limit stamp for the central diagnosis line (data dir, never git) */
export function diagStampFile() {
  return path.join(dataDir(), 'tunnel', 'nsg-diagnosis.json');
}

/**
 * Did this ssh session die because the network path was closed (the NSG symptom), rather
 * than because of auth, a host key, or a link that had been serving fine?
 * @param {string} detail the supervisor's `exit <code> — <stderr>` string
 * @param {number} ranMs how long the session lived
 * @returns {boolean}
 */
export function looksLikeConnectFailure(detail, ranMs) {
  const text = String(detail || '');
  // Auth / host-key failures reach the host: the allowlist is fine, something else is not.
  if (/Permission denied|publickey|Host key verification failed|REMOTE HOST IDENTIFICATION/i.test(text)) return false;
  const networkish = /connect to host|Connection timed out|Operation timed out|timed out|Connection refused|No route to host|Network is unreachable|banner exchange|spawn-failed/i.test(text);
  if (!networkish) return false;
  // A forward that served for a minute or more and then dropped is a link blip, not a
  // closed door — diagnosing every such drop would spam the log during flaky wifi.
  return ranMs < 60000;
}

/**
 * Diagnose a connect failure and report it. Seams are for tests; production passes `{cfg}`.
 * @param {{
 *   cfg: TunnelConfig,
 *   check?: () => Promise<{level: string, detail: string, data?: Record<string, unknown>}>,
 *   noteFn?: (line: string) => void,
 *   logFn?: (entry: {area: string, status: string, message: string, agent: string}) => Promise<{ok: true, line: string}|{ok: false, fallback: string}>,
 *   minMs?: number,
 *   now?: () => number,
 *   readStamp?: () => number,
 *   writeStamp?: (at: number) => void,
 * }} opts
 * @returns {Promise<'no-cause'|'rate-limited'|'logged'|'log-failed'|'check-failed'>}
 */
export async function diagnoseConnectFailure({
  cfg,
  check,
  noteFn = note,
  logFn,
  minMs,
  now = Date.now,
  readStamp = () => {
    try {
      return Number(JSON.parse(readFileSync(diagStampFile(), 'utf8')).at) || 0;
    } catch {
      return 0;
    }
  },
  writeStamp = (at) => {
    try {
      mkdirSync(path.dirname(diagStampFile()), { recursive: true });
      writeFileSync(diagStampFile(), JSON.stringify({ at }, null, 2));
    } catch { /* a stamp that cannot be written only costs an extra line later */ }
  },
}) {
  /** @type {{level: string, detail: string, data?: Record<string, unknown>}} */
  let verdict;
  try {
    const run = check || (async () => (await import('./nsgcheck.js')).nsgAllowlistCheck({ force: true }));
    verdict = await run();
  } catch (e) {
    noteFn(`connect-failure diagnosis errored — ${e instanceof Error ? e.message : e}`);
    return 'check-failed';
  }
  noteFn(`connect-failure diagnosis: ${verdict.level} ${verdict.detail}`);
  if (verdict.level !== 'FAIL') return 'no-cause';
  const windowMs = minMs ?? (Number(process.env.WS_TUNNEL_DIAG_MIN_MS) || 60 * 60000);
  if (now() - readStamp() < windowMs) {
    noteFn('central tunnel-watch diagnosis line rate-limited (same cause, inside the window)');
    return 'rate-limited';
  }
  writeStamp(now());
  try {
    const send = logFn || (await import('./apiclient.js')).log;
    const r = await send({
      area: 'tunnel',
      status: 'blocked',
      agent: 'tunnel-watch',
      message: `log-api tunnel cannot connect to ${cfg.sshTarget} — ${verdict.detail}`,
    });
    noteFn(r.ok ? 'diagnosis logged centrally (tunnel-watch)' : `diagnosis line queued to offline fallback (${r.fallback})`);
    return 'logged';
  } catch (e) {
    noteFn(`diagnosis central log failed — ${e instanceof Error ? e.message : e}`);
    return 'log-failed';
  }
}

/**
 * Foreground supervisor: keep the ssh forward alive forever, with backoff.
 * Stands by (does not fight) when another supervisor already holds the port, and retires
 * itself if that stays true — one live supervisor per machine, no idle pile-up.
 * @param {string} [root]
 * @returns {Promise<number>} exit code (returns only with no config, or when retiring)
 */
export async function superviseTunnel(root) {
  const cfg = tunnelConfig(root);
  if (!cfg) {
    console.log('log-api-tunnel: no logApiTunnel config for this environment — nothing to do');
    return 0;
  }
  const bin = sshBinary();
  note(`supervisor start → ${cfg.sshTarget} (local ${cfg.localPort} → remote ${cfg.remotePort})`);
  const reporter = makeRespawnReporter({ cfg });
  let backoff = 5000;
  let standby = 0;
  for (;;) {
    if (await portOpen(cfg.localPort)) {
      // Someone else's tunnel owns the port. Stand by briefly in case it is a leftover
      // that dies in a moment, then retire — a redundant supervisor must not idle
      // forever (the next `ws pull` tick starts a fresh one whenever the port goes quiet).
      if (++standby > 10) {
        note('supervisor retiring — another tunnel owns the port');
        return 0;
      }
      await new Promise((r) => setTimeout(r, 30000));
      continue;
    }
    standby = 0;
    const started = Date.now();
    const code = await new Promise((resolve) => {
      const child = spawn(bin, sshArgs(cfg), { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
      void reporter.onSpawn(child); // respawns confirmed serving → one central line (48a)
      let err = '';
      child.stderr?.on('data', (d) => { err += String(d).slice(0, 500); });
      child.once('error', (e) => resolve(`spawn-failed: ${e.message}`));
      child.once('exit', (c) => resolve(`exit ${c}${err ? ` — ${err.trim()}` : ''}`));
    });
    const ranMs = Date.now() - started;
    note(`ssh ended after ${Math.round(ranMs / 1000)}s: ${code}`);
    if (looksLikeConnectFailure(code, ranMs)) {
      // Name the cause instead of respawning blindly. Awaited so the verdict lands in the
      // log before the next attempt; wrapped so a diagnosis can never kill the supervisor.
      try {
        await diagnoseConnectFailure({ cfg });
      } catch { /* diagnosis is advisory — the tunnel keeps trying regardless */ }
    }
    backoff = ranMs > 60000 ? 5000 : Math.min(backoff * 2, 60000);
    await new Promise((r) => setTimeout(r, backoff));
  }
}

/**
 * Start the supervisor as a process that OUTLIVES this one and does not hang off it.
 *
 * On Windows the caller is usually the `Claude-WorkspacePull` scheduled task, and Task
 * Scheduler puts a task's processes in a job object: a plain `spawn(detached)` child stays
 * in that job, which makes every later run of the task report return code 3221226505
 * (0xC0000409) even though the work succeeded — i.e. it destroys the "LastTaskResult 0 =
 * success" signal the PC's only task is diagnosed with (observed live 2026-07-25). Creating
 * the process through WMI hands the job to the WMI service instead, so the supervisor is
 * nobody's child and the task stays green. Everywhere else a detached spawn is fine.
 * @param {string} tool absolute path to log-api-tunnel.js
 * @returns {boolean} started
 */
function startSupervisor(tool) {
  if (process.platform === 'win32') {
    const cmdline = [process.execPath, tool, '--supervise'].map((a) => `"${a}"`).join(' ');
    try {
      execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command',
        `$r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{CommandLine='${cmdline.replace(/'/g, "''")}'}; exit $r.ReturnValue`,
      ], { stdio: 'ignore', timeout: 60000, windowsHide: true });
      return true;
    } catch (e) {
      note(`ensure: WMI start failed (${e instanceof Error ? e.message : e}) — falling back to a detached child`);
    }
  }
  try {
    const child = spawn(process.execPath, [tool, '--supervise'], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    });
    child.unref();
    return true;
  } catch (e) {
    note(`ensure: spawn failed — ${e instanceof Error ? e.message : e}`);
    return false;
  }
}

/**
 * Make sure the tunnel is up: no-op when it already is, otherwise start a detached,
 * windowless supervisor that outlives this process. Called from `ws pull` (the PC's
 * 15-minute housekeeping tick), so a dead tunnel heals itself without anyone logging in.
 * @param {string} [root]
 * @returns {Promise<'no-config'|'up'|'started'|'failed'>}
 */
export async function ensureTunnel(root) {
  const cfg = tunnelConfig(root);
  if (!cfg) return 'no-config';
  if (await portOpen(cfg.localPort)) return 'up';
  const dir = root || workspaceDir();
  const tool = path.join(dir, 'cli', 'util-tools', 'log-api-tunnel.js');
  if (!existsSync(tool)) return 'failed';
  if (!startSupervisor(tool)) return 'failed';
  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setTimeout(r, 500));
    if (await portOpen(cfg.localPort)) {
      note('ensure: tunnel up');
      return 'started';
    }
  }
  note('ensure: tunnel did not come up within 10s');
  return 'failed';
}
