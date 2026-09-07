// Skills upstream sync — the upstream checker for skills vendored from external
// GitHub repos (manifest: .claude/skills/sources.json).
//
// Contract (Hector 2026-07-28; plan `environment-setup-streamlining`, W4 / D2 / D6):
//   - TRIGGERED IN THE CONTROL PLANE, never on a station. The scheduled gh-workflow
//     .github/workflows/skills-upstream-sync.yml runs this pass, so no station has to
//     be powered on and no station is structurally special (the disposability
//     invariant: "if this machine died right now, what is lost?" — nothing).
//   - THE CRON SCHEDULE IS THE THROTTLE. A GitHub Actions runner is ephemeral, so the
//     <WS_DATA_DIR>/skills-sync/last-check stamp never survives a run and would make a
//     time throttle a silent no-op there. The stamp therefore throttles LOCAL/MANUAL
//     runs on a station only, and `--force` now means exactly one thing: ignore that
//     stamp. There is no environment gate left to bypass.
//   - NEVER auto-merged: on an upstream change this opens a PR from a fresh
//     branch `skills/<name>-<sha7>` titled "Agent: update for skill '<name>'".
//     Hector reviews and merges; every environment then picks the change up
//     through the normal 15-minute pull. The branch name pins the target sha,
//     so an unmerged update PR is never duplicated (branch-exists dedupe).
//   - ONE FUNCTIONALITY PER PR, SQUASH-MERGED (D6b): updateBranch() is one branch and
//     one PR per skill, so each update lands as a single commit and the
//     whole-document diff a human actually reads stays legible.
//   - VERIFIED BEFORE THE PR (D6c): agent-doctor runs against the refreshed clone —
//     skill frontmatter validity plus .claude/README.md index drift, the structural
//     break a human reading a markdown diff would miss, and the one check ci.yml never
//     ran. Skill PRs are opened with the default GITHUB_TOKEN and therefore trigger no
//     other gh-workflow (a deliberate accepted tradeoff, D6a — no PAT), so this is the
//     only automated check they get. A failure does NOT suppress the PR: it annotates
//     the body and the caller's exit code turns the run red. Suppressing it would push
//     a branch the branch-exists dedupe then treats as "already seen", silently
//     swallowing every future PR for that sha.
//   - The update happens in a throwaway clone of the workspace repo, never in
//     the live working tree — an interactive session is never disturbed.
//   - Local additions inside a vendored SKILL.md live between
//     `<!-- workspace-local:start -->` / `<!-- workspace-local:end -->` markers
//     and are re-applied after the files are replaced with upstream content.
//   - Never throws; failures degrade to summary notes + a line in
//     <WS_DATA_DIR>/skills-sync/skills-sync.log. No central-log writes (the runner has
//     no log-API access). The CALLER owns the exit code — see
//     cli/util-tools/skills-upstream-sync.js.
import path from 'node:path';
import os from 'node:os';
import {
  existsSync, readFileSync, writeFileSync, mkdirSync, rmSync, cpSync,
  readdirSync, appendFileSync, mkdtempSync, statSync, truncateSync,
} from 'node:fs';
import { execFileSync } from 'node:child_process';
import { workspaceDir, dataDir, stamp } from './clock.js';

/** Local/manual re-check window (the gh-workflow's cron is the real cadence). */
export const CHECK_INTERVAL_MS = 3 * 24 * 60 * 60 * 1000;
export const LOCAL_START = '<!-- workspace-local:start -->';
export const LOCAL_END = '<!-- workspace-local:end -->';
const LOCAL_BLOCK_RE = /<!-- workspace-local:start -->[\s\S]*?<!-- workspace-local:end -->/g;

/** @typedef {{repo: string, path: string, sha: string}} SkillSource */

/** @param {string} root @returns {string} */
export function manifestFile(root) {
  return path.join(root, '.claude', 'skills', 'sources.json');
}

/**
 * The vendored-skills manifest, or null when missing/unreadable/shapeless.
 * @param {string} root
 * @returns {Record<string, SkillSource>|null}
 */
