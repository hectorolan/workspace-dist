// TP-ceo: the CEO's identity as config rather than a hardcoded name
// (plan `ws plan get test-plan-ceo-config`).
//
// Scope: the read path and the regex alternation it feeds. The consumers'
// behaviour (CEO block lead line, "Needs <CEO>" heading, the human-hold test)
// is asserted in planclose.test.js / prwatch.test.js against the REAL configured
// name, so a rename that breaks them fails there too.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ceo, ceoName, ceoPattern, reset, DEFAULT_CEO_NAME, DEFAULT_HUB_TITLE, ROLE_WORDS } from '../util/ceo.js';

/** A throwaway workspace root carrying one configs/environments.json. @param {any} cfg */
function rootWith(cfg) {
  const dir = mkdtempSync(path.join(tmpdir(), 'ws-ceo-'));
  mkdirSync(path.join(dir, 'configs'), { recursive: true });
  if (cfg !== undefined) {
    writeFileSync(path.join(dir, 'configs', 'environments.json'),
      typeof cfg === 'string' ? cfg : JSON.stringify(cfg), 'utf8');
  }
  return dir;
}

test('TP-ceo-001: the name comes from configs/environments.json, not from code', () => {
  const dir = rootWith({ ceo: { name: 'Ana', pronouns: 'she/her' } });
  try {
    assert.deepEqual(ceo(dir), { name: 'Ana', pronouns: 'she/her', hubTitle: DEFAULT_HUB_TITLE });
    assert.equal(ceoName(dir), 'Ana');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('TP-hubident-004: hubTitle comes from config and degrades to the generic default when unset', () => {
  const named = rootWith({ ceo: { name: 'Ana', pronouns: 'she/her', hubTitle: 'Ana Ops' } });
  const unnamed = rootWith({ ceo: { name: 'Ana', pronouns: 'she/her' } });
  const blank = rootWith({ ceo: { name: 'Ana', hubTitle: '   ' } });
  try {
    assert.equal(ceo(named).hubTitle, 'Ana Ops');
    assert.equal(ceo(unnamed).hubTitle, DEFAULT_HUB_TITLE);
    assert.equal(ceo(blank).hubTitle, DEFAULT_HUB_TITLE, 'whitespace-only falls back rather than a blank brand');
    assert.equal(ceo(named).name, 'Ana', 'name behavior unchanged by the widened shape');
  } finally {
    for (const d of [named, unnamed, blank]) rmSync(d, { recursive: true, force: true });
  }
});

test('TP-ceo-002: an unset name degrades to the generic role label, never to a guess', () => {
  // Unlike mail identity (smtp.js refuses to send without OWNER_EMAIL, because a
  // wrong address silently mails the wrong human), a missing display name has no
  // blast radius — "the CEO" is readable and obviously unconfigured.
  const dir = rootWith({ scheduleOwner: 'azure-vm' });
  try {
    assert.equal(ceoName(dir), DEFAULT_CEO_NAME);
    assert.equal(ceo(dir).pronouns, 'they/them');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('TP-ceo-003: a missing or malformed config never throws — the defaults stand', () => {
  const missing = rootWith(undefined);
  const broken = rootWith('{ this is not json');
  try {
    assert.equal(ceoName(missing), DEFAULT_CEO_NAME);
    assert.equal(ceoName(broken), DEFAULT_CEO_NAME);
  } finally {
    rmSync(missing, { recursive: true, force: true });
    rmSync(broken, { recursive: true, force: true });
  }
});

test('TP-ceo-004: blank / non-string values fall back rather than producing an empty name', () => {
  const dir = rootWith({ ceo: { name: '   ', pronouns: 42 } });
  try {
    assert.equal(ceoName(dir), DEFAULT_CEO_NAME);
    assert.equal(ceo(dir).pronouns, 'they/them');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('TP-ceo-005: the pattern matches the configured name AND the generic role words', () => {
  const dir = rootWith({ ceo: { name: 'Ana' } });
  try {
    const re = new RegExp(`\\b(?:${ceoPattern(dir)})\\b`, 'i');
    assert.ok(re.test('needs Ana to confirm'));
    for (const w of ROLE_WORDS) assert.ok(re.test(`waiting on the ${w}`), `role word ${w}`);
    assert.ok(!re.test('waiting on the build'));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('TP-ceo-006: a plan written under the OLD name still resolves after a rename', () => {
  // The reason role words are in the pattern at all: renaming the CEO must not
  // silently orphan every "Needs <old name>" section already sitting in the DB.
  // The generic words keep those plans readable; the old personal name does not
  // survive, which is correct — it now belongs to nobody.
  const dir = rootWith({ ceo: { name: 'Ana' } });
  try {
    const re = new RegExp(`^#{1,6}\\s*needs?\\s+(?:the\\s+)?(?:${ceoPattern(dir)})\\b`, 'i');
    assert.ok(re.test('## Needs the CEO'));
    assert.ok(re.test('## Needs CEO'));
    assert.ok(re.test('## Needs owner'));
    assert.ok(re.test('## Needs Ana'));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('TP-ceo-007: a multi-word name contributes only its distinctive words — "the" never matches everything', () => {
  const dir = rootWith({ ceo: { name: 'the CEO' } });
  try {
    const re = new RegExp(`\\b(?:${ceoPattern(dir)})\\b`, 'i');
    assert.ok(!re.test('the build is red'), 'a bare "the" must not match');
    assert.ok(re.test('waiting on the CEO'));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('TP-ceo-008: regex metacharacters in a name are escaped, not interpreted', () => {
  const dir = rootWith({ ceo: { name: 'A.C' } });
  try {
    const re = new RegExp(`\\b(?:${ceoPattern(dir)})\\b`, 'i');
    assert.ok(re.test('ask A.C about it'));
    assert.ok(!re.test('ask AXC about it'), 'the dot must be literal');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('TP-ceo-009: the live repo config resolves — the shipped environments.json really carries a ceo block', () => {
  reset();
  const name = ceoName();
  assert.ok(name && name.trim(), 'a name resolves');
  // Whatever it is, the consumers must be able to build a working matcher from it.
  assert.doesNotThrow(() => new RegExp(`\\b(?:${ceoPattern()})\\b`, 'i'));
});
