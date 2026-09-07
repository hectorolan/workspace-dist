// agent-doctor static checks — pins the registration traps from
// .claude/agents/README.md (the 2026-07-16→17 silent-drop incident).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkAgentSource, checkReadmeIndex } from '../util-tools/agent-doctor.js';

const fm = (/** @type {string} */ body) => `---\n${body}\n---\n\nAgent body.\n`;

test('AD-001 clean quoted description with colon-space passes', () => {
  const { name, findings } = checkAgentSource('coo', fm('name: coo\ndescription: "The operator: owns the pipeline. Use for: money."\nmodel: fable'));
  assert.equal(name, 'coo');
  assert.deepEqual(findings, []);
});

test('AD-002 unquoted description containing colon-space FAILs (the silent-drop trap)', () => {
  const { findings } = checkAgentSource('devops', fm('name: devops\ndescription: Handles CI: builds and deploys.'));
  assert.ok(findings.some((f) => f.level === 'FAIL' && f.msg.includes("': '")));
});

test('AD-003 unquoted description without colon-space is clean', () => {
  const { findings } = checkAgentSource('devops', fm('name: devops\ndescription: Handles testing, CI, builds, and deployment tasks.\ntools: Read, Bash\nmodel: opus'));
  assert.deepEqual(findings, []);
});

test('AD-004 missing frontmatter block FAILs', () => {
  const { name, findings } = checkAgentSource('x', '# not an agent file\n');
  assert.equal(name, null);
  assert.equal(findings[0].level, 'FAIL');
});

test('AD-005 missing required keys FAIL', () => {
  const { findings } = checkAgentSource('x', fm('model: sonnet'));
  const msgs = findings.filter((f) => f.level === 'FAIL').map((f) => f.msg);
  assert.ok(msgs.some((s) => s.includes("'name'")));
  assert.ok(msgs.some((s) => s.includes("'description'")));
});

test('AD-006 name/expected-name mismatch WARNs', () => {
  const { findings } = checkAgentSource('newsroom', fm('name: news\ndescription: Writes the digest.'));
  assert.ok(findings.some((f) => f.level === 'WARN' && f.msg.includes('does not match expected')));
});

test('AD-007 block scalars and indented continuations are safe', () => {
  const { findings } = checkAgentSource('a', fm('name: a\ndescription: >-\n  long text: with colon-space inside\n  more lines'));
  assert.deepEqual(findings, []);
});

test('AD-008 unbalanced quote FAILs', () => {
  const { findings } = checkAgentSource('a', fm('name: a\ndescription: "starts quoted but never closes'));
  assert.ok(findings.some((f) => f.level === 'FAIL' && f.msg.includes('unbalanced')));
});


// README drift guard (checkReadmeIndex) — central-DB test plan
// ws-test-plan-2026-07-26-claude-readme-guard.
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const README = (/** @type {string[]} */ agentsRows, /** @type {string[]} */ skillsRows) => [
  '# index',
  '',
  '## Agents',
  '',
  '| Agent | Model | Role |',
  '|---|---|---|',
  ...agentsRows,
  '',
  '## Skills',
  '',
  '| Skill | Origin | What it does |',
  '|---|---|---|',
  ...skillsRows,
  '',
].join('\n');

const AGENTS = ['coo', 'devops'];
const SKILLS = ['daily-digest', 'jest-skill'];
const GOOD = README(
  ['| `coo` | fable | Business. |', '| `devops` | opus | CI. |'],
  ['| `daily-digest` | workspace | Digest. |', '| `jest-skill` | external | Jest. |'],
);

test('TP-readme-guard-001 README matching disk exactly yields zero findings', () => {
  assert.deepEqual(checkReadmeIndex(GOOD, { agents: AGENTS, skills: SKILLS }), []);
});

test('TP-readme-guard-002 agent on disk missing from README FAILs', () => {
  const findings = checkReadmeIndex(GOOD, { agents: [...AGENTS, 'newsroom'], skills: SKILLS });
  assert.ok(findings.some((x) => x.level === 'FAIL' && x.msg.includes("'newsroom'") && x.msg.includes('not listed')));
});

test('TP-readme-guard-003 skill dir on disk missing from README FAILs', () => {
  const findings = checkReadmeIndex(GOOD, { agents: AGENTS, skills: [...SKILLS, 'webapp-testing'] });
  assert.ok(findings.some((x) => x.level === 'FAIL' && x.msg.includes("'webapp-testing'") && x.msg.includes('not listed')));
});

test('TP-readme-guard-004 README listing a ghost name with no file/dir FAILs', () => {
  const findings = checkReadmeIndex(GOOD, { agents: AGENTS, skills: SKILLS.slice(0, 1) });
  assert.ok(findings.some((x) => x.level === 'FAIL' && x.msg.includes("'jest-skill'") && x.msg.includes('no skill directory')));
});

test('TP-readme-guard-005 ragged table row FAILs the column-consistency check', () => {
  const bad = README(
    ['| `coo` | fable | Business. |', '| `devops` | opus |'],
    ['| `daily-digest` | workspace | Digest. |', '| `jest-skill` | external | Jest. |'],
  );
  const findings = checkReadmeIndex(bad, { agents: AGENTS, skills: SKILLS });
  assert.ok(findings.some((x) => x.level === 'FAIL' && x.msg.includes('columns')));
});

test('TP-readme-guard-006 escaped pipes in code spans do not break column counting', () => {
  const esc = README(
    ['| `coo` | fable | Runs `a \\| b` pipelines. |', '| `devops` | opus | CI. |'],
    ['| `daily-digest` | workspace | Digest. |', '| `jest-skill` | external | Jest. |'],
  );
  assert.deepEqual(checkReadmeIndex(esc, { agents: AGENTS, skills: SKILLS }), []);
});

test('TP-readme-guard-007 missing README FAILs', () => {
  const findings = checkReadmeIndex(null, { agents: AGENTS, skills: SKILLS });
  assert.equal(findings.length, 1);
  assert.equal(findings[0].level, 'FAIL');
  assert.match(findings[0].msg, /missing/);
});

test('TP-readme-guard-008 the real .claude/README.md matches the real agents/ and skills/ (drift alarm)', () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
  const agentDir = path.join(root, '.claude', 'agents');
  const skillDir = path.join(root, '.claude', 'skills');
  const agents = readdirSync(agentDir).filter((x) => x.endsWith('.md') && x.toLowerCase() !== 'readme.md').map((x) => x.slice(0, -3));
  const skills = readdirSync(skillDir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && existsSync(path.join(skillDir, d.name, 'SKILL.md')))
    .map((d) => d.name);
  const readmePath = path.join(root, '.claude', 'README.md');
  const readme = existsSync(readmePath) ? readFileSync(readmePath, 'utf8') : null;
  assert.deepEqual(checkReadmeIndex(readme, { agents, skills }), []);
});
