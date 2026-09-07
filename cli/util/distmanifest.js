// The distribution manifest — loader, rule compiler, and include-set resolver.
//
// WHY THIS IS A util/ MODULE AND NOT PART OF THE EXPORTER: the manifest
// (`configs/distribution.json`) is reviewed in a PR long before the exporter
// exists (plan `nexus-distribution-packaging`, Phase 2 vs Phase 3), and the
// tests that prove the manifest is sane must apply the SAME rules the exporter
// will apply later. One rule set, imported by both, or the reviewed manifest and
// the shipped tree drift apart — the exact failure the generated-export design
// exists to prevent.
//
// RULE SEMANTICS (the whole contract, stated once here — docs/distribution.md
// cross-references it, never restates it):
//   - An include `path` is a tracked file (exact) or a tracked directory (its
//     whole subtree). No wildcards: an include names what it means.
//   - An exclude `pattern` is an exact path, a directory prefix (`dir/`), a
//     basename pattern (no `/`, gitignore-like: matches at any depth), or a
//     glob with `*` (within one segment) and `**` (any depth).
//   - A file ships iff the MOST SPECIFIC matching rule is an include, where
//     specificity = number of path segments the rule spells out (`**` counts
//     zero, a basename pattern counts one). Ties go to the exclude — safe by
//     default. So `cli/` (1) < `cli/util-tools/` (2) < the explicit opt-in
//     `cli/util-tools/env-doctor.js` (3): per-tool opt-in without wildcards.
//   - Transform sources never ship as plain copies; the exporter writes the
//     declared `.example` target instead (this module only VALIDATES that the
//     source is excluded; applying transforms is the exporter's job).
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

/** @typedef {"postgres"|"sqlite"} DbEngine — the DB engine the distribution ships on (CEO ruling D7, 2026-08-26: postgres) */
/** @typedef {{ id: string, label: string, default: boolean, gates: string[], phase?: number, reason: string }} SetupToggle —
 *   a client-chosen feature switch the setup module offers; `default` is what ships when the client says nothing */

/** The engines the validator accepts for target.dbEngine. */
export const DB_ENGINES = /** @type {const} */ (['postgres', 'sqlite']);

/** The manifest's home, relative to the workspace root. */
export const MANIFEST_PATH = 'configs/distribution.json';

/**
 * @typedef {{ path: string, reason: string, group?: string }} IncludeEntry
 * @typedef {{ pattern: string, reason: string, expect?: 'tracked'|'untracked' }} ExcludeEntry
 * @typedef {{ from: string, to: string, reason: string, set?: Record<string, unknown>, drop?: string[], setEach?: Record<string, Record<string, unknown>> }} TransformEntry
 * @typedef {{ source: string, target: string, phase: number, reason: string }} OverlayEntry
 * @typedef {{ repo: string, mode: "vendored"|"reference", ref?: string, target?: string, reason: string }} CompanionEntry —
 *   `vendored` (hub, CEO ruling 2026-08-25: the repo stays private, so its SOURCE tree is copied into `target/` at the
 *   pinned `ref`, history stripped) requires ref + target; `reference` (a public repo the client clones itself) needs neither
 * @typedef {{
 *   version: number,
 *   target: { repo: string, visibility: string, firstTag: string, dbEngine: DbEngine, runtimeImage?: string },
 *   include: IncludeEntry[],
 *   exclude: ExcludeEntry[],
 *   transforms: TransformEntry[],
 *   overlay: { dir: string, files: OverlayEntry[] },
 *   companions: CompanionEntry[],
 *   setup?: { toggles: SetupToggle[] },
 *   guards: { secretPatterns: string[], attributionDatePattern: string }
 * }} Manifest
 */

