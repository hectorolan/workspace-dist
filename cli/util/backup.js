// Daily disaster-recovery dump of the logging DB to GitHub (port of server/backup.sh).
// Dumps the DB as plain SQL text into the workspace-backups repo and pushes; git
// history is the retention. Recovery: entrypoint restores a fresh container from
// this repo, or by hand: node server/restore.js logs.sql
import { execFileSync, execSync } from 'node:child_process';
import { existsSync, writeFileSync, readFileSync } from 'node:fs';
import path from 'node:path';
import * as api from './apiclient.js';
import { pruneRepo } from './prune.js';
import { today } from './clock.js';

/** @returns {Promise<number>} */
export async function backup() {
  const ws = api.workspaceDir();
  const sources = path.dirname(ws);
  const backupDir = path.join(sources, 'workspace-backups');
  // No code default (2026-07-20): env override, else the non-sensitive instance
  // config in configs/environments.json — a missing value fails loudly below.
  let backupUrl = process.env.BACKUP_REPO_URL || '';
  if (!backupUrl) {
    try {
      backupUrl = JSON.parse(readFileSync(path.join(ws, 'configs', 'environments.json'), 'utf8')).backupRepoUrl || '';
    } catch { /* fail below */ }
  }
  const DATE = today();

  /** @param {string} msg */
  const fail = async (msg) => {
    await api.log({ area: 'backup', status: 'failed', message: msg, agent: 'runner' });
    return 1;
  };
  /** @param {string} dir @param {string[]} args */
  const git = (dir, args) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

  if (!backupUrl) return fail('no backup repo configured: set BACKUP_REPO_URL or backupRepoUrl in configs/environments.json');

  if (!existsSync(path.join(backupDir, '.git'))) {
    try {
      execFileSync('git', ['clone', backupUrl, backupDir], { stdio: 'ignore' });
    } catch {
      return fail(`clone of ${backupUrl} failed`);
    }
  }
  try { git(backupDir, ['pull', '--rebase']); } catch { return fail('git pull failed in workspace-backups'); }

  // node:sqlite is unflagged on the supported runtime; probe like start.sh does so an
  // older node on someone's PATH still dumps instead of failing.
  let flags = '';
  try { execSync(`"${process.execPath}" -e "require('node:sqlite')"`, { stdio: 'ignore' }); } catch { flags = '--experimental-sqlite'; }
  try {
    const sql = execFileSync(process.execPath, [...(flags ? [flags] : []), path.join(ws, 'server', 'dump.js')], {
      encoding: 'utf8',
      maxBuffer: 512 * 1024 * 1024,
    });
    writeFileSync(path.join(backupDir, 'logs.sql'), sql, 'utf8');
  } catch {
    return fail('dump.js failed');
  }

  try {
    git(backupDir, ['add', 'logs.sql']);
    try {
      git(backupDir, ['diff', '--cached', '--quiet']);
      // nothing changed — no commit, no log line (same as the bash version)
    } catch {
      git(backupDir, ['commit', '-m', `backup: logs ${DATE}`]);
      git(backupDir, ['push']);
      await api.log({ area: 'backup', status: 'done', message: `logs.sql pushed to workspace-backups (${DATE})`, agent: 'runner' });
    }
  } catch {
    return fail('git commit/push failed in workspace-backups');
  }

  // Safety net: rotate the data-dir working dirs even if a run hook missed it.
  pruneRepo();
  return 0;
}
