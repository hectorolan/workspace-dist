// Plan-scoped temp-tests — the reaper (backlog 60, Hector's decisions 2026-07-31).
//
// WHY: tests written purely to prove ONE test-plan's change should not live in
// the suite forever. The judgement happens at AUTHORING time, while context is
// freshest: the author tags the test `@plan:<slug>` plus either `@promote`
// (guards behaviour that could regress — kept and untagged when the plan
// closes, graduating into the permanent suite) or `@throwaway` (one-time proof
// — deleted when the plan closes). Closure and cleanup stay fully scripted,
// never agent-decided (CLAUDE.md: test-plans close by script) — the tag carries
// the decision, this module only executes it.
//
// TIMING (the (a) problem): plan closure happens AFTER a push has landed
// (util/planclose.js inside `ws sync`), so deleting files there would strand
// uncommitted deletions in the working tree. The reaper instead runs STATELESS
// and IDEMPOTENT, PRE-commit, on the next `ws sync`: for every tag whose plan
// is now done/archived, delete or untag. The plan status IS the state — no
// bookkeeping file, and the sweep can run any number of times.
//
// BASELINE (the (b) problem, the main design risk): `compareSuite`
// (util/baseline.js) reports STATE REGRESSED when a covered case ID no longer
// passes (TP-baseline-012) or when the pass count drops — and deleting
// throwaway tests does BOTH. `stripReaped` therefore removes the reaped IDs
// from the baseline's `cases` and resets the reaped suite's `pass` to 0
// ("count reset, next green advance re-records the real number"), and
// `stripBaselinePlan` persists that to the DB plan at reap time so even a
// refused-and-retried sync compares clean. The next green `ws sync` advance
// (foldGreenRuns) rebuilds the suite entry from a real run, healing everything.
//
// DESTRUCTIVENESS (the (c) problem): deleting code is the one thing here that
// cannot be undone by a retry, so every boundary is conservative. A tag must be
// a `//` comment line directly above a TOP-LEVEL (column-0) `test(`/`it(`; the
// block ends at the first column-0 `});`. Any doubt — indented test, missing
// terminator, another top-level test inside the computed span, a post-edit
// `node --check` failure — leaves the file untouched with a printed note. A
// test file is never left syntactically broken.
import { readdirSync, readFileSync, writeFileSync, unlinkSync, mkdtempSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import * as api from './apiclient.js';
import {
  CASE_ID_SOURCE, expandCaseIds, parseBaseline, renderBaseline, baselineSlug, BASELINE_KIND,
} from './baseline.js';

/** Attribution on the plan writes this module makes (a scripted writer). */
export const REAP_AGENT = 'plan-reap';

/** Plan statuses that mean "closed" — the reap trigger (same set planclose treats as terminal). */
const CLOSED_STATUSES = ['done', 'archived'];

/**
 * The workspace repo's suites: baseline suite name → the directory its tests
 * live in. Repo-parameterised so another repo (hub, backlog 61) can hand
 * in its own spec without a rewrite.
 * @type {Array<{suite: string, dir: string, match: RegExp}>}
 */
export const WORKSPACE_SUITES = [
  { suite: 'cli', dir: 'cli/test', match: /\.test\.js$/ },
  { suite: 'server', dir: 'server/test', match: /\.test\.js$/ },
];

/** A `//` comment line (any indent). */
const COMMENT_RE = /^\s*\/\//;
/** The plan reference inside a tag comment. */
const TAG_RE = /@plan:([A-Za-z0-9][A-Za-z0-9-]*)/;
/** The disposition inside a tag comment. */
const DISPOSITION_RE = /@(promote|throwaway)\b/;
/** A top-level test the tag may own. */
const TEST_START_RE = /^(?:test|it)(?:\.\w+)?\s*\(/;
/** Any column-0 block opener that must never sit INSIDE a deletion span. */
const BLOCK_START_RE = /^(?:test|it|describe)(?:\.\w+)?\s*\(/;
/** The unambiguous end of a top-level test block. */
const TEST_END_RE = /^\}\);?\s*$/;
/** Any test call at all — a file with none left after reaping is deleted whole. */
const ANY_TEST_RE = /(^|\n)\s*(?:test|it)(?:\.\w+)?\s*\(/;

/**
 * Case IDs (including `TP-x-001/002` slash runs, expanded) referenced anywhere
 * in `text`. One shape owner: CASE_ID_SOURCE in util/baseline.js.
 * @param {string} text
 * @returns {Set<string>}
 */
export function harvestCaseIds(text) {
  const run = new RegExp(`${CASE_ID_SOURCE.replace(/\\b$/, '')}(?:/\\d{3})*\\b`, 'g');
  /** @type {Set<string>} */
  const ids = new Set();
  for (const token of String(text).match(run) || []) {
    for (const id of expandCaseIds(token)) ids.add(id);
  }
  return ids;
}

/**
 * The tags a file carries: every `//` comment line containing `@plan:`.
 * @param {string} content
 * @returns {Array<{line: number, slug: string, disposition: string}>}
 */
export function findTags(content) {
  /** @type {Array<{line: number, slug: string, disposition: string}>} */
  const tags = [];
  const lines = content.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    if (!COMMENT_RE.test(lines[i]) || !lines[i].includes('@plan:')) continue;
    const slug = (TAG_RE.exec(lines[i]) || [])[1] || '';
    const disposition = (DISPOSITION_RE.exec(lines[i]) || [])[1] || '';
    tags.push({ line: i, slug, disposition });
  }
  return tags;
}

/**
 * @typedef {object} FileReap
 * @property {string} content the file after the reap (unchanged when `changed` is false)
 * @property {boolean} changed
 * @property {number} removedTests count of deleted throwaway test blocks
 * @property {string[]} removedIds case IDs harvested from the deleted spans, sorted
 * @property {string[]} reapedPlans slugs whose throwaway tests were deleted, sorted
 * @property {string[]} promotedPlans slugs whose promoted tests were untagged, sorted
 * @property {string[]} notes conservative-abort reasons, one line each
 */

/**
 * Reap one file's tagged tests, purely. `decide` maps a slug to its fate:
 * 'reap' (plan closed), 'keep' (plan still open — silence, the normal wait) or
 * 'unknown' (no such test-plan — left alone WITH a note, so a typo'd slug nags
 * on every sync instead of quietly never reaping).
 * @param {string} content
 * @param {(slug: string) => 'reap'|'keep'|'unknown'} decide
 * @returns {FileReap}
 */
export function reapContent(content, decide) {
  const lines = content.split(/\r?\n/);
  /** @type {string[]} */
  const notes = [];
  /** @type {Set<string>} */
  const removedIds = new Set();
  /** @type {Set<string>} */
  const reapedPlans = new Set();
  /** @type {Set<string>} */
  const promotedPlans = new Set();
  let removedTests = 0;
  let changed = false;

  // Collect tag positions first, then edit bottom-up so indices stay valid.
  /** @type {number[]} */
  const tagLines = [];
  for (let i = 0; i < lines.length; i++) {
    if (COMMENT_RE.test(lines[i]) && lines[i].includes('@plan:')) tagLines.push(i);
  }
  for (const i of tagLines.reverse()) {
    const line = lines[i];
    const slug = (TAG_RE.exec(line) || [])[1] || '';
    const disposition = (DISPOSITION_RE.exec(line) || [])[1] || '';
    if (!slug || !disposition) {
      notes.push(`malformed tag left alone (need @plan:<slug> plus @promote|@throwaway): ${line.trim()}`);
      continue;
    }
    const fate = decide(slug);
    if (fate === 'keep') continue;
    if (fate !== 'reap') {
      notes.push(`@plan:${slug} names no test-plan (unknown slug) — left alone`);
      continue;
    }
    if (disposition === 'promote') {
      // Graduation: the test stays, only the tag goes. A dedicated tag line is
      // dropped whole; a tag sharing a comment with prose loses just the tokens.
      const stripped = line
        .replace(TAG_RE, '')
        .replace(DISPOSITION_RE, '')
        .replace(/\s+$/, '')
        .replace(/\s{2,}/g, ' ');
      if (/^\s*\/\/\s*$/.test(stripped)) lines.splice(i, 1);
      else lines[i] = stripped;
      promotedPlans.add(slug);
      changed = true;
      continue;
    }
    // @throwaway: the tag must sit in a comment block directly above a
    // top-level test — that adjacency is what makes the deletion boundary
    // unambiguous enough to automate.
    let t = i + 1;
    while (t < lines.length && COMMENT_RE.test(lines[t])) t++;
    if (t >= lines.length || !TEST_START_RE.test(lines[t])) {
      notes.push(`@plan:${slug} @throwaway is not directly above a top-level test( / it( — left alone`);
      continue;
    }
    // The span opens at the top of the contiguous comment block owning the tag.
    let start = i;
    while (start > 0 && COMMENT_RE.test(lines[start - 1])) start--;
    // …and closes at the first column-0 `});` (or on the test line itself for a
    // one-liner). No terminator, no deletion.
    let end = -1;
    if (/\}\s*\)\s*;?\s*$/.test(lines[t])) end = t;
    else {
      for (let e = t + 1; e < lines.length; e++) {
        if (TEST_END_RE.test(lines[e])) { end = e; break; }
      }
    }
    if (end === -1) {
      notes.push(`@plan:${slug} @throwaway test has no terminating column-0 '});' — left alone`);
      continue;
    }
    // Swallow-guard: if the span contains ANOTHER column-0 test/it/describe (or
    // another tag), the boundaries are lying — refuse rather than risk deleting
    // an innocent neighbour.
    let foreign = false;
    for (let s = t + 1; s < end; s++) {
      if (BLOCK_START_RE.test(lines[s]) || lines[s].includes('@plan:')) { foreign = true; break; }
    }
    if (foreign) {
      notes.push(`@plan:${slug} @throwaway span would swallow another top-level test — left alone`);
      continue;
    }
    for (const id of harvestCaseIds(lines.slice(start, end + 1).join('\n'))) removedIds.add(id);
    // Take one trailing blank line with the block so spacing does not accrete.
    const extra = end + 1 < lines.length && lines[end + 1].trim() === '' ? 1 : 0;
    lines.splice(start, end - start + 1 + extra);
    removedTests++;
    reapedPlans.add(slug);
    changed = true;
  }
  return {
    content: changed ? lines.join('\n') : content,
    changed,
    removedTests,
    removedIds: [...removedIds].sort(),
    reapedPlans: [...reapedPlans].sort(),
    promotedPlans: [...promotedPlans].sort(),
    notes,
  };
}

