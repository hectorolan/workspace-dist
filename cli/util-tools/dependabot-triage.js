// dependabot-triage — the RED half of Dependabot automation on the workspace repo
// (the GREEN half is ci.yml's automerge job; the CEO's 2026-08-01 carve-out covers
// exactly one bot, and the guards below make touching anything else impossible).
// Behaviour spec: SYSTEM.md "Dependabot red-PR triage". Faces:
//
//   node cli/util-tools/dependabot-triage.js            the scheduled trigger: `gh` lists
//       open Dependabot PRs with failing checks (free) and the provider seam
//       (../util/agent.js) is imported LAZILY only when at least one exists — so no red
//       PR ⇒ the token seam is never even loaded ⇒ zero tokens (cli/README.md accounting).
//   node cli/util-tools/dependabot-triage.js --scan     print the red list, never dispatch
//   node cli/util-tools/dependabot-triage.js --merge <n> [--wait <min>]
//       THE only merge path for jr_implementer_github_dependabot — the four guards as mechanical checks:
//       author must be dependabot[bot] (exit 2, loud, NO comment — never touch a foreign
//       PR); a diff touching any test file refuses + comments (exit 3 — a suite weakened
//       to green has fixed nothing); majors never auto-merge (exit 4, comments — ci.yml's
//       rule kept true here; an unparseable bump counts as major, conservative); merge only
//       when every check is green, optionally polling --wait minutes (exit 5); and the
//       merge is ALWAYS `gh pr merge --squash`.
//
// Runs `gh` with cwd = the workspace root, so the repo is inferred from origin — no
// hardcoded owner/repo. Tests: cli/test/dependabot-triage.test.js (TP-deptriage-*).
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/** @param {string[]} args @returns {string} stdout */
function ghExec(args) {
  // WS_TRIAGE_GH_EXEC: test seam like agent.js's 'exec' provider — "node stub.js"
  // serving canned gh JSON, so the CLI entry can be exercised end-to-end with no
  // network (the idle-path token proof). Never set in production.
  const shim = (process.env.WS_TRIAGE_GH_EXEC || '').split(/\s+/).filter(Boolean);
  const [cmd, ...pre] = shim.length ? shim : ['gh'];
  return execFileSync(cmd, [...pre, ...args], {
    encoding: 'utf8',
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 120000,
  });
}

/** @param {string[]} args @returns {string} stdout */
function gitExec(args) {
  return execFileSync('git', args, {
    encoding: 'utf8', cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], timeout: 60000,
  });
}

/**
 * The branch the LIVE working tree sits on, and whether it has uncommitted work.
 * `''` / `true` on any git failure — the pessimistic reading, so an unknown state
 * is never "restored" by guessing.
 * @param {(args: string[]) => string} [git]
 */
export function treeState(git = gitExec) {
  /** @type {{branch: string, dirty: boolean}} */
  const s = { branch: '', dirty: true };
  try { s.branch = git(['rev-parse', '--abbrev-ref', 'HEAD']).trim(); } catch { return s; }
  try { s.dirty = git(['status', '--porcelain']).trim() !== ''; } catch { s.dirty = true; }
  return s;
}

/**
 * Put the working tree back on the branch it started on.
 *
 * WHY THIS EXISTS: jr_implementer_github_dependabot fixes a PR with `gh pr checkout <n>`, which
 * switches the LIVE working tree — and nothing switched it back. Observed
 * 2026-08-01: this clone was left on `dependabot/npm_and_yarn/types/node-26.1.2`,
 * a branch cut days earlier, so every file read afterwards was stale. On the
 * container that is far worse than confusing: the scheduled job runs there, so
 * the live host would sit on a Dependabot branch and the next `ws sync` would
 * commit to it instead of main.
 *
 * A DIRTY tree is never force-switched: the agent may have died mid-fix, and
 * discarding or dragging that work across branches is worse than staying put.
 * Say so loudly and leave it for a human.
 * @param {{branch: string, dirty: boolean}} before
 * @param {{git?: (args: string[]) => string, out?: (line: string) => void}} [deps]
 * @returns {'unchanged'|'restored'|'left-dirty'|'failed'|'unknown'}
 */
