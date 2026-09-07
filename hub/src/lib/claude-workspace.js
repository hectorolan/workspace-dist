'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { renderMarkdown } = require('./render-markdown');

/**
 * Reads the workspace repo's .claude directory (agents, skills, governing docs)
 * from config.workspaceClaudeDir (WORKSPACE_CLAUDE_DIR). Read-only, live per
 * request — no caching (see central-DB test plan hn-test-plan-2026-07-22-agents-skills-pages).
 * Detail lookups validate the requested name against the actual directory
 * listing, which doubles as the path-traversal guard (TP-agents-skills-004/011).
 */

/** The governing docs surfaced as "Knowledge" pages. Fixed whitelist — never derived from input. */
const KNOWLEDGE_DOCS = [
  { slug: 'claude-md', file: 'CLAUDE.md', title: 'CLAUDE.md — workspace conventions' },
  { slug: 'setup-md', file: 'SETUP.md', title: 'SETUP.md — environment setup' },
];

/**
 * Parse the flat `key: value` YAML frontmatter used by agent/skill files.
 * Returns { meta, body }. No frontmatter block => empty meta, whole text as body.
 * Deliberately minimal (no dependency): handles quoted values and comma lists,
 * which is everything these files use (plan doc "Assumptions").
 */
function parseFrontmatter(text) {
  // Normalize CRLF first: checkouts with core.autocrlf (the Windows PC) hand us
  // CRLF files, and a stray \r would defeat the key:value regex below ($ cannot
  // cross \r) — the block's LAST line has no following \n to split it away.
  text = String(text).replace(/\r\n/g, '\n');
  const meta = {};
  if (!text.startsWith('---')) return { meta, body: text };
  const end = text.indexOf('\n---', 3);
  if (end === -1) return { meta, body: text };
  const block = text.slice(text.indexOf('\n') + 1, end);
  const lines = block.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const m = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(lines[i]);
    if (!m) continue;
    let value = m[2].trim();
    // YAML block scalars (`>`, `>-`, `|`, `|-`, `+` chomping): several real skills
    // write `description: >` — without this the value parsed as literally ">"
    // (TP-readme-summ-012). Consume the following indented lines; folded (>) joins
    // each blank-line-separated paragraph with spaces, literal (|) keeps newlines.
    const scalar = /^([>|])([+-])?$/.exec(value);
    if (scalar) {
      const collected = [];
      while (i + 1 < lines.length && (/^\s/.test(lines[i + 1]) || lines[i + 1].trim() === '')) {
        collected.push(lines[++i]); // a non-indented line = the next key, ends the block
      }
      const nonEmpty = collected.filter((l) => l.trim() !== '');
      const indent = nonEmpty.length ? Math.min(...nonEmpty.map((l) => /^[ \t]*/.exec(l)[0].length)) : 0;
      const bodyLines = collected.map((l) => (l.trim() === '' ? '' : l.slice(indent)));
      while (bodyLines.length && bodyLines[bodyLines.length - 1] === '') bodyLines.pop();
      const joined =
        scalar[1] === '>'
          ? bodyLines.join('\n').split(/\n{2,}/).map((p) => p.replace(/\n/g, ' ')).join('\n')
          : bodyLines.join('\n');
      // Chomping: `-` strips the final newline, default clips to exactly one.
      meta[m[1]] = scalar[2] === '-' || !joined ? joined : `${joined}\n`;
      continue;
    }
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
      (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
    ) {
      value = value.slice(1, -1);
    }
    meta[m[1]] = value;
  }
  const body = text.slice(end + '\n---'.length).replace(/^\r?\n/, '');
  return { meta, body };
}

/** Inline markdown → plain text: links keep their text; code spans, bold, italics unwrap. */
function stripInlineMarkdown(s) {
  return String(s)
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/(\*\*|__)([\s\S]*?)\1/g, '$2')
    .replace(/(\*|_)([\s\S]*?)\1/g, '$2')
    .trim();
}

