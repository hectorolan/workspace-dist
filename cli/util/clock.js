// The one time source for every script — calendar dates, hour-of-day, and log
// stamps, always in the SCHEDULE timezone (configs/jobs/jobs.json, the one
// clock), never raw UTC. Born from the 2026-07-20 digest incident: runjob mixed
// toISOString() (UTC) with getHours() (host-local), so an evening boot catch-up
// composed and emailed "tomorrow's" digest. Dependency-free (node:fs/path/os
// only) so apiclient stays standalone on a fresh clone.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

/** The workspace clone this process should treat as home (config, sync target). */
export function workspaceDir() {
  return process.env.WORKSPACE_DIR || path.join(os.homedir(), 'sources', 'workspace');
}

/**
 * The per-machine data directory — ALL runtime/offline state that is NOT in git:
 * the log DB, the `ws log` offline fallback, inbox working artifacts, runner run
 * logs, and job outputs. Default = the directory holding LOG_DB_PATH (i.e.
 * ~/sources/data, already outside every git tree on the VM); WS_DATA_DIR overrides.
 * One definition every client shares — the workspace `logs/` folder is retired.
 */
export function dataDir() {
  if (process.env.WS_DATA_DIR) return process.env.WS_DATA_DIR;
  if (process.env.LOG_DB_PATH) return path.dirname(process.env.LOG_DB_PATH);
  return path.join(os.homedir(), 'sources', 'data');
}

/** Schedule timezone from configs/jobs/jobs.json; undefined (host timezone) when unreadable. */
export function scheduleTimezone() {
  try {
    const cfg = JSON.parse(readFileSync(path.join(workspaceDir(), 'configs', 'jobs', 'jobs.json'), 'utf8'));
    return cfg.timezone || undefined;
  } catch {
    return undefined;
  }
}

/** @param {Intl.DateTimeFormatOptions} opts */
const fmt = (opts) => new Intl.DateTimeFormat('en-CA', { timeZone: scheduleTimezone(), ...opts }).format(new Date());

/** Calendar date YYYY-MM-DD in the schedule timezone. */
export function today() {
  return fmt({ year: 'numeric', month: '2-digit', day: '2-digit' });
}

/** Hour of day 0–23 in the schedule timezone. */
export function hourNow() {
  return Number(fmt({ hour: '2-digit', hourCycle: 'h23' }));
}

/** Day of week 0 (Sunday) – 6 (Saturday) in the schedule timezone. */
export function dowNow() {
  const wd = new Intl.DateTimeFormat('en-US', { timeZone: scheduleTimezone(), weekday: 'short' })
    .format(new Date());
  return ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(wd);
}

/** 'YYYY-MM-DD HH:mm:ss' in the schedule timezone — run-log line stamps. */
export function stamp() {
  return `${today()} ${fmt({ hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' })}`;
}
