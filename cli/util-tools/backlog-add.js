#!/usr/bin/env node
/**
 * backlog-add — append one item to a DB plan's section without loading the plan
 * into an agent's context (the CLAUDE.md "every pending item lands in the backlog
 * plan" standing rule otherwise costs a full plan read + rewrite by hand; this
 * makes it one call). Reads the plan through the shared apiclient, inserts the
 * bullet at the END of the named heading's section, writes it back, and prints
 * only what it did.
 *
 * usage:
 *   node cli/util-tools/backlog-add.js "<item text>" [--heading "<heading>"] [--slug <slug>] [-a <agent>]
 *
 *   --heading    heading to append under (substring match, case-insensitive).
 *                Default: "Awaiting" — the awaiting-the-CEO section.
 *   --slug       plan slug (default: backlog)
 *   --stdin-line read the item text from stdin INSTEAD of the positional arg
 *                (shell-proof for quote-bearing or long items — argv embedded
 *                double quotes are mangled on Windows PowerShell; hazard doc:
 *                cli/README.md, plan-edit row). Giving both is a usage error.
 *   --dry-run    print the insertion point and the line, write nothing
 *   -h, --help   print usage and exit
 *
 * The item is written verbatim as a `- ` bullet if it does not already start with
 * a list marker, so callers control their own `RESOLVED YYYY-MM-DD` / `awaiting`
 * prefixes (the standing rule owns that grammar, not this tool).
 */
import { planGet, planSet } from '../util/apiclient.js';

const USAGE =
  'usage: backlog-add.js "<item text>" [--heading "<h>"] [--slug <slug>] [-a <agent>] [--stdin-line] [--dry-run]\n' +
  '  --stdin-line: item text comes from stdin INSTEAD of the positional arg ' +
  '(use for quote-bearing or long items — argv is shell-mangled on Windows)';

/**
 * @param {string[]} argv
 * @returns {{text: string, heading: string, slug: string, agent: string, stdinLine: boolean, dryRun: boolean, help: boolean}}
 */
function parseArgs(argv) {
  const out = { text: '', heading: 'Awaiting', slug: 'backlog', agent: '', stdinLine: false, dryRun: false, help: false };
  /** @type {string[]} */
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--heading') out.heading = argv[++i];
    else if (a === '--slug') out.slug = argv[++i];
    else if (a === '-a' || a === '--agent') out.agent = argv[++i];
    else if (a === '--stdin-line') out.stdinLine = true;
    else if (a === '--dry-run') out.dryRun = true;
    else if (a === '-h' || a === '--help') out.help = true;
    else rest.push(a);
  }
  out.text = rest.join(' ').trim();
  return out;
}

/**
 * All of stdin as one item line: CRLF normalized, whitespace trimmed. The
 * shell-proof source for embedded-quote content (see --stdin-line above).
 * @returns {Promise<string>}
 */
async function readStdinLine() {
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  // Strip a UTF-8 BOM first — PowerShell pipes prepend one to native stdin.
  return Buffer.concat(chunks).toString('utf8').replace(/^﻿/, '').replace(/\r\n/g, '\n').trim();
}

/**
 * Strip the CLI's `# slug | kind | status | date | title` metadata header line.
 * @param {string} text
 * @returns {string}
 */
function stripHeader(text) {
  const lines = text.split('\n');
  if (/^# \S+ \| \S+ \| \S+ \|/.test(lines[0] || '')) {
    let i = 1;
    while (i < lines.length && lines[i].trim() === '') i++;
    return lines.slice(i).join('\n');
  }
  return text;
}

/**
 * Insert `bullet` at the end of the section introduced by the first heading
 * matching `heading`. The section ends at the next heading of the same or higher
 * level; trailing blank lines are skipped so the bullet joins the list, not the gap.
 * @param {string} body
 * @param {string} heading
 * @param {string} bullet
 * @returns {{body: string, heading: string, line: number}}
 */
export function insertUnderHeading(body, heading, bullet) {
  const lines = body.split('\n');
  const needle = heading.toLowerCase();
  let start = -1;
  let level = 0;
  for (let i = 0; i < lines.length; i++) {
    const m = /^(#{1,6})\s+(.*)$/.exec(lines[i]);
    if (m && m[2].toLowerCase().includes(needle)) {
      start = i;
      level = m[1].length;
      break;
    }
  }
  if (start === -1) throw new Error(`heading not found: "${heading}"`);

  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    const m = /^(#{1,6})\s+/.exec(lines[i]);
    if (m && m[1].length <= level) {
      end = i;
      break;
    }
  }
  let at = end;
  while (at > start + 1 && lines[at - 1].trim() === '') at--;

  const out = [...lines.slice(0, at), bullet, ...lines.slice(at)];
  return { body: out.join('\n'), heading: lines[start].replace(/^#+\s*/, ''), line: at + 1 };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(USAGE);
    return;
  }
  if (args.stdinLine) {
    if (args.text) { // both sources is ambiguous — refuse, like plan-edit
      console.error('backlog-add: --stdin-line and a positional item text are mutually exclusive');
      console.error(USAGE);
      process.exit(2);
    }
    args.text = await readStdinLine();
  }
  if (!args.text) {
    console.error(USAGE);
    process.exit(2);
  }
  // An unknown leading `--flag` would otherwise be joined into the item text and
  // written to the plan verbatim — which is how `--help` once landed as a real
  // backlog bullet (2026-08-17). Only the FIRST word is checked: the standing rule
  // requires items to quote their source `ws ... --flags` command, so flag-shaped
  // words mid-text are legitimate content, not mistyped options.
  const stray = /^--?[A-Za-z]/.test(args.text.split(/\s+/)[0] || '') ? args.text.split(/\s+/)[0] : '';
  if (stray) {
    console.error(`backlog-add: unknown option "${stray}" — item text must not begin with a flag`);
    console.error(USAGE);
    process.exit(2);
  }
  const bullet = /^\s*([-*+]|\d+\.)\s/.test(args.text) ? args.text : `- ${args.text}`;

  // Normalize CRLF defensively: a Windows-side editor that round-trips the plan
  // can poison the body with \r\n, and a trailing \r breaks `$`-anchored line
  // regexes (JS `.` refuses \r) — bit this tool live on 2026-08-15.
  const raw = (await planGet(args.slug)).replace(/\r\n/g, '\n');
  const body = stripHeader(raw);
  const { body: next, heading, line } = insertUnderHeading(body, args.heading, bullet);

  if (args.dryRun) {
    console.log(`[dry-run] ${args.slug}: would insert at line ${line} under "${heading}"`);
    console.log(bullet);
    return;
  }
  await planSet(args.slug, { body: next, agent: args.agent || undefined });
  console.log(`${args.slug}: appended under "${heading}" (line ${line})`);
  console.log(bullet);
}

main().catch((err) => {
  console.error(`backlog-add failed: ${err.message}`);
  process.exit(1);
});