export function restoreTree(before, { git = gitExec, out = console.log } = {}) {
  if (!before.branch) return 'unknown';
  const now = treeState(git);
  if (now.branch === before.branch) return 'unchanged';
  if (now.dirty) {
    out(`dependabot-triage: WARNING — working tree left on '${now.branch}' with uncommitted changes `
      + `(expected '${before.branch}'). NOT switching back: that would discard or drag the work across branches. `
      + 'Resolve by hand before the next sync — a sync from here would commit to the wrong branch.');
    return 'left-dirty';
  }
  try {
    git(['checkout', before.branch]);
    out(`dependabot-triage: working tree restored to '${before.branch}' (was left on '${now.branch}')`);
    return 'restored';
  } catch (e) {
    out(`dependabot-triage: WARNING — could not restore '${before.branch}' from '${now.branch}' `
      + `(${e instanceof Error ? e.message : e}) — fix by hand before the next sync`);
    return 'failed';
  }
}

/** The one author this machinery may touch. @param {string|undefined} login */
export const isDependabot = (login) => /^(app\/)?dependabot(\[bot\])?$/i.test(login || '');

/** Test-file shapes across the repos: test/tests/__tests__ dirs, *.test.* / *.spec.* files. */
const TEST_FILE_RE = /(^|\/)(tests?|__tests__)\/|\.(test|spec)\.[cm]?[jt]sx?$/i;

/** @param {string[]} files changed paths @returns {string[]} the test files among them */
export const touchesTests = (files) => files.filter((f) => TEST_FILE_RE.test(f.replace(/\\/g, '/')));

/**
 * Classify a Dependabot bump from its PR title's `from X to Y`. Anything that does
 * not parse (grouped updates, reworded titles) is 'unknown' and the merge guard
 * treats it exactly like a major — conservative by design.
 * @param {string} title
 * @returns {'major'|'minor-or-patch'|'unknown'}
 */
export function bumpKind(title) {
  const matches = [...title.matchAll(/\bfrom\s+v?(\d+)(?:\.\d+)*(?:[-+][\w.]+)?\s+to\s+v?(\d+)(?:\.\d+)*(?:[-+][\w.]+)?\b/gi)];
  if (matches.length === 0) return 'unknown';
  for (const m of matches) if (Number(m[1]) !== Number(m[2])) return 'major';
  return 'minor-or-patch';
}

/**
 * Verdict over a PR's statusCheckRollup (CheckRun and legacy StatusContext rows).
 * 'unknown' (no checks reported) is never treated as green by callers.
 * @param {unknown} rollup
 * @returns {'green'|'red'|'pending'|'unknown'}
 */
export function checksVerdict(rollup) {
  if (!Array.isArray(rollup) || rollup.length === 0) return 'unknown';
  let pending = false;
  for (const c of /** @type {Array<Record<string, unknown>>} */ (rollup)) {
    if (c.state !== undefined) {
      // StatusContext: state is SUCCESS / FAILURE / ERROR / PENDING / EXPECTED
      const s = String(c.state).toUpperCase();
      if (s === 'FAILURE' || s === 'ERROR') return 'red';
      if (s === 'PENDING' || s === 'EXPECTED') pending = true;
      continue;
    }
    // CheckRun: status (QUEUED/IN_PROGRESS/COMPLETED) + conclusion
    const st = String(c.status || '').toUpperCase();
    if (st && st !== 'COMPLETED') {
      pending = true;
      continue;
    }
    const con = String(c.conclusion || '').toUpperCase();
    if (['FAILURE', 'TIMED_OUT', 'STARTUP_FAILURE', 'CANCELLED', 'ACTION_REQUIRED'].includes(con)) return 'red';
  }
  return pending ? 'pending' : 'green';
}

/** @typedef {{number: number, title: string, url: string}} RedPR */

/**
 * Open Dependabot PRs on this repo whose checks are red. Pending/green PRs are left
 * to CI's own automerge path; the author is re-checked here (never trust the query
 * filter alone).
 * @param {(args: string[]) => string} [gh]
 * @returns {RedPR[]}
 */
export function scanRedPRs(gh = ghExec) {
  const rows = /** @type {Array<{number: number, title: string, url: string, author?: {login?: string}, statusCheckRollup?: unknown}>} */ (
    JSON.parse(gh(['pr', 'list', '--author', 'app/dependabot', '--state', 'open',
      '--json', 'number,title,url,author,statusCheckRollup']))
  );
  return rows
    .filter((pr) => isDependabot(pr.author?.login) && checksVerdict(pr.statusCheckRollup) === 'red')
    .map((pr) => ({ number: pr.number, title: pr.title, url: pr.url }));
}

