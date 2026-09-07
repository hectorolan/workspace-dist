// TP-probe: the external-tool probe and its platform split
// (plan `ws plan get test-plan-probe-dep0190`).
//
// Why this exists: Node 24 prints DEP0190 for `spawnSync(cmd, argv, { shell: true })` —
// observed on the VM once per `ws pull` tick, 2026-08-01. env-doctor and
// station-bootstrap each had their own copy of that call; both now delegate here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { probe, winQuote, winCommandLine } from '../util/probe.js';

/**
 * A spawn seam that records how it was called and returns a canned result.
 * @param {{status: number|null, stdout?: string, stderr?: string, error?: Error}} [result]
 */
function fakeSpawn(result = { status: 0, stdout: 'ok', stderr: '' }) {
  /** @type {any[][]} */
  const calls = [];
  // `any`: the fake returns only the fields probe() reads, not a full SpawnSyncReturns.
  /** @type {any} */
  const spawn = (/** @type {any[]} */ ...args) => { calls.push(args); return result; };
  return { spawn, calls };
}

test('TP-probe-001: on POSIX there is no shell at all — argv goes as a real vector', () => {
  // The strongest form: nothing is re-parsed, so the deprecation cannot apply and
  // neither can argument injection.
  const f = fakeSpawn();
  probe('gh', ['pr', 'list', '--json', 'number'], { platform: 'linux', spawn: f.spawn });
  const [cmd, argv, opts] = f.calls[0];
  assert.equal(cmd, 'gh');
  assert.deepEqual(argv, ['pr', 'list', '--json', 'number']);
  assert.ok(!('shell' in opts), 'no shell option on POSIX');
});

test('TP-probe-002: on Windows a shell is used, but NEVER alongside an args array (this is DEP0190)', () => {
  // Windows needs a shell because gh/az/claude are .cmd shims Node refuses to spawn
  // directly. What must not happen is handing Node argv AND shell:true — that is the
  // deprecated combination that concatenates without escaping.
  const f = fakeSpawn();
  probe('gh', ['pr', 'list'], { platform: 'win32', spawn: f.spawn });
  const [cmdline, opts] = f.calls[0];
  assert.equal(f.calls[0].length, 2, 'exactly two args — no argv array');
  assert.equal(typeof cmdline, 'string');
  assert.equal(cmdline, 'gh pr list');
  assert.equal(opts.shell, true);
});

test('TP-probe-003: tokens needing quoting are quoted, inert ones are left bare', () => {
  assert.equal(winQuote('gh'), 'gh');
  assert.equal(winQuote('--json'), '--json');
  assert.equal(winQuote('C:\\Program'), 'C:\\Program');
  assert.equal(winQuote('a b'), '"a b"');
  assert.equal(winQuote(''), '""');
  assert.match(winQuote('say "hi"'), /^".*"$/);
  assert.ok(winQuote('say "hi"').includes('\\"'), 'embedded quotes are escaped');
});

test('TP-probe-004: a command line with spaces stays one quoted token per argument', () => {
  const line = winCommandLine('claude', ['-p', 'list the agents', '--model', 'haiku']);
  assert.equal(line, 'claude -p "list the agents" --model haiku');
});

test('TP-probe-005: a missing binary or timeout is ok:false, never a throw', () => {
  // Every call site checks `.ok`; probe must not make them handle exceptions.
  const f = fakeSpawn({ status: null, error: new Error('ENOENT'), stdout: '', stderr: '' });
  const r = probe('definitely-not-a-real-binary', ['--version'], { platform: 'linux', spawn: f.spawn });
  assert.equal(r.ok, false);
  assert.equal(r.status, null);
});

test('TP-probe-006: stdout and stderr are combined and trimmed', () => {
  const f = fakeSpawn({ status: 0, stdout: 'out\n', stderr: 'err\n' });
  const r = probe('x', [], { platform: 'linux', spawn: f.spawn });
  assert.equal(r.ok, true);
  assert.equal(r.out, ['out', 'err'].join('\n'), 'joined as-is; trim only strips the ends');
});

test('TP-probe-007: cwd is forwarded only when given (station-bootstrap passes one, env-doctor does not)', () => {
  const a = fakeSpawn();
  probe('git', ['status'], { platform: 'linux', spawn: a.spawn });
  assert.ok(!('cwd' in a.calls[0][2]), 'absent when not requested');
  const b = fakeSpawn();
  probe('git', ['status'], { platform: 'linux', cwd: '/tmp/x', spawn: b.spawn });
  assert.equal(b.calls[0][2].cwd, '/tmp/x');
});

test('TP-probe-008: a REAL probe runs on this platform and reports the node version', () => {
  // One unfaked call, so the platform branch is exercised for real rather than only
  // through the seam — this is the line that would have caught DEP0190.
  const r = probe(process.execPath, ['--version']);
  assert.equal(r.ok, true);
  assert.match(r.out, /^v\d+\.\d+\.\d+/);
});