export function readManifest(root) {
  let data;
  try {
    data = JSON.parse(readFileSync(manifestFile(root), 'utf8'));
  } catch {
    return null;
  }
  const skills = data?.skills;
  if (!skills || typeof skills !== 'object') return null;
  /** @type {Record<string, SkillSource>} */
  const out = {};
  for (const [name, e] of Object.entries(skills)) {
    if (e && typeof e.repo === 'string' && typeof e.path === 'string' && typeof e.sha === 'string') {
      out[name] = { repo: e.repo, path: e.path, sha: e.sha };
    }
  }
  return Object.keys(out).length ? out : null;
}

/**
 * Every `workspace-local` block (markers included) in a vendored SKILL.md.
 * @param {string} text
 * @returns {string[]}
 */
export function extractLocalBlocks(text) {
  return text.match(LOCAL_BLOCK_RE) || [];
}

/**
 * Re-append preserved local blocks to fresh upstream SKILL.md content.
 * @param {string} text @param {string[]} blocks
 * @returns {string}
 */
export function applyLocalBlocks(text, blocks) {
  if (!blocks.length) return text;
  return `${text.trimEnd()}\n\n${blocks.join('\n\n')}\n`;
}

/** @param {string} line */
function note(line) {
  const file = path.join(dataDir(), 'skills-sync', 'skills-sync.log');
  try {
    mkdirSync(path.dirname(file), { recursive: true });
    try {
      if (statSync(file).size > 256 * 1024) truncateSync(file, 0); // self-truncating
    } catch { /* no file yet */ }
    appendFileSync(file, `${stamp()} ${line}\n`);
  } catch { /* logging must never break the sync */ }
}

/** @param {string[]} args @returns {string} */
function ghExec(args) {
  return execFileSync('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 60000 });
}

/** @param {string} cwd @param {string[]} args @returns {string} */
function git(cwd, args) {
  return execFileSync('git', ['-C', cwd, ...args], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 180000,
  }).trim();
}

/**
 * Newest upstream commit sha touching the skill's path.
 * @param {(args: string[]) => string} gh @param {SkillSource} src
 * @returns {string}
 */
export function latestUpstreamSha(gh, src) {
  const rows = JSON.parse(gh(['api', `repos/${src.repo}/commits?path=${encodeURIComponent(src.path)}&per_page=1`]));
  const sha = Array.isArray(rows) ? rows[0]?.sha : undefined;
  if (typeof sha !== 'string' || !sha) throw new Error(`no commit sha for ${src.repo}/${src.path}`);
  return sha;
}

/**
 * Shallow sparse clone of the upstream repo; returns the subtree directory.
 * @param {SkillSource} src
 * @returns {string}
 */
function cloneUpstreamSubtree(src) {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'ws-skillsync-up-'));
  execFileSync('git', ['clone', '--depth', '1', '--filter=blob:none', '--sparse',
    `https://github.com/${src.repo}.git`, tmp],
  { stdio: ['ignore', 'pipe', 'pipe'], timeout: 180000 });
  git(tmp, ['sparse-checkout', 'set', src.path]);
  const dir = path.join(tmp, ...src.path.split('/'));
  if (!existsSync(path.join(dir, 'SKILL.md'))) {
    throw new Error(`upstream ${src.repo}/${src.path} has no SKILL.md`);
  }
  return dir;
}

/**
 * Replace <root>/.claude/skills/<name> with the upstream subtree, preserving
 * workspace-local SKILL.md blocks and a workspace-added LICENSE.txt (kept when
 * the upstream subtree ships no license file of its own).
 * @param {{root: string, name: string, upstreamDir: string}} p
 */
