// Fixture hygiene: no source or test line may form a token-shaped literal.
// The distribution exporter vendors this repo's source tree and fails its
// release on any key-shaped line (workspace docs/distribution.md, decision D3),
// so a fixture that needs a token-shaped VALUE must build it by concatenation
// (see test/features.test.js / test/stations.test.js). This guard catches the
// next such literal here in CI, instead of at export time in another repo.
// Reporting rule: file + line NUMBER only, never the line text.
import { test } from 'node:test';
import assert from 'node:assert';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Mirrors the workspace manifest's guards.secretPatterns (configs/distribution.json).
const PATTERNS = [
  /ghp_[A-Za-z0-9]{20,}/,
  /github_pat_[A-Za-z0-9_]{20,}/,
  /sk-ant-[A-Za-z0-9-]{20,}/,
  /AKIA[0-9A-Z]{16}/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /xox[bpa]-[A-Za-z0-9-]{10,}/,
];

/** @param {string} dir @returns {string[]} repo-relative file paths */
function walk(dir) {
  const out = [];
  for (const e of readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
    const rel = `${dir}/${e.name}`;
    if (e.isDirectory()) out.push(...walk(rel));
    else if (/\.(m?js|jsx|json|md)$/.test(e.name)) out.push(rel);
  }
  return out;
}

// @plan:hub-fixture-hygiene-2026-09-07 @promote
test('TP-hub-fixture-hygiene-001: no line in test/, e2e/, src/, or client/src/ forms a token-shaped literal', () => {
  const findings = [];
  for (const dir of ['test', 'e2e', 'src', 'client/src']) {
    for (const file of walk(dir)) {
      readFileSync(path.join(ROOT, file), 'utf8').split(/\r?\n/).forEach((line, i) => {
        if (PATTERNS.some((re) => re.test(line))) findings.push(`${file}:${i + 1}`);
      });
    }
  }
  assert.deepStrictEqual(findings, [], `token-shaped line(s) at: ${findings.join(', ')}`);
});

// @plan:hub-fixture-hygiene-2026-09-07 @promote
test('TP-hub-fixture-hygiene-002: the concatenated fixtures still produce a runtime ghp_-prefixed value (the redaction proofs stay meaningful)', () => {
  const value = ['ghp', 'SECRETSECRETSECRETSECRET1234567890ab'].join('_');
  assert.ok(PATTERNS[0].test(value), 'the joined fixture value must still look like a token at runtime');
});