/** @param {string} p */
export const toPosix = (p) => p.replace(/\\/g, '/').replace(/^\.\//, '');

/**
 * Read and shape-check the manifest. Throws ONE error listing every shape
 * problem found, so a reviewer fixes them in one pass.
 * @param {string} root workspace root
 * @returns {Manifest}
 */
export function loadManifest(root) {
  const file = path.join(root, MANIFEST_PATH);
  /** @type {any} */
  const m = JSON.parse(readFileSync(file, 'utf8'));
  const problems = validateManifest(m);
  if (problems.length) throw new Error(`${MANIFEST_PATH}: ${problems.length} shape problem(s)\n - ${problems.join('\n - ')}`);
  return /** @type {Manifest} */ (m);
}

/**
 * Shape rules, returned as a list (empty = valid). Kept separate from the
 * loader so a test can assert the exact findings on a synthetic manifest.
 * @param {any} m
 * @returns {string[]}
 */
export function validateManifest(m) {
  /** @type {string[]} */
  const out = [];
  if (!m || typeof m !== 'object') return ['manifest is not an object'];
  if (m.version !== 1) out.push('version must be 1');
  if (!m.target || typeof m.target.repo !== 'string' || typeof m.target.visibility !== 'string' || typeof m.target.firstTag !== 'string') {
    out.push('target needs repo, visibility, firstTag');
  }
  if (!m.target || !DB_ENGINES.includes(m.target.dbEngine)) {
    out.push(`target.dbEngine must be one of ${DB_ENGINES.join('|')}`);
  }
  if (m.setup !== undefined) {
    if (!m.setup || !Array.isArray(m.setup.toggles)) out.push('setup needs toggles[]');
    else m.setup.toggles.forEach((/** @type {any} */ t, /** @type {number} */ i) => {
      if (!t || typeof t.id !== 'string' || typeof t.label !== 'string' || typeof t.default !== 'boolean'
        || !Array.isArray(t.gates) || t.gates.length === 0 || typeof t.reason !== 'string' || !t.reason.trim()) {
        out.push(`setup.toggles[${i}] needs id, label, boolean default, gates[], reason`);
      }
    });
  }
  /** @param {string} key @param {(e: any, i: number) => void} check */
  const list = (key, check) => {
    if (!Array.isArray(m[key])) { out.push(`${key} must be an array`); return; }
    m[key].forEach((/** @type {any} */ e, /** @type {number} */ i) => {
      if (!e || typeof e !== 'object') { out.push(`${key}[${i}] is not an object`); return; }
      if (typeof e.reason !== 'string' || !e.reason.trim()) out.push(`${key}[${i}] has no reason`);
      check(e, i);
    });
  };
  list('include', (e, i) => {
    if (typeof e.path !== 'string' || !e.path) out.push(`include[${i}] has no path`);
    else if (/[*?]/.test(e.path)) out.push(`include[${i}] "${e.path}" uses a wildcard — includes name what they mean`);
  });
  list('exclude', (e, i) => {
    if (typeof e.pattern !== 'string' || !e.pattern) out.push(`exclude[${i}] has no pattern`);
    if (e.expect !== undefined && e.expect !== 'tracked' && e.expect !== 'untracked') out.push(`exclude[${i}] expect must be tracked|untracked`);
  });
  list('transforms', (e, i) => {
    if (typeof e.from !== 'string' || typeof e.to !== 'string') out.push(`transforms[${i}] needs from + to`);
    else if (!e.to.endsWith('.example.json')) out.push(`transforms[${i}] "${e.to}" must end in .example.json`);
    if (!e.set && !e.drop && !e.setEach) out.push(`transforms[${i}] declares no set/drop/setEach — it would ship the live file verbatim`);
  });
  if (!m.overlay || typeof m.overlay.dir !== 'string' || !Array.isArray(m.overlay.files)) out.push('overlay needs dir + files[]');
  else {
    m.overlay.files.forEach((/** @type {any} */ e, /** @type {number} */ i) => {
      if (!e || typeof e.source !== 'string' || typeof e.target !== 'string') out.push(`overlay.files[${i}] needs source + target`);
      else if (!e.source.startsWith(m.overlay.dir + '/')) out.push(`overlay.files[${i}] source must live under ${m.overlay.dir}/`);
      if (!e || !Number.isInteger(e.phase)) out.push(`overlay.files[${i}] needs an integer phase`);
      if (!e || typeof e.reason !== 'string' || !e.reason.trim()) out.push(`overlay.files[${i}] has no reason`);
    });
  }
  list('companions', (e, i) => {
    if (typeof e.repo !== 'string' || typeof e.mode !== 'string') out.push(`companions[${i}] needs repo + mode`);
    else if (e.mode !== 'vendored' && e.mode !== 'reference') out.push(`companions[${i}] mode must be vendored|reference`);
    else if (e.mode === 'vendored' && (typeof e.ref !== 'string' || !e.ref.trim() || typeof e.target !== 'string' || !/^[^/].*\/$/.test(e.target))) {
      out.push(`companions[${i}] vendored needs a non-empty ref and a relative target directory ending in /`);
    }
  });
  if (!m.guards || !Array.isArray(m.guards.secretPatterns) || typeof m.guards.attributionDatePattern !== 'string') {
    out.push('guards needs secretPatterns[] + attributionDatePattern');
  }
  return out;
}

/**
 * The tracked files of a git tree, posix paths, sorted. What the exporter copies
 * FROM — never the working tree, so an untracked local file can never ship.
 * @param {string} root
 * @returns {string[]}
 */
export function trackedFiles(root) {
  const out = execFileSync('git', ['-C', root, 'ls-files', '-z'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return out.split('\0').filter(Boolean).map(toPosix).sort();
}

/**
 * The GitHub owner in a remote URL, https (`https://github.com/owner/repo.git`)
 * or ssh (`git@github.com:owner/repo.git`) form. Null when the URL is not
 * GitHub-shaped. Decision D6: the account is never written in config — it is
 * derived from a clone's own origin remote (the "CEO is config" rule applied
 * to the GitHub owner).
 * @param {string|null|undefined} url
 * @returns {string|null}
 */
export function parseOwner(url) {
  const m = /github\.com[:/]([^/]+)\//.exec(url || '');
  return m ? m[1] : null;
}

/**
 * The GitHub owner of a clone's origin remote (see parseOwner). Null when the
 * clone has no origin or git is unavailable.
 * @param {string} root
 * @returns {string|null}
 */
export function originOwner(root) {
  try {
    const url = execFileSync('git', ['-C', root, 'config', '--get', 'remote.origin.url'], { encoding: 'utf8' }).trim();
    return parseOwner(url);
  } catch {
    return null;
  }
}

/** @param {string} s */
const escapeRe = (s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&');

/**
 * @typedef {{ kind: 'include'|'exclude', spec: string, specificity: number, test: (file: string) => boolean }} Rule
 */

/**
 * Compile an exclude pattern (see the semantics in the header comment).
 * @param {string} pattern
 * @returns {Rule}
 */
export function compileExclude(pattern) {
  const p = toPosix(pattern);
  if (!p.includes('/')) {
    // basename pattern, any depth
    const re = new RegExp('^' + escapeRe(p).replace(/\*/g, '[^/]*') + '$');
    return { kind: 'exclude', spec: p, specificity: 1, test: (f) => re.test(f.slice(f.lastIndexOf('/') + 1)) };
  }
  if (p.endsWith('/')) {
    const prefix = p;
    return { kind: 'exclude', spec: p, specificity: segments(p), test: (f) => f.startsWith(prefix) };
  }
  if (!p.includes('*')) {
    return { kind: 'exclude', spec: p, specificity: segments(p), test: (f) => f === p };
  }
  // `**` spans any depth (a leading `**/` also matches the root); `*` stays in its segment.
  const src = p.split('**').map((part) => escapeRe(part).replace(/\*/g, '[^/]*')).join('.*')
    .replace(/^\.\*\//, '(?:.*/)?');
  const re = new RegExp('^' + src + '$');
  return { kind: 'exclude', spec: p, specificity: segments(p), test: (f) => re.test(f) };
}

/**
 * Compile an include path against the tracked set: exact file or directory subtree.
 * @param {string} p
 * @returns {Rule}
 */
export function compileInclude(p) {
  const posix = toPosix(p).replace(/\/$/, '');
  return {
    kind: 'include', spec: posix, specificity: segments(posix),
    test: (f) => f === posix || f.startsWith(posix + '/'),
  };
}

/** Segments a rule spells out — `**` counts zero. @param {string} p */
function segments(p) {
  return p.split('/').filter((s) => s !== '' && s !== '**').length;
}

/**
 * Apply the manifest to a tracked-file list.
 * @param {Manifest} manifest
 * @param {string[]} files posix paths
 * @returns {{ included: string[], decisions: Map<string, Rule|null> }} `decisions` maps every file to the rule that decided it (null = no rule matched → not shipped)
 */
export function resolve(manifest, files) {
  /** @type {Rule[]} */
  const rules = [
    ...manifest.include.map((e) => compileInclude(e.path)),
    ...manifest.exclude.map((e) => compileExclude(e.pattern)),
    // A transform source is never a plain copy — the exporter writes its target.
    ...manifest.transforms.map((t) => compileExclude(toPosix(t.from))),
  ];
  /** @type {Map<string, Rule|null>} */
  const decisions = new Map();
  /** @type {string[]} */
  const included = [];
  for (const f of files) {
    /** @type {Rule|null} */
    let best = null;
    for (const r of rules) {
      if (!r.test(f)) continue;
      if (!best || r.specificity > best.specificity || (r.specificity === best.specificity && r.kind === 'exclude' && best.kind === 'include')) best = r;
    }
    decisions.set(f, best);
    if (best && best.kind === 'include') included.push(f);
  }
  return { included, decisions };
}

/**
 * Relative import specifiers in an ES module's source — static `import … from`,
 * side-effect `import '…'`, `export … from`, and literal `import('…')`. Resolved
 * against the importing file, posix. Used for the import-closure check: a shipped
 * file must not import a file that stays behind.
 * @param {string} file posix path of the importing module
 * @param {string} source module text
 * @returns {string[]} resolved posix paths (as written; `.js` is not appended)
 */
export function relativeImports(file, source) {
  const re = /(?:\bfrom\s*|\bimport\s*\(?\s*|\bexport\s+\*\s+from\s*)['"](\.{1,2}\/[^'"]+)['"]/g;
  const dir = path.posix.dirname(file);
  /** @type {string[]} */
  const out = [];
  for (const m of source.matchAll(re)) out.push(path.posix.normalize(path.posix.join(dir, m[1])));
  return out;
}

/**
 * Read a dot-path (`a.b.c`) out of a parsed JSON object; `undefined` when absent.
 * @param {any} obj @param {string} dotPath
 */
export function getPath(obj, dotPath) {
  return dotPath.split('.').reduce((o, k) => (o && typeof o === 'object' ? o[k] : undefined), obj);
}

/**
 * Lines on which a person's name appears OUTSIDE a dated attribution. A line
 * carrying an ISO date is provenance ("<name> 2026-07-19: …") and stays true
 * forever; any other mention is a hardcoded identity. Case-insensitive
 * substring on purpose: a handle derived from the name (`<name>olan`) is a hit too.
 * Reports line NUMBERS only — never the line text (the encoding-guard rule).
 * @param {string} text
 * @param {string} name
 * @param {string} attributionDatePattern regex source
 * @returns {number[]} 1-based line numbers
 */
export function nameHits(text, name, attributionDatePattern) {
  const dateRe = new RegExp(attributionDatePattern);
  const needle = name.toLowerCase();
  /** @type {number[]} */
  const out = [];
  text.split(/\r?\n/).forEach((line, i) => {
    if (line.toLowerCase().includes(needle) && !dateRe.test(line)) out.push(i + 1);
  });
  return out;
}

/**
 * Lines on which a key-shaped literal appears. Same reporting rule: numbers only.
 * @param {string} text
 * @param {string[]} secretPatterns regex sources
 * @returns {number[]}
 */
export function secretHits(text, secretPatterns) {
  const res = secretPatterns.map((p) => new RegExp(p));
  /** @type {number[]} */
  const out = [];
  text.split(/\r?\n/).forEach((line, i) => {
    if (res.some((re) => re.test(line))) out.push(i + 1);
  });
  return out;
}
