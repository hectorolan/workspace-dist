// Git mechanics shared by the ws CLI and forged tools — the one git client
// (the "ws is the one client" rule, generalized to lib/).
import { execFileSync } from 'node:child_process';

/**
 * @param {string} dir
 * @param {string[]} args
 * @returns {string}
 */
function git(dir, args) {
  return execFileSync('git', ['-C', dir, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

/** Top-level area of a repo-relative path for the sweep heuristic. @param {string} f */
const area = (f) => (f.includes('/') ? f.slice(0, f.indexOf('/')) : '(root)');

/**
 * Dirty paths NOT fully staged right now: worktree-modified tracked files and
 * untracked files (`git status --porcelain` lines whose worktree column is set).
 * @param {string} dir
 * @returns {string[]}
 */
function unstagedPaths(dir) {
  // NOT via git() — its .trim() would eat the leading space of a first-line
  // " M file" porcelain entry and misread its staged column.
  const out = execFileSync('git', ['-C', dir, 'status', '--porcelain'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (!out) return [];
  return out
    .split('\n')
    .filter((l) => l.length > 3 && l[1] !== ' ') // XY path — worktree column set ('??', ' M', 'MM', ...)
    .map((l) => {
      const p = l.slice(3);
      const arrow = p.indexOf(' -> '); // rename lines: old -> new
      return arrow >= 0 ? p.slice(arrow + 4) : p;
    });
}

/**
 * The ONE git call for workspace changes: pull → stage → commit → push.
 * AI sessions produce content; this owns git.
 *
 * Default (no paths): whole-tree sync, but the returned `staged` list and a
 * non-null `warning` (when the commit spans more than one top-level area) make
 * concurrent-session sweeps visible (backlog 32: f1804b1, d4c6366). Never blocks.
 * With `paths`: stages/commits ONLY those pathspecs; everything else dirty is
 * left untouched and returned in `leftBehind` so nothing is silently swept.
 * A pathspec matching nothing throws (step 'stage') — typo protection.
 *
 * `preflight` is the seam the ci-guard hangs on (backlog 58): it is called once,
 * synchronously, with the staged list, AFTER staging and BEFORE commit+push.
 * Returning `{ok:false}` aborts with status 'refused' — the changes stay staged
 * in the working tree, so nothing is lost and the caller (never this module) is
 * responsible for the audit line. This module stays pure git.
 * @param {string} dir
 * @param {string} message conventional commit message
 * @param {{paths?: string[], preflight?: (staged: string[]) => {ok: boolean}}} [opts]
 * @returns {{status: 'clean'|'pushed'|'refused', staged: string[], leftBehind: string[], warning: string|null}}
 * @throws {Error} with .step = 'pull'|'stage'|'commit'|'push' when that git step fails
 */
export function syncWorkspace(dir, message, { paths, preflight } = {}) {
  /** @param {'pull'|'stage'|'commit'|'push'} step @param {() => string} fn */
  const step = (step, fn) => {
    try {
      return fn();
    } catch (e) {
      const detail = step === 'stage' && e instanceof Error && 'stderr' in e ? `: ${String(e.stderr).trim()}` : '';
      const err = new Error(`git ${step} failed${detail} — resolve manually`);
      // @ts-ignore attach the failing step for the CLI's exit message
      err.step = step;
      throw err;
    }
  };
  const scoped = Array.isArray(paths) && paths.length > 0;
  step('pull', () => git(dir, ['pull', '--rebase', '--autostash']));
  if (scoped) {
    // -A within each pathspec so deletions inside the scope are staged too;
    // a pathspec that matches nothing makes git add fail → loud 'stage' error.
    step('stage', () => git(dir, ['add', '-A', '--', .../** @type {string[]} */ (paths)]));
  } else {
    git(dir, ['add', '-A']);
  }
  const staged = git(dir, ['diff', '--cached', '--name-only']).split('\n').filter(Boolean);
  const leftBehind = scoped ? unstagedPaths(dir) : [];
  if (staged.length === 0) return { status: 'clean', staged, leftBehind, warning: null };
  const areas = [...new Set(staged.map(area))];
  const warning = !scoped && areas.length > 1
    ? `ws sync: WARNING — this whole-tree commit spans multiple areas (${areas.join(', ')}); ` +
      'a concurrent session\'s in-progress files may have been swept in (f1804b1/d4c6366) — scope with --paths next time'
    : null;
  if (preflight && preflight(staged).ok === false) {
    return { status: 'refused', staged, leftBehind, warning };
  }
  step('commit', () => git(dir, ['commit', '-m', message]));
  step('push', () => git(dir, ['push']));
  return { status: 'pushed', staged, leftBehind, warning };
}

/**
 * The runners' push: pull --rebase --autostash (non-fatal), stage the given
 * paths, commit, push. Never throws — a failed push must not fail a delivered
 * job (port of the run-job/run-inbox git tail).
 * @param {string} dir
 * @param {string[]} paths
 * @param {string} message
 * @returns {'clean'|'pushed'|'push-failed'}
 */
export function commitAndPush(dir, paths, message) {
  try { git(dir, ['pull', '--rebase', '--autostash']); } catch { /* non-fatal */ }
  for (const p of paths) {
    try { git(dir, ['add', p]); } catch { /* path may not exist yet */ }
  }
  try {
    git(dir, ['diff', '--cached', '--quiet']);
    return 'clean';
  } catch { /* staged changes exist */ }
  try {
    git(dir, ['commit', '-m', message]);
    git(dir, ['push']);
    return 'pushed';
  } catch {
    return 'push-failed';
  }
}

/**
 * Pull the repo at dir when origin/main is ahead — the freshness net.
 * Quiet no-op when there is no repo or no network (never throws for those),
 * --rebase --autostash so it is safe alongside an interactive session with
 * local edits.
 * @param {string} dir
 * @returns {'no-git'|'offline'|'up-to-date'|'pulled'|'pull-failed'}
 */
export function pullIfBehind(dir) {
  try {
    git(dir, ['rev-parse', '--git-dir']);
  } catch {
    return 'no-git';
  }
  try {
    git(dir, ['fetch', '-q', 'origin', 'main']);
  } catch {
    return 'offline';
  }
  try {
    const local = git(dir, ['rev-parse', 'HEAD']);
    const remote = git(dir, ['rev-parse', 'origin/main']);
    if (local === remote) return 'up-to-date';
    git(dir, ['pull', '--rebase', '--autostash', '-q']);
    return 'pulled';
  } catch {
    return 'pull-failed';
  }
}