/** Split a markdown table row on UNESCAPED pipes; `\|` becomes a literal `|` in the cell. */
function splitTableRow(line) {
  return line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split(/(?<!\\)\|/)
    .map((cell) => cell.replace(/\\\|/g, '|').trim());
}

/**
 * Curated one-line summaries from the workspace `.claude/README.md` tables — the ONE
 * home of the human-readable index text (TP-readme-summ-001; frontmatter descriptions
 * are model-routing trigger text, too noisy for a human index). Scans every markdown
 * table in the README and picks the one whose header contains `summaryHeader`
 * (case-insensitive, wherever the column sits — TP-readme-summ-004); row key = first
 * cell, markdown stripped. Missing README / no matching table => {} and callers fall
 * back to the frontmatter description (TP-readme-summ-005) — parsing never breaks a page.
 */
function readmeSummaries(claudeDir, summaryHeader) {
  let text;
  try {
    text = fs.readFileSync(path.join(claudeDir, 'README.md'), 'utf8');
  } catch {
    return {};
  }
  const lines = String(text).replace(/\r\n/g, '\n').split('\n');
  const wanted = summaryHeader.toLowerCase();
  const out = {};
  for (let i = 0; i + 1 < lines.length; i++) {
    // A table = a `|` header line followed by a `|---|` separator line.
    if (!/^\s*\|/.test(lines[i]) || !/^\s*\|?[\s:|-]*-[\s:|-]*\|?\s*$/.test(lines[i + 1])) continue;
    const header = splitTableRow(lines[i]).map((h) => stripInlineMarkdown(h).toLowerCase());
    const col = header.indexOf(wanted);
    if (col < 1) continue; // not this table (or summary would collide with the name column)
    for (i += 2; i < lines.length && /^\s*\|/.test(lines[i]); i++) {
      const cells = splitTableRow(lines[i]);
      const name = stripInlineMarkdown(cells[0] || '');
      const summary = cells[col] === undefined ? '' : stripInlineMarkdown(cells[col]);
      if (name && summary) out[name] = summary;
    }
  }
  return out;
}