/**
 * Does this content still parse? Checked as an ES module (`.mjs`) — CommonJS
 * test files parse under ESM syntax rules too, since they carry no import/
 * export statements. Returns null on success, a one-line problem otherwise.
 * @param {string} content
 * @returns {string|null}
 */
export function nodeCheck(content) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'ws-reap-'));
  try {
    const file = path.join(dir, 'check.mjs');
    writeFileSync(file, content);
    execFileSync(process.execPath, ['--check', file], { stdio: ['ignore', 'ignore', 'pipe'] });
    return null;
  } catch (e) {
    const err = /** @type {{stderr?: Buffer|string, message?: string}} */ (e);
    const firstLine = String(err.stderr || err.message || 'syntax check failed').split(/\r?\n/).find((l) => l.trim()) || 'syntax check failed';
    return firstLine.trim();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * slug → status for every test-plan in the DB (one list call — the reaper only
 * needs "is it closed", and a slug missing from the list is 'unknown').
 * @param {string[]} _slugs the slugs the caller cares about (the full map covers them)
 * @param {typeof api.planList} [list]
 * @returns {Promise<Map<string, string>>}
 */
export async function defaultStatusOf(_slugs, list = api.planList) {
  const text = await list({ kind: 'test-plan', format: 'json' });
  const rows = /** @type {{plans?: Array<{slug: string, status: string}>}} */ (JSON.parse(text)).plans || [];
  return new Map(rows.map((r) => [r.slug, r.status]));
}

/** @param {string} root @param {Array<{suite: string, dir: string, match: RegExp}>} suites
 * @returns {Array<{suite: string, rel: string, abs: string}>} */
export function findTestFiles(root, suites) {
  /** @type {Array<{suite: string, rel: string, abs: string}>} */
  const out = [];
  for (const s of suites) {
    /** @type {string[]} */
    let names = [];
    try {
      names = readdirSync(path.join(root, s.dir));
    } catch {
      continue; // a repo without that suite dir simply has nothing to reap there
    }
    for (const n of names.sort()) {
      if (s.match.test(n)) out.push({ suite: s.suite, rel: `${s.dir}/${n}`, abs: path.join(root, s.dir, n) });
    }
  }
  return out;
}

/**
 * @typedef {object} ReapResult
 * @property {string[]} changedFiles repo-relative files edited in place
 * @property {string[]} deletedFiles repo-relative files removed whole (no tests left)
 * @property {string[]} removedCaseIds IDs deleted AND no longer referenced by any surviving test
 * @property {string[]} reapedSuites suite names that lost test blocks (their pass counts must reset)
 * @property {string[]} reapedPlans slugs whose throwaway tests were deleted
 * @property {string[]} promotedPlans slugs whose promoted tests were untagged
 * @property {string[]} notes printable diagnostics; the sweep itself never throws
 */

/**
 * Files in the sweep that import `target` — by basename, both ESM and CJS, with
 * or without the extension (`'./shared.test.js'`, `'./shared.test'`, `'./shared'`).
 * Deliberately broad: a false positive only means a dead file survives, which is
 * harmless, while a false negative wedges every retry of `ws sync`.
 * @param {{rel: string, abs: string}} target
 * @param {Array<{rel: string, abs: string, content: string}>} files
 * @returns {string[]} repo-relative paths of the importers
 */
export function referencingFiles(target, files) {
  const base = path.basename(target.rel).replace(/\.js$/, '');
  const stem = base.replace(/\.test$/, '');
  const re = new RegExp(
    `(?:from|require\\s*\\()\\s*['"][^'"]*?/(?:${escapeRe(base)}|${escapeRe(stem)})(?:\\.js)?['"]`,
  );
  return files
    .filter((f) => f.abs !== target.abs && re.test(f.content))
    .map((f) => f.rel);
}

/** @param {string} s */
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Sweep a repo's test files for plan tags and reap the ones whose plan closed.
 * Costs one directory scan when no tags exist (the common path) — the plan API
 * is only consulted once at least one tag is present.
 * @param {{root: string, suites?: typeof WORKSPACE_SUITES, statusOf?: typeof defaultStatusOf, check?: typeof nodeCheck, apply?: boolean}} p
 * @returns {Promise<ReapResult>}
 */
export async function sweepReap({ root, suites = WORKSPACE_SUITES, statusOf = defaultStatusOf, check = nodeCheck, apply = true }) {
  /** @type {ReapResult} */
  const out = { changedFiles: [], deletedFiles: [], removedCaseIds: [], reapedSuites: [], reapedPlans: [], promotedPlans: [], notes: [] };
  const files = findTestFiles(root, suites).map((f) => ({ ...f, content: readFileSync(f.abs, 'utf8') }));
  /** @type {Set<string>} */
  const slugs = new Set();
  for (const f of files) {
    for (const t of findTags(f.content)) if (t.slug) slugs.add(t.slug);
  }
  if (!slugs.size) return out;
  /** @type {Map<string, string>} */
  let statuses;
  try {
    statuses = await statusOf([...slugs]);
  } catch (e) {
    out.notes.push(`sweep skipped (plan status lookup failed: ${e instanceof Error ? e.message : e})`);
    return out;
  }
  /** @type {(slug: string) => 'reap'|'keep'|'unknown'} */
  const decide = (slug) => {
    const status = statuses.get(slug);
    if (status === undefined) return 'unknown';
    return CLOSED_STATUSES.includes(String(status)) ? 'reap' : 'keep';
  };
  /** @type {Set<string>} */
  const removed = new Set();
  /** @type {Set<string>} */
  const reapedSuites = new Set();
  /** @type {Set<string>} */
  const reapedPlans = new Set();
  /** @type {Set<string>} */
  const promotedPlans = new Set();
  /** @type {string[]} survivors: every file content that remains after the reap */
  const survivors = [];
  /** @type {Array<{abs: string, kind: 'write'|'delete', content: string}>} */
  const actions = [];
  for (const f of files) {
    const r = reapContent(f.content, decide);
    for (const n of r.notes) out.notes.push(`${f.rel}: ${n}`);
    if (!r.changed) {
      survivors.push(f.content);
      continue;
    }
    if (r.removedTests > 0 && !ANY_TEST_RE.test(r.content)) {
      // Nothing left to run — the leftover imports/fixtures are dead weight…
      // …UNLESS another file in the suite imports this one. `check()` is
      // `node --check`, which parses ONE file and cannot see a cross-file import,
      // so deleting an imported file leaves the importer dangling: the suite goes
      // red, ci-guard refuses the push, and the deletion is ALREADY staged — so
      // every retry hits the same wall. That wedges `ws sync`, the one path every
      // station needs to push anything, and it strikes right after a plan closes.
      // Reproduced 2026-08-01 before this guard existed.
      const importers = referencingFiles(f, files);
      if (importers.length) {
        out.notes.push(
          `${f.rel}: emptied but NOT deleted — imported by ${importers.join(', ')} (deleting it would red the suite and wedge the sync)`,
        );
        actions.push({ abs: f.abs, kind: 'write', content: r.content });
        out.changedFiles.push(f.rel);
      } else {
        actions.push({ abs: f.abs, kind: 'delete', content: '' });
        out.deletedFiles.push(f.rel);
      }
    } else {
      const problem = check(r.content);
      if (problem) {
        // The one hard rule of (c): never leave a test file broken. The edit is
        // dropped whole and the original stays byte-identical on disk.
        out.notes.push(`${f.rel}: edit aborted (syntax check failed: ${problem}) — file left untouched`);
        survivors.push(f.content);
        continue;
      }
      actions.push({ abs: f.abs, kind: 'write', content: r.content });
      out.changedFiles.push(f.rel);
      survivors.push(r.content);
    }
    if (r.removedTests > 0) reapedSuites.add(f.suite);
    for (const id of r.removedIds) removed.add(id);
    for (const s of r.reapedPlans) reapedPlans.add(s);
    for (const s of r.promotedPlans) promotedPlans.add(s);
  }
  // Shared-ID safety: an ID some surviving test still asserts is NOT removed
  // coverage, so it must stay in the baseline.
  const still = harvestCaseIds(survivors.join('\n'));
  out.removedCaseIds = [...removed].filter((id) => !still.has(id)).sort();
  out.reapedSuites = [...reapedSuites].sort();
  out.reapedPlans = [...reapedPlans].sort();
  out.promotedPlans = [...promotedPlans].sort();
  if (apply) {
    for (const a of actions) {
      if (a.kind === 'delete') unlinkSync(a.abs);
      else writeFileSync(a.abs, a.content);
    }
  }
  return out;
}

/**
 * A baseline with the reaped coverage taken out, purely. Removed case IDs drop
 * from every suite's `cases`; a suite that lost test BLOCKS also gets `pass: 0`
 * — its recorded count includes the deleted tests, and comparing against it
 * would read as a pass-count regression (compareSuite flags passDelta < 0
 * independently of case IDs). Zero is the honest "count reset" value: the next
 * green advance (foldGreenRuns) re-records the real number, and until then a
 * run can only look equal-or-better.
 * @param {import('./baseline.js').Baseline|null} baseline
 * @param {string[]} removedCaseIds
 * @param {string[]} reapedSuites
 * @returns {{baseline: import('./baseline.js').Baseline|null, changed: boolean}}
 */
export function stripReaped(baseline, removedCaseIds, reapedSuites) {
  if (!baseline || !baseline.suites) return { baseline, changed: false };
  const removed = new Set(removedCaseIds);
  const reaped = new Set(reapedSuites);
  let changed = false;
  /** @type {Record<string, import('./baseline.js').SuiteBaseline>} */
  const suites = {};
  for (const [name, s] of Object.entries(baseline.suites)) {
    const cases = (s.cases || []).filter((c) => !removed.has(c));
    const lostCases = cases.length !== (s.cases || []).length;
    const resetPass = reaped.has(name) && s.pass !== 0;
    if (lostCases || resetPass) {
      suites[name] = { ...s, cases, ...(reaped.has(name) ? { pass: 0 } : {}) };
      changed = true;
    } else {
      suites[name] = s;
    }
  }
  return { baseline: { ...baseline, suites }, changed };
}

/**
 * Persist the strip to the repo's DB baseline plan and return the stripped
 * record for the caller's in-memory use. Best effort on the write: a failed
 * `planSet` still returns the stripped baseline (so THIS sync's guard compares
 * clean) with a note — the next green advance heals the DB copy.
 * @param {{repo: string, removedCaseIds: string[], reapedSuites: string[], current?: import('./baseline.js').Baseline|null, plans?: {get: typeof api.planGet, set: typeof api.planSet}}} p
 * @returns {Promise<{baseline: import('./baseline.js').Baseline|null, changed: boolean, note: string}>}
 */
export async function stripBaselinePlan({ repo, removedCaseIds, reapedSuites, current, plans }) {
  const p = plans || { get: api.planGet, set: api.planSet };
  if (!removedCaseIds.length && !reapedSuites.length) return { baseline: current ?? null, changed: false, note: '' };
  let base = current;
  if (base === undefined) {
    try {
      base = parseBaseline(await p.get(baselineSlug(repo)));
    } catch {
      base = null; // absent baseline — nothing to strip, nothing to protect
    }
  }
  const { baseline: next, changed } = stripReaped(base ?? null, removedCaseIds, reapedSuites);
  if (!changed || !next) return { baseline: base ?? null, changed: false, note: '' };
  try {
    await p.set(baselineSlug(repo), {
      body: renderBaseline(next),
      kind: BASELINE_KIND,
      status: 'active',
      repo,
      agent: REAP_AGENT,
    });
    return { baseline: next, changed: true, note: '' };
  } catch (e) {
    return {
      baseline: next,
      changed: true,
      note: `baseline strip not persisted (${e instanceof Error ? e.message : e}) — this sync still compares clean; the next green advance heals the DB copy`,
    };
  }
}
