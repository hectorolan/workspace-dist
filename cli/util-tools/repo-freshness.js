// Repo-freshness report: is each local checkout safe to use as evidence?
//
// Born of the rule-of-two (2026-08-15): two dispatches in two days briefed agents
// from a stale working tree — `git fetch` updates refs, NOT files, so a checkout
// parked on an old branch reads as current code unless someone checks. This tool
// is that check, one command at session start: for the workspace repo and every
// active project repo (configs/environments.json `activeProjectRepos`, siblings
// under sources/), report the checked-out branch, dirty state, and drift from
// origin/main. CLAUDE.md's fetch rule owns the WHY; this tool only measures.
//
// Usage: node cli/util-tools/repo-freshness.js [--no-fetch] [--strict]
//   --no-fetch  skip `git fetch origin` (offline; drift is judged against stale refs)
//   --strict    exit 1 if any repo is not FRESH (for scripted preflights)
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { workspaceDir } from '../util/clock.js';

/**
 * Run git in a repo, returning trimmed stdout or null on failure — callers turn
 * null into a finding, never a throw (a broken repo is a report line, not a crash).
 * @param {string} dir @param {string[]} args @returns {string|null}
 */
function git(dir, args) {
  try {
    return execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  } catch {
    return null;
  }
}

/**
 * Measure one repo. Pure measurement — no writes, no checkout changes.
 * @param {string} name @param {string} dir @param {{fetch: boolean}} opts
 * @returns {{name: string, verdict: 'FRESH'|'STALE'|'ABSENT'|'ERROR', detail: string}}
 */
export function measureRepo(name, dir, opts) {
  if (!existsSync(path.join(dir, '.git'))) return { name, verdict: 'ABSENT', detail: `no git repo at ${dir}` };
  if (opts.fetch && git(dir, ['fetch', 'origin', '--quiet']) === null)
    return { name, verdict: 'ERROR', detail: 'git fetch origin failed (offline? auth?) — drift below would be judged against stale refs, so none is reported' };

  const branch = git(dir, ['rev-parse', '--abbrev-ref', 'HEAD']);
  const porcelain = git(dir, ['status', '--porcelain']);
  const counts = git(dir, ['rev-list', '--left-right', '--count', 'origin/main...HEAD']);
  if (branch === null || porcelain === null || counts === null)
    return { name, verdict: 'ERROR', detail: 'git probe failed inside the repo' };

  const dirty = porcelain === '' ? 0 : porcelain.split('\n').length;
  const [behind, ahead] = counts.split(/\s+/).map(Number);
  /** @type {string[]} */
  const problems = [];
  if (branch !== 'main') problems.push(`on branch ${branch}`);
  if (behind > 0) problems.push(`behind origin/main by ${behind}`);
  if (ahead > 0) problems.push(`ahead of origin/main by ${ahead}`);
  if (dirty > 0) problems.push(`${dirty} dirty file(s)`);

  return problems.length
    ? { name, verdict: 'STALE', detail: `${problems.join(', ')} — read evidence from origin/main, not this tree` }
    : { name, verdict: 'FRESH', detail: `main @ ${git(dir, ['rev-parse', '--short', 'HEAD'])}, clean, in sync with origin/main` };
}

/**
 * The repo roster: workspace itself plus activeProjectRepos as siblings under
 * sources/. Config read failures degrade to workspace-only, reported as a note.
 * @returns {{repos: {name: string, dir: string}[], note: string|null}}
 */
export function roster() {
  const ws = workspaceDir();
  const sources = path.dirname(ws);
  const repos = [{ name: 'workspace', dir: ws }];
  try {
    const cfg = JSON.parse(readFileSync(path.join(ws, 'configs', 'environments.json'), 'utf8'));
    const active = Array.isArray(cfg.activeProjectRepos) ? cfg.activeProjectRepos.map(String) : [];
    for (const name of active) repos.push({ name, dir: path.join(sources, name) });
    return { repos, note: null };
  } catch {
    return { repos, note: 'environments.json unreadable — project repos not checked' };
  }
}

const argv = process.argv.slice(2);
const opts = { fetch: !argv.includes('--no-fetch') };
const { repos, note } = roster();
const results = repos.map((r) => measureRepo(r.name, r.dir, opts));
for (const r of results) console.log(`${r.verdict.padEnd(6)} ${r.name.padEnd(12)} ${r.detail}`);
if (note) console.log(`NOTE   ${note}`);
if (argv.includes('--strict') && results.some((r) => r.verdict !== 'FRESH')) process.exit(1);
