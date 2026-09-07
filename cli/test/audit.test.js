// TP-plan-integrity (audit half): the never-silent audit write
// (`ws plan get test-plan-plan-write-integrity`). A scripted writer that has
// already changed state must never lose its log line without saying so.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { audit, auditFailureFile } from '../util/audit.js';

const ENTRY = { repo: 'workspace', area: 'plan-close', status: 'done', message: 'test-plan x closed', agent: 'plan-close' };

/** Run `fn` with console.error captured. @param {() => Promise<any>} fn */
async function captureErr(fn) {
  const real = console.error;
  /** @type {string[]} */
  const lines = [];
  console.error = (/** @type {any[]} */ ...args) => { lines.push(args.join(' ')); };
  try {
    const value = await fn();
    return { value, lines };
  } finally {
    console.error = real;
  }
}

const tmpSink = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ws-audit-')), 'audit-failures.md');

test('TP-plan-integrity-022: a healthy log write returns ok, prints nothing and writes no failure file', async () => {
  const sink = tmpSink();
  const { value, lines } = await captureErr(() =>
    audit(ENTRY, { log: async () => ({ ok: true, line: 'stored' }), sink }));
  assert.deepEqual(value, { ok: true, line: 'stored' });
  assert.deepEqual(lines, []);
  assert.equal(fs.existsSync(sink), false);
});

test('TP-plan-integrity-023: an unreachable API is noted but not treated as a hole — the offline queue already has it', async () => {
  const sink = tmpSink();
  const { value, lines } = await captureErr(() =>
    audit(ENTRY, { log: async () => ({ ok: false, fallback: '/data/fallback/log.md' }), sink }));
  assert.equal(value.ok, false);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /log API unreachable/);
  assert.match(lines[0], /fallback\/log\.md/);
  // NOT the failure sink: ws pull replays fallback/log.md, so nothing is lost.
  assert.equal(fs.existsSync(sink), false);
  assert.doesNotMatch(lines[0], /AUDIT WRITE FAILED/);
});

test('TP-plan-integrity-024: a thrown log write is loud and durable, and audit() never throws', async () => {
  const sink = tmpSink();
  const { value, lines } = await captureErr(() =>
    audit(ENTRY, { log: async () => { throw new Error('disk on fire'); }, sink }));
  assert.equal(value.ok, false);
  assert.match(lines[0], /AUDIT WRITE FAILED \(disk on fire\)/);
  assert.match(lines[0], /test-plan x closed/);
  const written = fs.readFileSync(sink, 'utf8');
  assert.match(written, /^\d{4}-\d{2}-\d{2} \| plan-close \| done \| test-plan x closed$/m);

  // …and when the durable write ALSO fails, the console line is the last resort
  // rather than an exception thrown back into a caller that already acted.
  const unwritable = path.join(sink, 'nested', 'x.md'); // sink is a file, not a dir
  const second = await captureErr(() =>
    audit(ENTRY, { log: async () => { throw new Error('boom'); }, sink: unwritable }));
  assert.equal(second.value.ok, false);
  assert.match(second.lines[0], /AUDIT WRITE FAILED/);
  assert.match(second.lines[1], /could not be written either/);
});

test('TP-plan-integrity-024: the failure sink lives in the data dir, never in git', () => {
  const prev = process.env.WS_DATA_DIR;
  process.env.WS_DATA_DIR = path.join(os.tmpdir(), 'ws-data-probe');
  try {
    assert.equal(auditFailureFile(), path.join(os.tmpdir(), 'ws-data-probe', 'fallback', 'audit-failures.md'));
  } finally {
    if (prev === undefined) delete process.env.WS_DATA_DIR; else process.env.WS_DATA_DIR = prev;
  }
});
