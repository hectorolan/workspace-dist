// encoding-check - the script-encoding guard as a one-call check, zero tokens.
//
// Same rules and same module as the `ws sync` ci-guard (cli/util/encoding.js), so
// there is exactly one standard:
//   * shell scripts (.sh/.bash/.zsh/.ksh and extensionless shebang scripts) must have
//     NO byte-order mark - bash reads it as part of the first command and the error
//     echoes the expanded line (this leaked a token on 2026-07-28);
//   * .ps1/.psm1/.psd1 must be pure ASCII (zero bytes > 127) - Windows PowerShell 5.1
//     reads a BOM-less file as ANSI, turning a UTF-8 em dash into a smart quote that
//     PowerShell honours as a string delimiter.
//
// Usage:
//   node cli/util-tools/encoding-check.js            every git-tracked file (what CI runs)
//   node cli/util-tools/encoding-check.js --staged   only the staged files
//   node cli/util-tools/encoding-check.js <path>...  only those paths
//   node cli/util-tools/encoding-check.js --json     machine-readable findings
//
// Exit 0 = clean, 1 = violation found, 2 = could not enumerate files.
// It REPORTS; it never rewrites a file, and it never prints the offending line.
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { scanFiles, formatViolation, REMEDY } from '../util/encoding.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * @param {string[]} argv
 * @returns {string[]} repo-relative paths to consider
 */
function collect(argv) {
  const explicit = argv.filter((a) => !a.startsWith('--'));
  if (explicit.length) return explicit;
  const args = argv.includes('--staged')
    ? ['diff', '--cached', '--name-only']
    : ['ls-files'];
  const out = execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  return out.split('\n').filter(Boolean);
}

const argv = process.argv.slice(2);
const asJson = argv.includes('--json');

let files;
try {
  files = collect(argv);
} catch (e) {
  console.error(`encoding-check: could not list files (${e instanceof Error ? e.message : e})`);
  process.exit(2);
}

const { violations, notes, scanned } = scanFiles(ROOT, files);

if (asJson) {
  console.log(JSON.stringify({ scanned, violations, notes }, null, 2));
} else {
  for (const n of notes) console.log(`encoding-check: note - ${n}`);
  for (const v of violations) console.error(formatViolation(v));
  if (violations.length) {
    console.error('');
    for (const rule of [...new Set(violations.map((v) => v.rule))]) {
      console.error(`fix (${rule}): ${REMEDY[rule]}`);
    }
    console.error('');
    console.error(`encoding-check: ${violations.length} violation(s) in ${scanned} scanned file(s).`);
  } else {
    console.log(`encoding-check: OK - ${scanned} script file(s) scanned, no violations.`);
  }
}

process.exit(violations.length ? 1 : 0);
