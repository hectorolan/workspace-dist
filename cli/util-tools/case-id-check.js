// case-id-check — test-case ID uniqueness guard + next-free-ID lookup.
//
// Case IDs (`TP-nexus-e2e-081`, `TP-nexus-thr-010`, `TP-prwatch-plan-close-017`)
// are the identity a test plan closes on: plan-close matches a green run's case
// IDs against the plan's automated cases. Two tests sharing an ID therefore let
// one plan's run satisfy another plan's case — a silent false close. They also
// collide by accident, because the next free number is discovered by grepping
// and two concurrent branches grep the same answer (2026-08-02: PR #33 claimed
// e2e-078..081 on main while PR #34's branch independently claimed e2e-078..080;
// `e2e-070` was already duplicated between two spec files before that).
//
// usage:
//   node cli/util-tools/case-id-check.js [--repo <path>] [--dirs e2e,test]
//                                        [--refs origin/main,origin/feat/x]
//                                        [--next <prefix>] [--json]
//
//   --repo   repo root to scan (default: cwd)
//   --dirs   comma-separated dirs to scan (default: e2e,test)
//   --refs   ALSO scan these git refs, so an unmerged branch's claims are seen
//            (the collision above is invisible to a working-tree-only scan)
//   --next   print only the next free ID for a series, e.g. --next TP-nexus-e2e
//   --json   structured output
//
// Exit 1 when a duplicate claim exists (CI-usable), 0 otherwise.
//
// A CLAIM is an ID in a TEST TITLE — a `test(`/`it(` line of a *.spec.js /
// *.test.js file: that is a test asserting its identity. An ID anywhere else
// (comments, fixtures, helpers, docs — even inside a spec file) is a
// REFERENCE: reported for context, never counted as a duplicate, because a
// comment or fixture citing the case it serves is correct and must not read
// as a collision. (The 2026-08-02 sweep found 9 of 12 reported ho-nexus
// "duplicates" were exactly such citations — a `//` comment naming the
// covering test in another file.)
//
// Duplicate-resolution suffixes: `TP-x-079` and `TP-x-079_2` are DISTINCT IDs
// (CEO decision 2026-08-02 — the second claimant of a collided ID is renamed
// `<id>_2`, a third `_3`; grammar owner: CASE_ID_SOURCE in util/baseline.js,
// mirrored here because this tool must also run vendored in repos that have no
// workspace checkout). A suffixed claim still counts toward `--next` via its
// bare number.
//
// Claims are keyed by PATH, never by ref:path — the same test in the same file
// seen both on main and on a branch is ONE claim. What a --refs scan catches is
// the real case: two DIFFERENT files, on different refs, claiming one ID.
//
// Suffix-rename supersede: when the working tree at path P claims `X_k`, a
// ref-side claim of bare `X` at the SAME path P is dropped (demoted to a
// reference) — that is a duplicate-resolution rename in flight, and without
// this rule the fix PR itself would re-collide against the stale copy on
// origin/main. Only this exact shape supersedes: a ref-side claim in a file
// the tree also has still counts otherwise (that asymmetry is what catches a
// branch claiming an ID that main's newer copy of another file already owns).
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const args = process.argv.slice(2);
/** @param {string} name @param {string} fallback @returns {string} */
const flag = (name, fallback) => {
  const i = args.indexOf(name);
  const v = args[i + 1];
  return i >= 0 && v && !v.startsWith('--') ? v : fallback;
};
const repo = resolve(flag('--repo', process.cwd()));
const dirs = flag('--dirs', 'e2e,test').split(',').map((/** @type {string} */ d) => d.trim()).filter(Boolean);
const refs = flag('--refs', '').split(',').map((/** @type {string} */ r) => r.trim()).filter(Boolean);
const nextOnly = flag('--next', '');
const asJson = args.includes('--json');