export function refreshSkillDir({ root, name, upstreamDir }) {
  const skillDir = path.join(root, '.claude', 'skills', name);
  const skillMd = path.join(skillDir, 'SKILL.md');
  const blocks = existsSync(skillMd) ? extractLocalBlocks(readFileSync(skillMd, 'utf8')) : [];
  const licenseFile = path.join(skillDir, 'LICENSE.txt');
  const license = existsSync(licenseFile) ? readFileSync(licenseFile, 'utf8') : null;
  rmSync(skillDir, { recursive: true, force: true });
  mkdirSync(skillDir, { recursive: true });
  cpSync(upstreamDir, skillDir, { recursive: true });
  if (license && !readdirSync(skillDir).some((f) => /^license/i.test(f))) {
    writeFileSync(licenseFile, license);
  }
  if (blocks.length) {
    writeFileSync(skillMd, applyLocalBlocks(readFileSync(skillMd, 'utf8'), blocks));
  }
  return { localBlocks: blocks.length };
}

/**
 * Vendor a NEW external skill into `<root>/.claude/skills/<name>` and pin it in
 * sources.json — the install counterpart of the refresh path above, so every
 * skill arrives the same way (allow-listed repo, path-scoped sha pin, upstream
 * license carried along). The repo MUST be a key of `external_skills_git` in
 * configs/environments.json: "no substitute sources" is enforced here, not by
 * the caller's judgement. Refuses to overwrite an existing entry (that is what
 * the sync's review PR is for).
 * @param {{root?: string, name: string, repo: string, path: string,
 *          gh?: (args: string[]) => string, clone?: (src: SkillSource) => string}} p
 * @returns {{name: string, repo: string, path: string, sha: string, files: string[]}}
 */
export function installSkill({ root, name, repo, path: subPath, gh = ghExec, clone = cloneUpstreamSubtree }) {
  const dir = root || workspaceDir();
  const allowed = allowedRepos(dir);
  if (allowed && !allowed.has(repo)) {
    throw new Error(`repo ${repo} is not in the configs/environments.json external_skills_git allow-list`);
  }
  const mf = manifestFile(dir);
  const manifest = JSON.parse(readFileSync(mf, 'utf8'));
  if (manifest.skills?.[name]) throw new Error(`skill '${name}' is already vendored — use the upstream sync to update it`);
  /** @type {SkillSource} */
  const src = { repo, path: subPath, sha: '' };
  const sha = latestUpstreamSha(gh, src);
  const upstreamDir = clone(src);          // throws when the path has no SKILL.md
  refreshSkillDir({ root: dir, name, upstreamDir });
  const skillDir = path.join(dir, '.claude', 'skills', name);
  // Upstream subtrees often carry no license of their own; vendor the repo-root
  // one so the copy in this repo states its terms (the jest-skill precedent).
  if (!readdirSync(skillDir).some((f) => /^license/i.test(f))) {
    try {
      const text = gh(['api', `repos/${repo}/contents/LICENSE`, '-H', 'Accept: application/vnd.github.raw']);
      if (text.trim()) writeFileSync(path.join(skillDir, 'LICENSE.txt'), text);
    } catch { /* no root license upstream — nothing to carry */ }
  }
  manifest.skills = Object.fromEntries(
    Object.entries({ ...manifest.skills, [name]: { repo, path: subPath, sha } }).sort(([a], [b]) => a.localeCompare(b))
  );
  writeFileSync(mf, `${JSON.stringify(manifest, null, 2)}\n`);
  return { name, repo, path: subPath, sha, files: readdirSync(skillDir).sort() };
}

/** @param {string} name @param {string} sha @returns {string} */
export const updateBranch = (name, sha) => `skills/${name}-${sha.slice(0, 7)}`;

/** @param {string} name @returns {string} */
export const prTitle = (name) => `Agent: update for skill '${name}'`;

/**
 * Structural verification of the refreshed clone (D6c): agent/skill frontmatter
 * validity and `.claude/README.md` index drift. Runs the clone's OWN copy of
 * cli/util-tools/agent-doctor.js — that tool imports node builtins only, so it needs
 * no `npm install` in the throwaway clone, and it resolves its root from its own file
 * location, so it checks the updated tree rather than this one.
 * @param {string} workDir @returns {{ok: boolean, output: string}}
 */
