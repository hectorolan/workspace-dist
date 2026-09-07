// encoding guard (plan `environment-setup-streamlining`, W2) - the byte-level
// script-encoding check shared by the ci-guard preflight and CI.
//
// WHY: on 2026-07-28 both directions of one fault were hit in a single day, and one
// of them leaked a credential.
//
//  1. A UTF-8 BOM in a shell script. bash does not treat the BOM as whitespace, so it
//     read BOM+assignment as a command NAME; the "command not found" error echoed the
//     expanded line and printed the container GITHUB_TOKEN into the session transcript.
//     Shell scripts must therefore be BOM-free.
//  2. A BOM-less UTF-8 .ps1. Windows PowerShell 5.1 falls back to ANSI (cp1252) for a
//     file with no BOM, so a UTF-8 em dash decoded as a smart quote - and PowerShell
//     honours smart quotes as string delimiters, so the script stopped parsing.
//     PowerShell files must therefore be pure ASCII.
//
// The two rules point in opposite directions, so this module is deliberately
// FILE-TYPE SCOPED: never apply a BOM rule to a .ps1 or an ASCII rule to a .sh.
//
// STANDARD: the PowerShell rule is exactly the manual check already documented in
// `setup-scripts/windows/README.md` ("zero bytes > 127"), automated - not a second,
// competing standard. The parser half of that manual procedure needs a real
// PowerShell host and a parse, so it stays manual; this module is the byte half.
//
// PERFORMANCE: a single read + a single byte walk per candidate file, no parse, no
// decode, no subprocess. Selection is extension-based so a doc-only sync scans nothing.
//
// NEVER PRINT THE OFFENDING LINE. The incident this guard exists for was a credential
// echoed by an error message. Findings carry file, byte offset, line NUMBER and the
// rule violated - never the bytes themselves.
import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';

/** Files above this are not hand-written scripts; skip rather than read them. */
const MAX_BYTES = 2 * 1024 * 1024;

/** Extensions whose parser breaks on a byte-order mark. */
const SHELL_EXT = new Set(['.sh', '.bash', '.zsh', '.ksh', '.dash']);

/** Extensions read as ANSI by Windows PowerShell 5.1 when no BOM is present. */
const PS_EXT = new Set(['.ps1', '.psm1', '.psd1']);

/** A shebang naming a POSIX shell - catches extensionless scripts (setup helpers, hooks). */
const SHELL_SHEBANG = /^#!.*\b(sh|bash|zsh|ksh|dash)\b/;

/** @param {string} f @returns {string} repo-relative, forward slashes, lower-cased ext lookup key */
const norm = (f) => String(f).replace(/\\/g, '/');

/** @param {string} f @returns {string} */
const ext = (f) => path.posix.extname(norm(f)).toLowerCase();

/** @param {string} f */
export const isPowerShellFile = (f) => PS_EXT.has(ext(f));

/**
 * Whether a staged/tracked path is worth reading at all. Extension-based on purpose:
 * gate selection must be decidable from the path list alone (same contract as the
 * other ci-guard gates), and a doc-only sync must select nothing.
 *
 * Extensionless files ARE candidates because that is how a shebang-only shell script
 * looks; `scanBuffer` then decides from the shebang whether any rule applies, so the
 * cost of a false candidate is one read.
 * @param {string} f
 * @returns {boolean}
 */
export function isEncodingCandidate(f) {
  const base = path.posix.basename(norm(f));
  const e = ext(f);
  if (SHELL_EXT.has(e) || PS_EXT.has(e)) return true;
  // ".gitignore" and friends are dotfiles, not extensionless scripts.
  return e === '' && !base.startsWith('.');
}

/**
 * @typedef {object} EncodingViolation
 * @property {string} file repo-relative path
 * @property {'bom-in-shell-script'|'non-ascii-in-powershell'} rule
 * @property {number} offset byte offset of the first offending byte
 * @property {number} line 1-based line number of that byte (NUMBER only, never text)
 * @property {number} count how many offending bytes the file holds
 * @property {string} why one sentence of cause, no file content
 */

/** @param {Buffer} buf @param {number} offset @returns {number} 1-based line of that byte */
function lineOf(buf, offset) {
  let line = 1;
  for (let i = 0; i < offset && i < buf.length; i++) if (buf[i] === 0x0a) line++;
  return line;
}

/** @param {Buffer} buf @returns {boolean} */
const hasUtf8Bom = (buf) => buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf;

/** @param {Buffer} buf @returns {boolean} UTF-16 LE/BE mark - even more fatal to a shell */
const hasUtf16Bom = (buf) =>
  buf.length >= 2 && ((buf[0] === 0xff && buf[1] === 0xfe) || (buf[0] === 0xfe && buf[1] === 0xff));

