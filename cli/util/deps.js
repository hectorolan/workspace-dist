// Dependency self-heal — zero-dependency by design (it's what installs them).
// npm workspaces install once at the repo root; a git pull can change the
// lockfile under a RUNNING system (bit us 2026-07-19: imapflow arrived via pull,
// node_modules predated it, the inbox tick failed). ensureDeps compares the
// lockfile to a marker written after the last successful install and re-runs
// `npm ci` when they differ. Called by the container entrypoint at boot and by
// `ws pull` after every pull that changed anything.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

/**
 * @param {string} root workspace dir
 * @returns {'ok'|'installed'|'failed'}
 */
export function ensureDeps(root) {
  const lock = path.join(root, 'package-lock.json');
  const marker = path.join(root, 'node_modules', '.ws-lock');
  if (!existsSync(lock)) return 'ok';
  const want = readFileSync(lock, 'utf8');
  if (existsSync(marker) && readFileSync(marker, 'utf8') === want) return 'ok';

  const r = spawnSync('npm', ['ci', '--ignore-scripts', '--no-audit', '--no-fund'], {
    cwd: root,
    stdio: 'inherit',
    shell: process.platform === 'win32', // npm is npm.cmd on Windows
  });
  if (r.status !== 0) return 'failed';
  writeFileSync(marker, want, 'utf8');
  return 'installed';
}
