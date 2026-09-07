// TP-docs-truth: proof of the docs-truth audit remediation (audit
// `ws plan get docs-truth-audit-2026-08-27`, remediation test plan
// `ws plan get docs-truth-remediation-2026-08-28`). Grep-style guards in the
// pipeline-retirement pattern: assertions name the file and the stale string,
// never the surrounding line.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (/** @type {string} */ rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

test('TP-docs-truth-003: no workspace-authored skill hardcodes the owner email (CEO-is-config)', () => {
  const sources = JSON.parse(read('.claude/skills/sources.json'));
  const vendored = new Set(Object.keys(sources.skills));
  const skillsDir = path.join(ROOT, '.claude/skills');
  for (const dir of fs.readdirSync(skillsDir)) {
    if (vendored.has(dir)) continue; // upstream content is not ours to reword
    const skillMd = path.join(skillsDir, dir, 'SKILL.md');
    if (!fs.existsSync(skillMd)) continue;
    const text = fs.readFileSync(skillMd, 'utf8');
    assert.ok(!/olanhector@gmail\.com/i.test(text),
      `.claude/skills/${dir}/SKILL.md hardcodes the owner address — OWNER_EMAIL/AGENT_EMAIL own that fact in env`);
  }
});