/** @param {RedPR[]} red */
function buildPrompt(red) {
  const list = red.map((p) => `- PR #${p.number} "${p.title}" — ${p.url}`).join('\n');
  return `Use the jr_implementer_github_dependabot subagent to triage and fix these red Dependabot PRs on the workspace repo, one at a time:\n${list}\n`
    + 'Follow .claude/agents/jr_implementer_github_dependabot.md exactly: diagnose the CI failure, fix it WITHOUT touching any test file '
    + '(if a correct fix would require changing a test file, stop and comment on the PR instead), push to the PR branch, '
    + 'and merge ONLY via `node cli/util-tools/dependabot-triage.js --merge <n> --wait 30` — never `gh pr merge` directly. '
    + 'Majors and every refusal get a PR comment and are left for the CEO. Log one `ws log` line per PR handled.';
}

/**
 * The scheduled trigger: scan, and dispatch one jr_implementer_github_dependabot session only when a
 * red Dependabot PR exists. The default dispatch lazy-imports the provider seam so
 * the idle path never loads the one module that can spend tokens.
 * @param {{gh?: (args: string[]) => string, git?: (args: string[]) => string, dispatch?: (prompt: string) => Promise<{code: number, output: string}>, out?: (line: string) => void}} [deps]
 * @returns {Promise<{dispatched: boolean, red: RedPR[], code?: number, reason?: string}>}
 */