export function agentDoctor(workDir) {
  const tool = path.join(workDir, 'cli', 'util-tools', 'agent-doctor.js');
  try {
    const out = execFileSync(process.execPath, [tool], {
      cwd: workDir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 120000,
    });
    return { ok: true, output: String(out).trim() };
  } catch (e) {
    const err = /** @type {any} */ (e);
    const out = [err?.stdout, err?.stderr].filter(Boolean).join('\n').trim();
    return { ok: false, output: out || String(err?.message || e) };
  }
}

/** @param {string} text @param {number} max @returns {string} last `max` lines */
const tail = (text, max) => {
  const lines = String(text).split('\n');
  return lines.length <= max ? lines.join('\n') : lines.slice(-max).join('\n');
};

/**
 * Open the update PR from a throwaway clone of the workspace repo (the live
 * working tree is never touched). Branch-exists on origin = an update PR for
 * this exact upstream sha is already open (or was closed unmerged — either way
 * Hector has seen it) → dedupe.
 * `verify` runs against the refreshed clone before the push; a failure annotates the
 * PR body rather than suppressing the PR (see the contract note at the top).
 * @param {{root: string, name: string, src: SkillSource, newSha: string, clone: (src: SkillSource) => string, verify?: (workDir: string) => {ok: boolean, output: string}}} p
 * @returns {'opened'|'opened-unverified'|'exists'}
 */
function publishUpdatePR({ root, name, src, newSha, clone, verify = agentDoctor }) {
  const originUrl = git(root, ['remote', 'get-url', 'origin']);
  const branch = updateBranch(name, newSha);
  const work = mkdtempSync(path.join(os.tmpdir(), 'ws-skillsync-repo-'));
  execFileSync('git', ['clone', '--depth', '1', originUrl, work],
    { stdio: ['ignore', 'pipe', 'pipe'], timeout: 180000 });
  if (git(work, ['ls-remote', '--heads', 'origin', branch])) return 'exists';
  git(work, ['checkout', '-b', branch]);
  const { localBlocks } = refreshSkillDir({ root: work, name, upstreamDir: clone(src) });
  const mf = manifestFile(work);
  const manifest = JSON.parse(readFileSync(mf, 'utf8'));
  manifest.skills[name].sha = newSha;
  writeFileSync(mf, `${JSON.stringify(manifest, null, 2)}\n`);
  git(work, ['add', '-A']);
  git(work, ['commit', '-m', `chore(skills): bump ${name} to upstream ${newSha.slice(0, 7)}`]);
  const checked = verify(work);
  git(work, ['push', '-u', 'origin', branch]);
  const body = [
    ...(checked.ok ? [] : [
      '> [!WARNING]',
      '> `agent-doctor` FAILED on this refreshed tree — skill frontmatter or the',
      '> `.claude/README.md` index is broken by the upstream content. Do NOT merge',
      '> until it passes; the gh-workflow run for this PR is red.',
      '',
      '```',
      tail(checked.output, 40),
      '```',
      '',
    ]),
    `Upstream update for the vendored skill \`${name}\`, detected by the scheduled skills upstream sync (.github/workflows/skills-upstream-sync.yml). Never auto-merged — this PR is the review gate.`,
    '',
    `- Source: https://github.com/${src.repo}/tree/main/${src.path}`,
    `- Pinned: \`${src.sha}\` → \`${newSha}\``,
    `- Upstream diff: https://github.com/${src.repo}/compare/${src.sha}...${newSha}`,
    `- Workspace-local SKILL.md blocks re-applied: ${localBlocks}`,
    `- \`agent-doctor\`: ${checked.ok ? 'PASS' : 'FAIL (see above)'}`,
    '',
    'Merge convention: **squash** — one functionality per PR, so this skill update lands as a single commit.',
    'No other gh-workflow runs on this PR: it is opened with the default `GITHUB_TOKEN`, a deliberate accepted tradeoff (no PAT) — `agent-doctor` above is the automated check.',
    '',
    'Review the content diff before merging — skill text steers agents.',
  ].join('\n');
  execFileSync('gh', ['pr', 'create', '--title', prTitle(name), '--body', body,
    '--base', 'main', '--head', branch],
  { cwd: work, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 60000 });
  return checked.ok ? 'opened' : 'opened-unverified';
}

