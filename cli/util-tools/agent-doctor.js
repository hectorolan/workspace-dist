// agent-doctor — verify the .claude/agents/*.md files AND .claude/skills/*/SKILL.md
// files will actually register, zero tokens for the static pass. The documented
// failure mode (.claude/agents/README.md): an unquoted frontmatter value containing
// ": " is invalid YAML and Claude Code silently drops the agent — or the skill —
// from registration. Until now the only check was a manual headless `claude -p`
// run after every edit.
// Usage:
//   node cli/util-tools/agent-doctor.js          static frontmatter checks (exit 1 on FAIL)
//   node cli/util-tools/agent-doctor.js --live   + one headless `claude -p` haiku run,
//                                                diffing registered agents + skills vs the files
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * Static frontmatter check for one agent or skill file. Deliberately zero-dep (no
 * YAML parser in this tree): it targets the exact traps known to drop registration,
 * not full YAML validation.
 * @param {string} fileBase expected `name` — the filename without .md for agents,
 *                          the skill directory name for skills
 * @param {string} content full file source
 * @returns {{name: string|null, findings: {level: 'FAIL'|'WARN', msg: string}[]}}
 */
export function checkAgentSource(fileBase, content) {
  /** @type {{level: 'FAIL'|'WARN', msg: string}[]} */
  const findings = [];
  const m = /^---\r?\n([\s\S]*?)\r?\n---(\r?\n|$)/.exec(content);
  if (!m) {
    return { name: null, findings: [{ level: 'FAIL', msg: 'no YAML frontmatter block (--- ... ---) at the top of the file' }] };
  }
  /** @type {Record<string, string>} */
  const keys = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z][\w-]*):(?:\s(.*))?$/.exec(line);
    if (!kv) {
      // Indented lines are block-scalar/nested continuations — fine. A flush-left
      // non-key line means the block is already broken.
      if (line.trim() && !/^\s/.test(line)) findings.push({ level: 'WARN', msg: `unparsed frontmatter line: '${line.trim()}'` });
      continue;
    }
    keys[kv[1]] = (kv[2] ?? '').trim();
  }
  for (const req of ['name', 'description']) {
    if (!keys[req]) findings.push({ level: 'FAIL', msg: `missing required frontmatter key '${req}'` });
  }
  if (keys.name && keys.name !== fileBase) {
    findings.push({ level: 'WARN', msg: `name '${keys.name}' does not match expected '${fileBase}'` });
  }
  for (const [k, v] of Object.entries(keys)) {
    if (!v) continue;
    if (/^(["']).*\1$/.test(v)) continue; // quoted — colon-space is safe
    if (/^["']/.test(v)) { findings.push({ level: 'FAIL', msg: `key '${k}': unbalanced quote in value` }); continue; }
    if (/^[>|]/.test(v)) continue; // block scalar header — safe
    if (v.includes(': ') || v.endsWith(':')) {
      findings.push({ level: 'FAIL', msg: `key '${k}': unquoted value contains ': ' — invalid YAML plain scalar; Claude Code silently drops the file from registration (see .claude/agents/README.md)` });
    }
  }
  return { name: keys.name || null, findings };
}

/**
 * Drift guard for .claude/README.md (the human-readable agent-system index):
 * every agent file and skill directory must appear by name in the README's
 * tables, no listed name may lack a file/dir, and every table row must have
 * exactly the header's column count (pipes inside code spans escaped as \|).
 * Pure function — no fs — so tests feed it synthetic READMEs.
 * @param {string|null} readme README source, or null when the file is missing
 * @param {{agents: string[], skills: string[]}} onDisk file-base names of agents,
 *        dir names of skills, as found on disk
 * @returns {{level: 'FAIL'|'WARN', msg: string}[]}
 */
export function checkReadmeIndex(readme, { agents, skills }) {
  /** @type {{level: 'FAIL'|'WARN', msg: string}[]} */
  const findings = [];
  if (readme == null) {
    return [{ level: 'FAIL', msg: '.claude/README.md is missing — the agent-system index is required (drift guard)' }];
  }
  const norm = String(readme).replace(/\r\n/g, '\n');

  /** First markdown table after `## <heading>`; null (with a FAIL) when absent. */
  const tableAfter = (/** @type {string} */ heading) => {
    const m = new RegExp(`^##\\s+${heading}\\b.*$`, 'm').exec(norm);
    if (!m) {
      findings.push({ level: 'FAIL', msg: `README: no '## ${heading}' section` });
      return null;
    }
    const rows = [];
    let started = false;
    for (const line of norm.slice(m.index + m[0].length).split('\n')) {
      if (/^\s*\|/.test(line)) { started = true; rows.push(line.trim()); }
      else if (started || /^##\s/.test(line)) break;
    }
    if (rows.length < 3) {
      findings.push({ level: 'FAIL', msg: `README: no table under '## ${heading}'` });
      return null;
    }
    return rows;
  };

  /** Split a table row into cells, honoring escaped pipes (\|). */
  const splitRow = (/** @type {string} */ row) => {
    const cells = row.replace(/\\\|/g, '\u0000').split('|').map((/** @type {string} */ c) => c.replace(/\u0000/g, '|').trim());
    if (cells.length && cells[0] === '') cells.shift();
    if (cells.length && cells[cells.length - 1] === '') cells.pop();
    return cells;
  };

  const checkTable = (/** @type {string} */ label, /** @type {string[]|null} */ rows, /** @type {string[]} */ expected) => {
    if (!rows) return;
    const header = splitRow(rows[0]);
    /** @type {string[]} */
    const listed = [];
    rows.forEach((/** @type {string} */ row, /** @type {number} */ i) => {
      const cells = splitRow(row);
      if (cells.length !== header.length) {
        findings.push({ level: 'FAIL', msg: `README ${label} table row ${i + 1}: ${cells.length} columns vs ${header.length} in the header — escape pipes in code spans as \\|` });
      }
      if (i >= 2 && cells[0]) listed.push(cells[0].replace(/[`*]/g, '').trim()); // skip header + separator
    });
    for (const n of expected) {
      if (!listed.includes(n)) findings.push({ level: 'FAIL', msg: `README ${label} table: '${n}' exists on disk but is not listed — update .claude/README.md` });
    }
    for (const n of listed) {
      if (!expected.includes(n)) findings.push({ level: 'FAIL', msg: `README ${label} table: '${n}' is listed but has no ${label === 'agents' ? 'agent file' : 'skill directory'} on disk — update .claude/README.md` });
    }
  };

  checkTable('agents', tableAfter('Agents'), agents);
  checkTable('skills', tableAfter('Skills'), skills);
  return findings;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  let failed = false;

  /**
   * Run the static check over a set of files and print results.
   * @param {{label: string, expectedName: string, file: string}[]} entries
   * @returns {string[]} names successfully parsed
   */
  const scan = (entries) => {
    /** @type {string[]} */
    const names = [];
    for (const e of entries) {
      const { name, findings } = checkAgentSource(e.expectedName, readFileSync(e.file, 'utf8'));
      if (name) names.push(name);
      if (findings.length === 0) {
        console.log(`OK   ${e.label.padEnd(28)} name=${name}`);
      } else {
        for (const x of findings) {
          if (x.level === 'FAIL') failed = true;
          console.log(`${x.level.padEnd(4)} ${e.label.padEnd(28)} ${x.msg}`);
        }
      }
    }
    return names;
  };

  const agentDir = path.join(ROOT, '.claude', 'agents');
  const expectedAgents = scan(
    readdirSync(agentDir)
      .filter((f) => f.endsWith('.md') && f.toLowerCase() !== 'readme.md')
      .map((f) => ({ label: f, expectedName: path.basename(f, '.md'), file: path.join(agentDir, f) })),
  );

  const skillDir = path.join(ROOT, '.claude', 'skills');
  const expectedSkills = existsSync(skillDir)
    ? scan(
        readdirSync(skillDir, { withFileTypes: true })
          .filter((d) => d.isDirectory() && existsSync(path.join(skillDir, d.name, 'SKILL.md')))
          .map((d) => ({ label: `skills/${d.name}`, expectedName: d.name, file: path.join(skillDir, d.name, 'SKILL.md') })),
      )
    : [];

  // README drift guard: the human-readable index in .claude/README.md must list
  // exactly the agent files + skill directories that exist (TP-readme-guard-*).
  {
    const readmePath = path.join(ROOT, '.claude', 'README.md');
    const agentBases = readdirSync(agentDir)
      .filter((f) => f.endsWith('.md') && f.toLowerCase() !== 'readme.md')
      .map((f) => path.basename(f, '.md'));
    const skillBases = existsSync(skillDir)
      ? readdirSync(skillDir, { withFileTypes: true })
          .filter((d) => d.isDirectory() && existsSync(path.join(skillDir, d.name, 'SKILL.md')))
          .map((d) => d.name)
      : [];
    const findings = checkReadmeIndex(existsSync(readmePath) ? readFileSync(readmePath, 'utf8') : null, {
      agents: agentBases,
      skills: skillBases,
    });
    if (findings.length === 0) {
      console.log(`OK   .claude/README.md          index matches ${agentBases.length} agents + ${skillBases.length} skills`);
    } else {
      for (const x of findings) {
        if (x.level === 'FAIL') failed = true;
        console.log(`${x.level.padEnd(4)} .claude/README.md          ${x.msg}`);
      }
    }
  }

  if (process.argv.includes('--live')) {
    // One cheap haiku run — the same verification the agents README prescribes,
    // now covering skills in the same probe.
    const cmd = 'claude -p --model haiku "List the subagent types available to your Agent tool as a single comma-separated line. Then on a second line list the names of the Skills available to you as a single comma-separated line."';
    const r = spawnSync(cmd, { encoding: 'utf8', shell: true, timeout: 300000 });
    const out = (r.stdout || '').trim();
    if (r.status !== 0 || !out) {
      failed = true;
      console.log(`FAIL live         claude -p run failed (exit ${r.status}): ${(r.stderr || out || 'no output').trim().slice(0, 200)}`);
    } else {
      const listed = new Set((out.toLowerCase().match(/[a-z][\w-]*/g) || []));
      const missingAgents = expectedAgents.filter((n) => !listed.has(n.toLowerCase()));
      const missingSkills = expectedSkills.filter((n) => !listed.has(n.toLowerCase()));
      if (missingAgents.length || missingSkills.length) {
        failed = true;
        const parts = [];
        if (missingAgents.length) parts.push(`agents NOT registered: ${missingAgents.join(', ')}`);
        if (missingSkills.length) parts.push(`skills NOT registered: ${missingSkills.join(', ')}`);
        console.log(`FAIL live         ${parts.join(' | ')} — reported: ${out.split('\n').slice(-2).join(' / ')}`);
      } else {
        console.log(`OK   live         all ${expectedAgents.length} agents + ${expectedSkills.length} skills registered`);
      }
    }
  }
  process.exit(failed ? 1 : 0);
}