/** Agent file names (without .md), sorted; README.md and non-md entries skipped. */
function agentNames(claudeDir) {
  let entries;
  try {
    entries = fs.readdirSync(path.join(claudeDir, 'agents'), { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((e) => e.isFile() && e.name.endsWith('.md') && e.name !== 'README.md')
    .map((e) => e.name.slice(0, -3))
    .sort();
}

/** List agents with their frontmatter for the index view. Missing dir => []. */
function listAgents(claudeDir) {
  // Curated "Role" cells from the README's Agents table; frontmatter description
  // is the row-less fallback (TP-readme-summ-007).
  const summaries = readmeSummaries(claudeDir, 'Role');
  return agentNames(claudeDir)
    .map((name) => {
      let text;
      try {
        text = fs.readFileSync(path.join(claudeDir, 'agents', `${name}.md`), 'utf8');
      } catch {
        return null;
      }
      const { meta } = parseFrontmatter(text);
      return {
        name,
        description: meta.description || '',
        summary: summaries[name] || meta.description || '',
        model: meta.model || '',
        tools: meta.tools || '',
      };
    })
    .filter(Boolean);
}

/** Load one agent (meta + rendered body). Unknown/invalid name => null. */
function loadAgent(claudeDir, name) {
  if (!agentNames(claudeDir).includes(name)) return null; // traversal guard
  let text;
  try {
    text = fs.readFileSync(path.join(claudeDir, 'agents', `${name}.md`), 'utf8');
  } catch {
    return null;
  }
  const { meta, body } = parseFrontmatter(text);
  return {
    name,
    description: meta.description || '',
    model: meta.model || '',
    tools: meta.tools || '',
    source: text, // full file incl. frontmatter — page-comments context (TP-page-comments-004)
    html: renderMarkdown(body), // sanitized (TP-audit-remediation-004)
  };
}

/** Skill directory names (each containing a SKILL.md), sorted. Missing dir => []. */
function skillNames(claudeDir) {
  let entries;
  try {
    entries = fs.readdirSync(path.join(claudeDir, 'skills'), { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((e) => e.isDirectory() && fs.existsSync(path.join(claudeDir, 'skills', e.name, 'SKILL.md')))
    .map((e) => e.name)
    .sort();
}

/** List skills with their frontmatter for the index view. */
function listSkills(claudeDir) {
  // Curated "What it does" cells from the README's Skills table; frontmatter
  // description is the row-less fallback (TP-readme-summ-006).
  const summaries = readmeSummaries(claudeDir, 'What it does');
  return skillNames(claudeDir)
    .map((name) => {
      let text;
      try {
        text = fs.readFileSync(path.join(claudeDir, 'skills', name, 'SKILL.md'), 'utf8');
      } catch {
        return null;
      }
      const { meta } = parseFrontmatter(text);
      // `upstream` on the index too (TP-skills-origin-001): the Skills page shows
      // an Origin column and links external entries straight to the pinned tree.
      return {
        name,
        description: meta.description || '',
        summary: summaries[name] || meta.description || '',
        upstream: skillUpstream(claudeDir, name),
      };
    })
    .filter(Boolean);
}

/**
 * Upstream provenance for a vendored skill, from the workspace's manifest
 * `.claude/skills/sources.json` (single source of truth for "ours vs external" —
 * see its `_note`). No entry / no manifest / malformed manifest => null, meaning
 * the skill is internal and the page shows no source line (TP-skill-upstream).
 */
function skillUpstream(claudeDir, name) {
  let data;
  try {
    data = JSON.parse(fs.readFileSync(path.join(claudeDir, 'skills', 'sources.json'), 'utf8'));
  } catch {
    return null; // missing or malformed manifest never breaks the page
  }
  const e = data && data.skills && typeof data.skills === 'object' ? data.skills[name] : null;
  if (!e || typeof e.repo !== 'string' || !e.repo || typeof e.path !== 'string') return null;
  const sha = typeof e.sha === 'string' ? e.sha : '';
  return {
    repo: e.repo,
    path: e.path,
    shaShort: sha.slice(0, 7),
    // Sha-pinned: the link shows exactly what is vendored, never a moving main
    // (TP-skills-origin-002). Entries without a sha degrade to main (TP-skills-origin-003).
    url: `https://github.com/${e.repo}/tree/${sha || 'main'}/${e.path}`,
  };
}

/** Load one skill (meta + rendered SKILL.md body). Unknown/invalid name => null. */
function loadSkill(claudeDir, name) {
  if (!skillNames(claudeDir).includes(name)) return null; // traversal guard
  let text;
  try {
    text = fs.readFileSync(path.join(claudeDir, 'skills', name, 'SKILL.md'), 'utf8');
  } catch {
    return null;
  }
  const { meta, body } = parseFrontmatter(text);
  // `source` = full file incl. frontmatter — page-comments context (TP-page-comments-005)
  return {
    name,
    description: meta.description || '',
    source: text,
    html: renderMarkdown(body),
    upstream: skillUpstream(claudeDir, name),
  };
}

/** Knowledge docs that actually exist on disk, for the Agents index. */
function listKnowledge(claudeDir) {
  return KNOWLEDGE_DOCS.filter((d) => fs.existsSync(path.join(claudeDir, d.file)));
}

/** Load one knowledge doc by whitelisted slug. Unknown slug/missing file => null. */
function loadKnowledge(claudeDir, slug) {
  const doc = KNOWLEDGE_DOCS.find((d) => d.slug === slug); // whitelist = traversal guard
  if (!doc) return null;
  let text;
  try {
    text = fs.readFileSync(path.join(claudeDir, doc.file), 'utf8');
  } catch {
    return null;
  }
  // `source` = the raw file — page-comments context (TP-page-comments-015);
  // the knowledge route destructures so it never reaches the browser
  // (TP-agents-skills-015).
  return { ...doc, source: text, html: renderMarkdown(text) };
}

module.exports = {
  parseFrontmatter,
  readmeSummaries,
  listAgents,
  loadAgent,
  listSkills,
  loadSkill,
  skillUpstream,
  listKnowledge,
  loadKnowledge,
};
