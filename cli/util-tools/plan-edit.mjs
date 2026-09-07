#!/usr/bin/env node
// plan-edit — deterministic single-edit on a central-DB plan (backlog 39's
// most-hit forge candidate). Replaces the hand-rolled fetch → strip header →
// edit → `ws plan set` dance and its known failure mode: an ambiguous line
// replace landing on the wrong line (the tracker near-miss, plan revisions 64-65).
//
// usage: node cli/util-tools/plan-edit.mjs <slug> <mode> [--agent <a>] [--dry-run]
//   --replace-line "<unique substring>" --with "<new line>"   fail on 0 or >1 matches
//   --append-to-section "<heading>" --line "<md line>"        heading match must be unique
//   --stdin-body                                              full body replace from stdin
//   --stdin-line                                              with --replace-line/--append-to-section:
//                                                             the new line comes from stdin instead of
//                                                             --with/--line (shell-proof for content with
//                                                             embedded quotes — see cli/README.md hazard)
//
// Reads/writes ONLY via the shared client (planGet/planSet — never reimplements
// API calls); planSet snapshots a revision server-side and has NO offline
// fallback, so a failed write is loud and nothing is saved. --dry-run prints
// the resulting body to stdout and writes nothing.
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { planGet, planSet } from '../util/index.js';

const USAGE =
  'usage: node cli/util-tools/plan-edit.mjs <slug> ' +
  '(--replace-line "<unique substring>" --with "<new line>" | ' +
  '--append-to-section "<heading>" --line "<md line>" | --stdin-body) ' +
  '[--stdin-line] [--agent <a>] [--dry-run]\n' +
  '  --stdin-line: the new line comes from stdin INSTEAD of --with/--line ' +
  '(use for quote-bearing or long content — argv is shell-mangled on Windows)';

// `GET /plan/:slug` returns `# <slug> | <kind> | <status> | <yyyy-mm-dd> | <title>\n\n<body>\n`.
const HEADER_RE = /^# \S+ \| \S+ \| \S+ \| \d{4}-\d{2}-\d{2} \| .*$/;

/**
 * Recover the stored body from a `ws plan get` / planGet response: drop the
 * index-header line, the one blank separator, and the one trailing newline the
 * server appends. Text without that header passes through unchanged.
 * @param {string} text
 * @returns {string}
 */
export function stripPlanHeader(text) {
  const nl = text.indexOf('\n');
  const first = nl === -1 ? text : text.slice(0, nl);
  if (!HEADER_RE.test(first)) return text;
  let body = nl === -1 ? '' : text.slice(nl + 1);
  if (body.startsWith('\n')) body = body.slice(1); // the blank separator
  if (body.endsWith('\n')) body = body.slice(0, -1); // the appended trailing newline
  return body;
}

/**
 * Replace THE line containing `substring` with `newLine`; throws unless exactly
 * one line matches (the 0/>1 guard is the whole point of the tool).
 * @param {string} body
 * @param {string} substring
 * @param {string} newLine
 * @returns {string}
 */
export function replaceLine(body, substring, newLine) {
  const lines = body.split('\n');
  const hits = lines.reduce((/** @type {number[]} */ a, l, i) => (l.includes(substring) ? [...a, i] : a), []);
  if (hits.length !== 1) {
    throw new Error(
      `--replace-line matched ${hits.length} lines (need exactly 1) for substring: ${substring}` +
      (hits.length ? ` — lines ${hits.map((i) => i + 1).join(', ')}` : ''),
    );
  }
  lines[hits[0]] = newLine;
  return lines.join('\n');
}

/**
 * Append `newLine` to the section under the unique `#`-heading containing
 * `heading`: after the section's last non-blank line, before the next heading
 * of the same or higher level (blank separation preserved).
 * @param {string} body
 * @param {string} heading
 * @param {string} newLine
 * @returns {string}
 */