export async function triage({ gh = ghExec, git: git2 = gitExec, dispatch, out = console.log } = {}) {
  /** @type {RedPR[]} */
  let red;
  try {
    red = scanRedPRs(gh);
  } catch (e) {
    out(`dependabot-triage: scan failed (${e instanceof Error ? e.message : e}) — gh missing, offline, or unauthenticated`);
    return { dispatched: false, red: [], reason: 'scan-failed' };
  }
  if (red.length === 0) {
    out('dependabot-triage: idle — no red Dependabot PRs; no agent dispatched (zero tokens)');
    return { dispatched: false, red };
  }
  out(`dependabot-triage: ${red.length} red Dependabot PR(s) — dispatching jr_implementer_github_dependabot: ${red.map((p) => `#${p.number}`).join(', ')}`);
  const run = dispatch || (async (/** @type {string} */ prompt) => {
    const { runAgent } = await import('../util/agent.js'); // lazy: the idle path never reaches the token seam
    const tools = process.env.TRIAGE_ALLOWED_TOOLS || 'Read,Write,Edit,Glob,Grep,Bash,Task';
    return runAgent(prompt, { tools, env: { AGENT_ALLOWED_TOOLS: tools } });
  });
  // The agent switches the live tree with `gh pr checkout`. Restoration is the
  // TOOL's job, in a finally, so it happens even when the session crashes,
  // times out, or is killed mid-fix — never a step the model has to remember.
  const before = treeState(git2);
  /** @type {{code: number, output: string}} */
  let result;
  try {
    result = await run(buildPrompt(red));
  } finally {
    restoreTree(before, { git: git2, out });
  }
  const { code, output } = result;
  out(output);
  out(`dependabot-triage: agent session exit ${code}`);
  return { dispatched: true, red, code };
}

/** @typedef {{merged: boolean, reason?: 'author'|'tests'|'major'|'not-green'|'not-open'|'view-failed'|'merge-failed', detail?: string}} MergeResult */

/**
 * The guarded merge — the ONLY way this machinery merges anything. Every guard is a
 * mechanical check on live `gh pr view` data, in this order: open state → author →
 * test files in the diff → major bump → checks green (with optional polling). The
 * merge itself is always `--squash`.
 * @param {number|string} number
 * @param {{gh?: (args: string[]) => string, waitMinutes?: number, pollMs?: number, sleep?: (ms: number) => Promise<void>, out?: (line: string) => void}} [opts]
 * @returns {Promise<MergeResult>}
 */
export async function guardMerge(number, {
  gh = ghExec,
  waitMinutes = 0,
  pollMs = Number(process.env.WS_TRIAGE_POLL_MS) || 60000,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  out = console.log,
} = {}) {
  const n = String(number);
  const view = () => /** @type {{state?: string, title?: string, author?: {login?: string}, files?: Array<{path: string}>, statusCheckRollup?: unknown}} */ (
    JSON.parse(gh(['pr', 'view', n, '--json', 'number,title,url,state,author,files,statusCheckRollup']))
  );
  /** @param {string} body */
  const comment = (body) => {
    try {
      gh(['pr', 'comment', n, '--body', body]);
    } catch (e) {
      out(`dependabot-triage: PR comment failed (${e instanceof Error ? e.message : e})`);
    }
  };
  /** @param {MergeResult['reason']} reason @param {string} detail @returns {MergeResult} */
  const refuse = (reason, detail) => {
    out(`dependabot-triage: REFUSED (${reason} guard) — PR #${n}: ${detail}`);
    return { merged: false, reason, detail };
  };

  /** @type {ReturnType<typeof view>} */
  let pr;
  try {
    pr = view();
  } catch (e) {
    return refuse('view-failed', `gh pr view failed (${e instanceof Error ? e.message : e})`);
  }
  if (pr.state !== 'OPEN') return refuse('not-open', `state is ${pr.state} — nothing to merge`);
  if (!isDependabot(pr.author?.login)) {
    // Loud, no comment: this machinery must never touch (or even talk on) a foreign PR.
    return refuse('author', `author '${pr.author?.login}' is not dependabot[bot] — this machinery merges Dependabot PRs ONLY`);
  }
  const touched = touchesTests((pr.files || []).map((f) => f.path));
  if (touched.length > 0) {
    comment(`Automated triage stopped: this branch's diff touches test file(s) — ${touched.join(', ')} — and a suite weakened to green has fixed nothing. Not merged; awaiting human review.`);
    return refuse('tests', `diff touches test file(s): ${touched.join(', ')}`);
  }
  const kind = bumpKind(pr.title || '');
  if (kind !== 'minor-or-patch') {
    const why = kind === 'major' ? 'this is a major version bump' : 'the bump type could not be determined from the title (treated as major)';
    comment(`Automated triage: ${why} — majors never auto-merge; a green suite proves compatibility, not behavior. Awaiting human review and merge.`);
    return refuse('major', why);
  }
  let verdict = checksVerdict(pr.statusCheckRollup);
  const deadline = Date.now() + waitMinutes * 60000;
  while (verdict === 'pending' && Date.now() < deadline) {
    await sleep(pollMs);
    try {
      pr = view();
    } catch (e) {
      return refuse('view-failed', `gh pr view failed while polling (${e instanceof Error ? e.message : e})`);
    }
    verdict = checksVerdict(pr.statusCheckRollup);
  }
  if (verdict !== 'green') {
    return refuse('not-green', `checks are ${verdict} — merge happens only on a proven-green branch, never on the assumption a fix worked`);
  }
  try {
    gh(['pr', 'merge', n, '--squash']);
  } catch (e) {
    return refuse('merge-failed', `gh pr merge --squash failed (${e instanceof Error ? e.message : e})`);
  }
  out(`dependabot-triage: PR #${n} squash-merged (author, test-file, major, and green guards all passed)`);
  return { merged: true };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const args = process.argv.slice(2);
  if (args[0] === '--merge') {
    const n = args[1];
    if (!n || !/^\d+$/.test(n)) {
      console.error('usage: dependabot-triage.js --merge <pr-number> [--wait <minutes>]');
      process.exit(1);
    }
    const wi = args.indexOf('--wait');
    const waitMinutes = wi >= 0 ? Number(args[wi + 1]) || 0 : 0;
    const codes = { author: 2, tests: 3, major: 4, 'not-green': 5, 'not-open': 6, 'view-failed': 6, 'merge-failed': 6 };
    void guardMerge(n, { waitMinutes }).then((r) => {
      process.exit(r.merged ? 0 : codes[/** @type {keyof typeof codes} */ (r.reason)] || 1);
    });
  } else if (args[0] === '--scan') {
    try {
      const red = scanRedPRs();
      console.log(red.length === 0
        ? 'dependabot-triage: no red Dependabot PRs'
        : red.map((p) => `RED PR #${p.number} "${p.title}" — ${p.url}`).join('\n'));
    } catch (e) {
      console.error(`dependabot-triage: scan failed (${e instanceof Error ? e.message : e})`);
      process.exit(1);
    }
  } else {
    void triage().then((r) => process.exit(r.reason === 'scan-failed' ? 1 : 0));
  }
}
