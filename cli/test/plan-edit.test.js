// TP-plan-edit: plan-edit util-tool edit logic + CLI guards (see ws plan get test-plan-plan-edit-tool)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { stripPlanHeader, replaceLine, appendToSection } from '../util-tools/plan-edit.mjs';

const TOOL = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'util-tools', 'plan-edit.mjs');

/** @param {string[]} args @param {string} [input] */
function run(args, input) {
  return spawnSync(process.execPath, [TOOL, ...args], { encoding: 'utf8', input });
}

test('TP-plan-edit-001: stripPlanHeader removes header + blank + trailing newline, body-leading # heading survives', () => {
  const served = '# my-slug | plan | active | 2026-07-26 | My title\n\n# Real Heading\n\ntext\n';
  assert.equal(stripPlanHeader(served), '# Real Heading\n\ntext');
});

test('TP-plan-edit-002: stripPlanHeader passes non-headered text through unchanged', () => {
  for (const text of ['# Just a heading\n\nbody', 'plain text', '']) {
    assert.equal(stripPlanHeader(text), text);
  }
});

test('TP-plan-edit-003: replaceLine swaps exactly the one matching line', () => {
  const body = 'alpha\n- item one\n- item two\nomega';
  assert.equal(replaceLine(body, 'item one', '- item one DONE'), 'alpha\n- item one DONE\n- item two\nomega');
});

test('TP-plan-edit-004: replaceLine with 0 matches throws naming the count', () => {
  assert.throws(() => replaceLine('a\nb', 'zzz', 'x'), /matched 0 lines/);
});

test('TP-plan-edit-005: replaceLine with 2 matches throws naming the count (revisions-64/65 failure mode)', () => {
  assert.throws(() => replaceLine('item x\nitem y', 'item', 'x'), /matched 2 lines.*lines 1, 2/);
});

test('TP-plan-edit-006: appendToSection inserts after last non-blank line of the section, before the next heading', () => {
  const body = '# Doc\n\n## Alpha\n\n- a1\n\n## Beta\n\n- b1';
  assert.equal(
    appendToSection(body, 'Alpha', '- a2'),
    '# Doc\n\n## Alpha\n\n- a1\n- a2\n\n## Beta\n\n- b1',
  );
  // subsections (deeper level) stay inside the section
  const nested = '## Alpha\n\n### Sub\n\n- s1\n\n## Beta';
  assert.equal(appendToSection(nested, 'Alpha', '- tail'), '## Alpha\n\n### Sub\n\n- s1\n- tail\n\n## Beta');
});

test('TP-plan-edit-007: appendToSection handles the final section (EOF) and an empty section', () => {
  assert.equal(appendToSection('## Last\n\n- x', 'Last', '- y'), '## Last\n\n- x\n- y');
  assert.equal(appendToSection('## Empty\n\n## Next\n- n', 'Empty', '- first'), '## Empty\n- first\n\n## Next\n- n');
});

test('TP-plan-edit-008: appendToSection throws on 0 and on ambiguous heading matches', () => {
  assert.throws(() => appendToSection('## A\n- x', 'Nope', '- y'), /matched 0 headings/);
  assert.throws(() => appendToSection('## Plan A\n## Plan B', 'Plan', '- y'), /matched 2 headings/);
});

test('TP-plan-edit-009: CLI guards — no slug, no mode, two modes, or missing pair flag exit 2 with usage', () => {
  const bad = [
    [],                                              // no slug, no mode
    ['my-slug'],                                     // no mode
    ['my-slug', '--replace-line', 'x', '--with', 'y', '--stdin-body'], // two modes
    ['my-slug', '--replace-line', 'x'],              // missing --with
    ['my-slug', '--append-to-section', 'H'],         // missing --line
  ];
  for (const args of bad) {
    const r = run(args, '');
    assert.equal(r.status, 2, args.join(' '));
    assert.match(r.stderr, /usage: node cli\/util-tools\/plan-edit\.mjs/);
  }
});

test('TP-plan-edit-010: CLI --stdin-body --dry-run echoes the piped body verbatim, no API needed', () => {
  const body = '# New body\n\n- fresh line\n';
  const r = run(['any-slug', '--stdin-body', '--dry-run'], body);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, body);
  assert.match(r.stderr, /dry-run — nothing written/);
});