export function appendToSection(body, heading, newLine) {
  const lines = body.split('\n');
  const isHeading = (/** @type {string} */ l) => /^#{1,6} /.test(l);
  const hits = lines.reduce(
    (/** @type {number[]} */ a, l, i) => (isHeading(l) && l.includes(heading) ? [...a, i] : a),
    [],
  );
  if (hits.length !== 1) {
    throw new Error(`--append-to-section matched ${hits.length} headings (need exactly 1) for: ${heading}`);
  }
  const start = hits[0];
  const level = /** @type {RegExpMatchArray} */ (lines[start].match(/^#+/))[0].length;
  let end = lines.length; // exclusive section end
  for (let i = start + 1; i < lines.length; i++) {
    const m = lines[i].match(/^(#{1,6}) /);
    if (m && m[1].length <= level) { end = i; break; }
  }
  let insertAfter = start; // empty section → right after the heading
  for (let i = end - 1; i > start; i--) {
    if (lines[i].trim() !== '') { insertAfter = i; break; }
  }
  lines.splice(insertAfter + 1, 0, newLine);
  return lines.join('\n');
}

/** @returns {Promise<number>} */
async function main() {
  const { values, positionals } = parseArgs({
    args: process.argv.slice(2),
    allowPositionals: true,
    options: {
      'replace-line': { type: 'string' },
      with: { type: 'string' },
      'append-to-section': { type: 'string' },
      line: { type: 'string' },
      'stdin-body': { type: 'boolean' },
      'stdin-line': { type: 'boolean' },
      agent: { type: 'string' },
      'dry-run': { type: 'boolean' },
    },
  });
  const slug = positionals[0];
  const stdinLine = values['stdin-line'] === true;
  const modes = [
    values['replace-line'] !== undefined,
    values['append-to-section'] !== undefined,
    values['stdin-body'] === true,
  ].filter(Boolean).length;
  // --stdin-line replaces --with/--line as the content SOURCE for the two
  // line-edit modes (it is not a mode itself). Supplying both sources is
  // ambiguous, and pairing it with --stdin-body is meaningless — both exit 2.
  if (!slug || modes !== 1 ||
      (stdinLine && (values['stdin-body'] === true || values.with !== undefined || values.line !== undefined)) ||
      (!stdinLine && values['replace-line'] !== undefined && values.with === undefined) ||
      (!stdinLine && values['append-to-section'] !== undefined && values.line === undefined)) {
    console.error(USAGE);
    return 2;
  }

  /** Read all of stdin; strip a UTF-8 BOM (PowerShell pipes prepend one),
   *  normalize CRLF, drop the one trailing newline. */
  async function readStdin() {
    const chunks = [];
    for await (const c of process.stdin) chunks.push(c);
    let text = Buffer.concat(chunks).toString('utf8')
      .replace(/^﻿/, '')
      .replace(/\r\n/g, '\n');
    if (text.endsWith('\n')) text = text.slice(0, -1); // symmetric with stripPlanHeader
    return text;
  }

  let body;
  if (values['stdin-body']) {
    body = await readStdin();
  } else {
    const newLine = stdinLine
      ? await readStdin()
      : /** @type {string} */ (values['replace-line'] !== undefined ? values.with : values.line);
    const current = stripPlanHeader(await planGet(slug));
    body = values['replace-line'] !== undefined
      ? replaceLine(current, values['replace-line'], newLine)
      : appendToSection(current, /** @type {string} */ (values['append-to-section']), newLine);
  }

  if (values['dry-run']) {
    process.stdout.write(body + '\n');
    console.error(`plan-edit: dry-run — nothing written for '${slug}'`);
    return 0;
  }
  const { line } = await planSet(slug, { body, agent: values.agent });
  console.log(`plan-edit: updated ${line}`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  // process.exitCode (not process.exit): a hard exit races libuv handle
  // teardown on Windows (observed: async.c assertion crash after a successful
  // write); letting the loop drain exits cleanly with the same code.
  main().then(
    (code) => { process.exitCode = code; },
    (e) => {
      console.error(`plan-edit: FAILED — ${e instanceof Error ? e.message : e}. Nothing was saved.`);
      process.exitCode = 1;
    },
  );
}