/** @param {string} root @returns {any|null} parsed configs/environments.json */
function envConfig(root) {
  try {
    return JSON.parse(readFileSync(path.join(root, 'configs', 'environments.json'), 'utf8'));
  } catch {
    return null;
  }
}

/**
 * The canonical upstream allow-list: `external_skills_git` keys in
 * configs/environments.json ("no substitute sources" — skills install/update
 * ONLY from these repos). Null when the registry section is absent.
 * @param {string} root @returns {Set<string>|null}
 */
export function allowedRepos(root) {
  const reg = envConfig(root)?.external_skills_git;
  if (!reg || typeof reg !== 'object') return null;
  return new Set(Object.keys(reg).filter((k) => !k.startsWith('_')));
}

/**
 * Local/manual re-check stamp. Deliberately per-machine and deliberately NOT the
 * production cadence: on the ephemeral gh-workflow runner this file never exists, so
 * every scheduled run is due and the cron IS the throttle.
 */
const stampFile = () => path.join(dataDir(), 'skills-sync', 'last-check');

/** @param {number} nowMs @returns {boolean} */
function throttled(nowMs) {
  try {
    const last = Number(readFileSync(stampFile(), 'utf8').trim());
    return Number.isFinite(last) && nowMs - last < CHECK_INTERVAL_MS;
  } catch {
    return false; // no stamp yet → due
  }
}

/** @param {number} nowMs */
function writeStamp(nowMs) {
  try {
    mkdirSync(path.dirname(stampFile()), { recursive: true });
    writeFileSync(stampFile(), String(nowMs));
  } catch { /* a lost stamp only means an earlier re-check */ }
}

/**
 * One pass: for every manifest skill, compare the upstream path-scoped sha with
 * the pin; on change, open the update PR (see publishUpdatePR). Returns a
 * one-line summary for the caller to print; NEVER throws.
 * `force` means one thing only: ignore the local re-check stamp (there is no
 * environment gate — every station and the gh-workflow run the identical pass).
 * @param {{root?: string, force?: boolean, now?: () => number, gh?: (args: string[]) => string, clone?: (src: SkillSource) => string, publish?: typeof publishUpdatePR, verify?: (workDir: string) => {ok: boolean, output: string}}} [deps]
 * @returns {Promise<string>}
 */
export async function syncSkills({
  root,
  force = false,
  now = Date.now,
  gh = ghExec,
  clone = cloneUpstreamSubtree,
  publish = publishUpdatePR,
  verify = agentDoctor,
} = {}) {
  const dir = root || workspaceDir();
  const manifest = readManifest(dir);
  if (!manifest) return 'skipped (no readable .claude/skills/sources.json)';
  if (!force && throttled(now())) return 'throttled (checked within the last 3 days)';
  /** @type {string[]} */
  const notes = [];
  const allowed = allowedRepos(dir);
  for (const [name, src] of Object.entries(manifest)) {
    try {
      if (allowed && !allowed.has(src.repo)) {
        throw new Error(`repo ${src.repo} not in the external_skills_git allow-list`);
      }
      const sha = latestUpstreamSha(gh, src);
      if (sha === src.sha) {
        notes.push(`${name} up-to-date`);
        continue;
      }
      const outcome = publish({ root: dir, name, src, newSha: sha, clone, verify });
      const range = `${src.sha.slice(0, 7)} → ${sha.slice(0, 7)}`;
      if (outcome === 'exists') notes.push(`${name} update PR already open (${sha.slice(0, 7)})`);
      else if (outcome === 'opened-unverified') notes.push(`${name} update PR opened but agent-doctor FAILED (${range})`);
      else notes.push(`${name} update PR opened (${range})`);
      note(`${name}: upstream ${sha} — PR ${outcome}`);
    } catch (e) {
      notes.push(`${name} check FAILED (${e instanceof Error ? e.message.split('\n')[0] : e})`);
      note(`${name}: check failed — ${e instanceof Error ? e.message.split('\n')[0] : e}`);
    }
  }
  writeStamp(now());
  return notes.join('; ');
}