// TP-<series>-<number>[_suffix]. The trailing digits are the case number;
// whatever precedes them is the series (so `TP-nexus-e2e` and `TP-nexus-thr`
// count apart); an optional `_\d+` suffix makes a distinct ID sharing the
// number (so a suffixed claim never collides with the bare one, but still
// advances `--next` past the shared number).
// GREEDY series, like the grammar owner (CASE_ID_SOURCE in util/baseline.js): a lazy
// prefix stops at the FIRST numeric segment, so a date-bearing slug
// (`TP-nsg-ip-mismatch-check-2026-08-26-001`) read as `TP-nsg-ip-mismatch-check-2026` and
// every case of that plan collapsed onto ONE id — a manufactured duplicate the moment the
// plan spanned two files (2026-08-26). Greedy takes the LAST numeric group as the case
// number, which is what plan-close matches on.
const ID_RE = /\bTP-([A-Za-z0-9]+(?:-[A-Za-z0-9]+)*)-(\d{2,})(_\d+)?\b/g;
/** @param {string} p */
const isClaimFile = (p) => /\.(spec|test)\.[cm]?js$/.test(p);
/** A test-title line — the only line shape whose IDs are CLAIMS. */
const TEST_LINE_RE = /^\s*(?:test|it)(?:\.\w+)?\s*\(/;

/** @type {Map<string, {series: string, num: number, claims: Set<string>, refs: Set<string>}>} */
const ids = new Map();

/** Working-tree claims per path — the supersede rule reads these. @type {Map<string, Set<string>>} */
const treeClaims = new Map();

/** @param {string} id @param {string} series @param {number} num @param {string} where @param {boolean} claim */
function record(id, series, num, where, claim) {
  let e = ids.get(id);
  if (!e) {
    e = { series, num, claims: new Set(), refs: new Set() };
    ids.set(id, e);
  }
  (claim ? e.claims : e.refs).add(where);
}

/**
 * Scan file text line by line: an ID on a test-title line of a claim-eligible
 * file is a CLAIM, every other occurrence is a reference.
 * @param {string} text @param {string} where @param {boolean} claimEligible
 */
function scanText(text, where, claimEligible) {
  for (const line of text.split(/\r?\n/)) scanLine(line, where, claimEligible, false);
}

/** @param {string} line @param {string} where @param {boolean} claimEligible @param {boolean} fromRef */
function scanLine(line, where, claimEligible, fromRef) {
  const titleLine = claimEligible && TEST_LINE_RE.test(line);
  ID_RE.lastIndex = 0;
  /** @type {RegExpExecArray | null} */
  let m;
  while ((m = ID_RE.exec(line)) !== null) {
    const id = m[0];
    let claim = titleLine;
    if (claim && !fromRef) {
      let set = treeClaims.get(where);
      if (!set) treeClaims.set(where, (set = new Set()));
      set.add(id);
    }
    // Supersede: the tree at this path renamed bare X to X_k — the ref's stale
    // bare claim demotes to a reference.
    if (claim && fromRef && !m[3]) {
      const renamed = [...(treeClaims.get(where) || [])].some((t) => t.startsWith(`${id}_`));
      if (renamed) claim = false;
    }
    record(id, `TP-${m[1]}`, Number(m[2]), where, claim);
  }
}

/** @param {string} dir @param {(full: string) => void} onFile */
function walk(dir, onFile) {
  /** @type {string[]} */
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return; // a dir that does not exist in this repo is not an error
  }
  for (const name of entries) {
    if (name === 'node_modules' || name.startsWith('.')) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, onFile);
    else if (/\.[cm]?js$/.test(full)) onFile(full);
  }
}

// --- working tree ---
for (const d of dirs) {
  walk(join(repo, d), (/** @type {string} */ full) => {
    const rel = relative(repo, full).replace(/\\/g, '/');
    scanText(readFileSync(full, 'utf8'), rel, isClaimFile(rel));
  });
}

// --- other refs (unmerged branches) via git grep ---
for (const ref of refs) {
  let out = '';
  try {
    // Whole lines, not -o matches: claim-vs-reference needs the line SHAPE
    // (is it a test title?), and -n makes `<ref>:<path>:<lineno>:<line>`
    // parseable even when the line itself contains colons.
    out = execFileSync('git', ['-C', repo, 'grep', '-nE', 'TP-[A-Za-z0-9-]+-[0-9]{2,}', ref, '--', ...dirs], {
      encoding: 'utf8',
      maxBuffer: 8 * 1024 * 1024,
    });
  } catch {
    continue; // no matches, or the ref is unknown — neither is fatal
  }
  for (const line of out.split('\n')) {
    if (!line.startsWith(`${ref}:`)) continue;
    const m = /^(.+?):(\d+):(.*)$/.exec(line.slice(ref.length + 1)); // `<path>:<lineno>:<line>`
    if (!m) continue;
    const path = m[1].replace(/\\/g, '/');
    scanLine(m[3], path, isClaimFile(path), true);
  }
}

const duplicates = [...ids.entries()]
  .filter(([, e]) => e.claims.size > 1)
  .map(([id, e]) => ({ id, claimedIn: [...e.claims].sort() }))
  .sort((a, b) => a.id.localeCompare(b.id));

/** @type {Record<string, number>} */
const nextFree = {};
for (const [, e] of ids) {
  nextFree[e.series] = Math.max(nextFree[e.series] ?? 0, e.num + 1);
}

if (nextOnly) {
  const series = nextOnly.replace(/-$/, '');
  const n = nextFree[series];
  if (!n) {
    console.log(`case-id-check: no existing IDs for series '${series}' — start at ${series}-001`);
    process.exit(0);
  }
  console.log(`${series}-${String(n).padStart(3, '0')}`);
  process.exit(0);
}

if (asJson) {
  console.log(JSON.stringify({ repo, dirs, refs, total: ids.size, duplicates, nextFree }, null, 2));
} else {
  console.log(`case-id-check: ${ids.size} distinct case ID(s) across ${dirs.join(', ')}${refs.length ? ` + refs ${refs.join(', ')}` : ''}`);
  for (const [series, n] of Object.entries(nextFree).sort()) {
    console.log(`  next free: ${series}-${String(n).padStart(3, '0')}`);
  }
  if (!duplicates.length) console.log('case-id-check: no duplicate claims');
  else {
    console.log(`case-id-check: ${duplicates.length} DUPLICATE claim(s) — one ID, several tests:`);
    for (const d of duplicates) console.log(`  ${d.id} claimed in ${d.claimedIn.join('  +  ')}`);
  }
}

process.exit(duplicates.length ? 1 : 0);