/**
 * Is this a shell script? Extension first, then a shebang - read past a BOM, because
 * the file we most want to catch is precisely the one that starts with one.
 * @param {string} file
 * @param {Buffer} buf
 * @returns {boolean}
 */
export function isShellScript(file, buf) {
  if (SHELL_EXT.has(ext(file))) return true;
  const start = hasUtf8Bom(buf) ? 3 : hasUtf16Bom(buf) ? 2 : 0;
  // A shebang lives on the first line; 200 bytes is far more than any real one.
  const head = buf.subarray(start, start + 200).toString('latin1').split(/\r?\n/, 1)[0];
  return SHELL_SHEBANG.test(head);
}

/**
 * The whole rule set, applied to one file's bytes. Pure: no I/O, so tests drive it
 * directly with hand-built buffers.
 * @param {string} file repo-relative path (decides which rules apply)
 * @param {Buffer} buf
 * @returns {EncodingViolation[]}
 */
export function scanBuffer(file, buf) {
  const f = norm(file);
  /** @type {EncodingViolation[]} */
  const out = [];

  if (isPowerShellFile(f)) {
    // Direction 2: PowerShell 5.1 reads a BOM-less file as ANSI, so any non-ASCII
    // byte can decode into something with syntax meaning (the smart-quote case).
    // Matches the documented manual check: count of bytes > 127 must be zero.
    let first = -1;
    let count = 0;
    for (let i = 0; i < buf.length; i++) {
      if (buf[i] > 0x7f) {
        if (first < 0) first = i;
        count++;
      }
    }
    if (first >= 0) {
      out.push({
        file: f,
        rule: 'non-ascii-in-powershell',
        offset: first,
        line: lineOf(buf, first),
        count,
        why: 'Windows PowerShell 5.1 decodes a BOM-less file as ANSI; a non-ASCII byte can become a smart quote and silently end a string',
      });
    }
    return out; // BOM rule must never be applied to a .ps1 - opposite direction.
  }

  if (isShellScript(f, buf) && (hasUtf8Bom(buf) || hasUtf16Bom(buf))) {
    // Direction 1: bash reads the mark as part of the first token, so the first line
    // becomes an unknown command and the error echoes it (the 2026-07-28 token leak).
    out.push({
      file: f,
      rule: 'bom-in-shell-script',
      offset: 0,
      line: 1,
      count: hasUtf8Bom(buf) ? 3 : 2,
      why: 'bash reads a byte-order mark as part of the first command, and the resulting error echoes the expanded line (this leaked a token on 2026-07-28)',
    });
  }
  return out;
}

/**
 * @typedef {object} EncodingScan
 * @property {EncodingViolation[]} violations
 * @property {string[]} notes files that could not be judged (deleted, too big, unreadable)
 * @property {number} scanned files actually read
 */

/**
 * Read and scan the candidate files among `files`.
 *
 * DEGRADATION (the ci-guard rule): a file that cannot be read is a NOTE, never a
 * violation. Staged deletions, submodule paths and oversized blobs all land here, and
 * none of them may block a push.
 * @param {string} root absolute repo root
 * @param {string[]} files repo-relative paths
 * @returns {EncodingScan}
 */
export function scanFiles(root, files) {
  /** @type {EncodingViolation[]} */
  const violations = [];
  /** @type {string[]} */
  const notes = [];
  let scanned = 0;
  for (const rel of files) {
    if (!isEncodingCandidate(rel)) continue;
    const abs = path.join(root, norm(rel));
    let buf;
    try {
      const st = statSync(abs);
      if (!st.isFile()) continue;
      if (st.size > MAX_BYTES) {
        notes.push(`${norm(rel)}: ${st.size} bytes, larger than the ${MAX_BYTES}-byte script cap - not scanned`);
        continue;
      }
      buf = readFileSync(abs);
    } catch {
      // Deleted-in-this-commit, unreadable, or gone: unjudgeable, so allowed.
      continue;
    }
    scanned++;
    violations.push(...scanBuffer(rel, buf));
  }
  return { violations, notes, scanned };
}

/**
 * One diagnostic line per violation. The `encoding violation:` prefix is what
 * `ciguard.failureHits` recognises, so this format is load-bearing.
 * NO FILE CONTENT EVER - path, byte offset, line number, rule, cause.
 * @param {EncodingViolation} v
 * @returns {string}
 */
export function formatViolation(v) {
  return `encoding violation: ${v.file} - ${v.rule} at byte ${v.offset} (line ${v.line}, ${v.count} offending byte(s)): ${v.why}`;
}

/** How to fix each rule, printed once per report rather than per file. */
export const REMEDY = {
  'bom-in-shell-script': 'rewrite the file as UTF-8 WITHOUT a BOM (git: `sed -i \'1s/^\\xEF\\xBB\\xBF//\' <file>`)',
  'non-ascii-in-powershell': 'replace every non-ASCII character with its ASCII equivalent (em dash -> "-", smart quotes -> \' or ")',
};
