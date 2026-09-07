// TP-retired-repos: the portfolio sweep hides retired projects without deleting
// their history (plan `ws plan get coinbase-trader-retirement` is the first case).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { dropRetiredBlocks, retiredRepos } from '../util/repos.js';

// This checkout's root. workspaceDir() falls back to ~/sources/workspace, which only
// exists on a dev PC — CI clones elsewhere, so the shipped-config test pins it here.
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const SUMMARY = [
  '## coinbase-trader',
  'last: 2026-07-20 | coinbase-trader | feat/backtest | done | closing stale PR-open status',
  'counts (7d): done=108, PR-open=2',
  '',
  '## ho-nexus',
  'last: 2026-07-24 | ho-nexus | deploy | done | auto-deploy live',
  'counts (7d): done=36, PR-open=24',
  'attention:',
  '  2026-07-24 | ho-nexus | ui | PR-open | conversation archiving',
  '',
  '## workspace',
  'last: 2026-07-25 | workspace | backup | done | logs.sql pushed',
  'counts (7d): done=12',
  '',
].join('\n');

test('TP-retired-repos-001: a retired repo\'s whole block is dropped, others untouched', () => {
  const out = dropRetiredBlocks(SUMMARY, ['coinbase-trader']);
  assert.ok(!out.includes('coinbase-trader'), 'no trace of the retired repo remains');
  assert.ok(out.includes('## ho-nexus'), 'live repos survive');
  assert.ok(out.includes('## workspace'));
  assert.ok(out.includes('attention:'), 'multi-line blocks keep their extra lines');
  assert.ok(out.startsWith('## ho-nexus'), 'leading block removal leaves no blank prefix');
});

test('TP-retired-repos-002: empty retired list is a pass-through (no reformatting)', () => {
  assert.equal(dropRetiredBlocks(SUMMARY, []), SUMMARY);
  assert.equal(dropRetiredBlocks('', ['coinbase-trader']), '');
});

test('TP-retired-repos-003: only exact repo names match — no substring collateral', () => {
  const text = '## nexus\nlast: a\n\n## mobile-nexus\nlast: b\n';
  const out = dropRetiredBlocks(text, ['nexus']);
  assert.ok(out.includes('## mobile-nexus'), 'mobile-nexus is not "nexus"');
  assert.ok(!out.includes('## nexus\n'), 'the exact match is gone');
});

test('TP-retired-repos-004: retiredRepos reads the shipped config', () => {
  const prev = process.env.WORKSPACE_DIR;
  process.env.WORKSPACE_DIR = REPO_ROOT;
  try {
    const retired = retiredRepos();
    assert.ok(Array.isArray(retired));
    assert.ok(retired.includes('coinbase-trader'), 'coinbase-trader retired 2026-07-19');
  } finally {
    if (prev === undefined) delete process.env.WORKSPACE_DIR;
    else process.env.WORKSPACE_DIR = prev;
  }
});
