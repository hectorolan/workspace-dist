// TP-phase2: ws scheduler against a temp jobs.json with second-granularity crons
// (see ws plan get test-plan-phase2-scheduler)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const WS = path.join(ROOT, 'cli', 'ws.js');

/** Ownership fixture: an environments.json naming `owner`, plus the WS_ENV pair. @param {string} dir @param {string} owner */
function envsFor(dir, owner) {
  const p = path.join(dir, 'environments.json');
  writeFileSync(p, JSON.stringify({ scheduleOwner: owner, environments: {} }));
  return { WS_ENVS_CONFIG: p, WS_ENV: 'test-env' };
}

test('TP-phase2-001/002/003: arms jobs, ticks on schedule, runs boot catch-up', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'ws-sched-'));
  const tickFile = path.join(dir, 'ticks.txt');
  const catchupFile = path.join(dir, 'catchup.txt');
  /** @param {string} file @param {string} mark */
  const appender = (file, mark) =>
    `require('fs').appendFileSync(${JSON.stringify(file)}, ${JSON.stringify(mark)})`;
  const config = path.join(dir, 'jobs.json');
  writeFileSync(
    config,
    JSON.stringify({
      timezone: 'UTC',
      jobs: [
        // croner accepts 6-field (second-granularity) expressions — every second
        { name: 'tick', cron: '* * * * * *', run: [process.execPath, '-e', appender(tickFile, 'x\n')] },
        {
          name: 'catchup',
          cron: '0 0 31 2 *', // never fires on schedule (Feb 31)
          run: [process.execPath, '-e', appender(catchupFile, 'base ')],
          catchUpArgs: ['-e', appender(catchupFile, 'extra')],
        },
      ],
    }),
  );

  const child = spawn(process.execPath, [WS, 'scheduler'], {
    env: { ...process.env, WS_JOBS_CONFIG: config, SKIP_LOG_API: '1', ...envsFor(dir, 'test-env') },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  child.stdout.on('data', (d) => (out += d));
  child.stderr.on('data', (d) => (out += d));
  const exited = new Promise((r) => child.once('exit', r));

  try {
    await new Promise((r) => setTimeout(r, 2800));
    assert.equal(child.exitCode, null, `scheduler exited early:\n${out}`);
  } finally {
    child.kill();
    await exited;
  }

  assert.match(out, /armed tick \(\* \* \* \* \* \* UTC\)/);
  assert.match(out, /armed catchup/);
  assert.ok(existsSync(tickFile), 'scheduled job never ran');
  assert.ok(readFileSync(tickFile, 'utf8').length >= 2, 'expected at least 2 ticks');
  // catch-up ran once at boot with catchUpArgs appended (node -e base -e extra runs both)
  assert.ok(existsSync(catchupFile), 'catch-up never ran');
  assert.match(readFileSync(catchupFile, 'utf8'), /extra/);

  rmSync(dir, { recursive: true, force: true });
});

test('TP-phase2-004: SKIP_CATCHUP=1 suppresses boot catch-up but jobs still arm', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'ws-sched2-'));
  const catchupFile = path.join(dir, 'catchup.txt');
  const config = path.join(dir, 'jobs.json');
  writeFileSync(
    config,
    JSON.stringify({
      jobs: [
        {
          name: 'catchup',
          cron: '0 0 31 2 *',
          run: [process.execPath, '-e', '0'],
          catchUpArgs: ['-e', `require('fs').appendFileSync(${JSON.stringify(catchupFile)}, 'x')`],
        },
      ],
    }),
  );
  const child = spawn(process.execPath, [WS, 'scheduler'], {
    env: { ...process.env, WS_JOBS_CONFIG: config, SKIP_CATCHUP: '1', SKIP_LOG_API: '1', ...envsFor(dir, 'test-env') },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  child.stdout.on('data', (d) => (out += d));
  const exited = new Promise((r) => child.once('exit', r));
  try {
    await new Promise((r) => setTimeout(r, 1200));
    // never-firing pattern + keep-alive: the one clock must still be running,
    // with a loud WARN about the dead pattern (silent exit was a real bug here)
    assert.equal(child.exitCode, null, `scheduler exited early:\n${out}`);
  } finally {
    child.kill();
    await exited;
  }
  assert.match(out, /armed catchup/);
  assert.match(out, /WARN: catchup will never fire/);
  assert.ok(!existsSync(catchupFile), 'catch-up ran despite SKIP_CATCHUP=1');
  rmSync(dir, { recursive: true, force: true });
});

test('TP-envs-001: non-owner environment refuses to arm, exit 1', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'ws-own1-'));
  const config = path.join(dir, 'jobs.json');
  writeFileSync(config, JSON.stringify({ jobs: [] }));
  const child = spawn(process.execPath, [WS, 'scheduler'], {
    env: { ...process.env, WS_JOBS_CONFIG: config, SKIP_LOG_API: '1', ...envsFor(dir, 'someone-else') },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  child.stdout.on('data', (d) => (out += d));
  child.stderr.on('data', (d) => (out += d));
  const code = await new Promise((r) => child.once('exit', r));
  assert.equal(code, 1);
  assert.match(out, /not the schedule owner/);
  rmSync(dir, { recursive: true, force: true });
});

test('TP-envs-002: a pushed owner flip silences a running scheduler at the next fire', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'ws-own2-'));
  const tickFile = path.join(dir, 'ticks.txt');
  const config = path.join(dir, 'jobs.json');
  writeFileSync(
    config,
    JSON.stringify({
      jobs: [{ name: 'tick', cron: '* * * * * *', run: [process.execPath, '-e', `require('fs').appendFileSync(${JSON.stringify(tickFile)}, 'x')`] }],
    }),
  );
  const envs = envsFor(dir, 'test-env');
  const child = spawn(process.execPath, [WS, 'scheduler'], {
    env: { ...process.env, WS_JOBS_CONFIG: config, SKIP_LOG_API: '1', ...envs },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  child.stdout.on('data', (d) => (out += d));
  const exited = new Promise((r) => child.once('exit', r));
  try {
    await new Promise((r) => setTimeout(r, 1600)); // let it tick as owner
    // simulate the pulled owner flip: rewrite the environments file
    writeFileSync(envs.WS_ENVS_CONFIG, JSON.stringify({ scheduleOwner: 'new-owner', environments: {} }));
    await new Promise((r) => setTimeout(r, 1600));
  } finally {
    child.kill();
    await exited;
  }
  assert.match(out, /schedule owner: test-env — this environment, armed to run/);
  assert.match(out, /skipped — schedule owner is now 'new-owner'/);
  rmSync(dir, { recursive: true, force: true });
});

test('TP-phase2-005: disabled job is never armed nor boot-caught-up; others unaffected', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'ws-sched3-'));
  const tickFile = path.join(dir, 'ticks.txt');
  const disabledFile = path.join(dir, 'disabled.txt');
  const config = path.join(dir, 'jobs.json');
  writeFileSync(
    config,
    JSON.stringify({
      timezone: 'UTC',
      jobs: [
        { name: 'tick', cron: '* * * * * *', run: [process.execPath, '-e', `require('fs').appendFileSync(${JSON.stringify(tickFile)}, 'x')`] },
        {
          name: 'staged',
          cron: '* * * * * *', // would fire every second if armed
          disabled: true,
          run: [process.execPath, '-e', `require('fs').appendFileSync(${JSON.stringify(disabledFile)}, 'x')`],
          catchUpArgs: ['--if-missing'],
        },
      ],
    }),
  );
  const child = spawn(process.execPath, [WS, 'scheduler'], {
    env: { ...process.env, WS_JOBS_CONFIG: config, SKIP_LOG_API: '1', ...envsFor(dir, 'test-env') },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  child.stdout.on('data', (d) => (out += d));
  child.stderr.on('data', (d) => (out += d));
  const exited = new Promise((r) => child.once('exit', r));
  try {
    await new Promise((r) => setTimeout(r, 2200));
    assert.equal(child.exitCode, null, `scheduler exited early:\n${out}`);
  } finally {
    child.kill();
    await exited;
  }
  assert.match(out, /staged: disabled — not armed/);
  assert.doesNotMatch(out, /armed staged/);
  assert.match(out, /armed tick/);
  assert.ok(existsSync(tickFile), 'enabled job never ran');
  assert.ok(!existsSync(disabledFile), 'disabled job ran (armed or catch-up)');
  rmSync(dir, { recursive: true, force: true });
});

// --- self-restart (TP-ssr, ws plan get test-plan-scheduler-self-restart) --------

/** @param {string} data */
const markerIn = (data) => path.join(data, 'restart', 'restart-requested');

/** Wait until cond() or timeout. @param {() => boolean} cond @param {number} ms */
async function until(cond, ms) {
  const t0 = Date.now();
  while (!cond() && Date.now() - t0 < ms) await new Promise((r) => setTimeout(r, 50));
  return cond();
}

/** @param {string} dir @param {object} config @param {Record<string, string>} [extraEnv] */
function spawnScheduler(dir, config, extraEnv = {}) {
  const configPath = path.join(dir, 'jobs.json');
  writeFileSync(configPath, JSON.stringify(config));
  const child = spawn(process.execPath, [WS, 'scheduler'], {
    env: {
      ...process.env,
      WS_JOBS_CONFIG: configPath,
      WS_DATA_DIR: path.join(dir, 'data'),
      WS_RESTART_POLL_MS: '120',
      LOG_API_URL: 'http://127.0.0.1:1', // dead port → scripted lines land in the fallback file
      SKIP_LOG_API: '1', // API supervision has its own tests below (TP-api3)
      ...envsFor(dir, 'test-env'),
      ...extraEnv,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const state = { out: '' };
  child.stdout.on('data', (d) => (state.out += d));
  child.stderr.on('data', (d) => (state.out += d));
  return { child, state, exited: new Promise((r) => child.once('exit', r)) };
}

test('TP-ssr-012/015/016: marker consumed between fires — drain, ONE fallback line, exit 0', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'ws-ssr12-'));
  const data = path.join(dir, 'data');
  const { child, state, exited } = spawnScheduler(dir, {
    jobs: [{ name: 'never', cron: '0 0 31 2 *', run: [process.execPath, '-e', '0'] }],
  }, { SKIP_CATCHUP: '1' });
  try {
    assert.ok(await until(() => /armed never/.test(state.out), 5000), `never armed:\n${state.out}`);
    assert.equal(child.exitCode, null, `scheduler exited before the marker:\n${state.out}`);
    mkdirSync(path.dirname(markerIn(data)), { recursive: true });
    writeFileSync(markerIn(data), JSON.stringify({ flaggedAt: Date.now(), detail: 'test-reason' }));
    const code = await Promise.race([exited, new Promise((r) => setTimeout(() => r('timeout'), 8000))]);
    assert.equal(code, 0, `expected exit 0 on restart:\n${state.out}`);
  } finally {
    child.kill();
    await exited;
  }
  assert.match(state.out, /restart requested by ws pull — draining 0 running job\(s\)/);
  assert.match(state.out, /restarting to load pulled changes: test-reason/);
  assert.ok(!existsSync(markerIn(data)), 'marker must be consumed before exit');
  // TP-ssr-016: exactly one scripted `done` line (agent self-restart) via the offline fallback
  const fallback = path.join(data, 'fallback', 'log.md');
  assert.ok(existsSync(fallback), `no fallback line written:\n${state.out}`);
  const lines = readFileSync(fallback, 'utf8').trim().split('\n');
  assert.equal(lines.length, 1, `expected ONE restart line, got:\n${lines.join('\n')}`);
  assert.match(lines[0], /scheduler \| done \| scheduler drained and restarted .*test-reason/);
  // TP-ssr-015 (boot half): the baseline was stamped to the workspace's HEAD at boot
  const stamped = readFileSync(path.join(data, 'restart', 'last-checked'), 'utf8').trim();
  assert.match(stamped, /^[0-9a-f]{40}$/);
  rmSync(dir, { recursive: true, force: true });
});

test('TP-ssr-013: drain semantics — running job finishes, new fires are refused, then restart', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'ws-ssr13-'));
  const data = path.join(dir, 'data');
  const { child, state, exited } = spawnScheduler(dir, {
    jobs: [{ name: 'longjob', cron: '* * * * * *', run: [process.execPath, '-e', 'setTimeout(() => {}, 2500)'] }],
  }, { SKIP_CATCHUP: '1' });
  let code;
  try {
    assert.ok(await until(() => /longjob: start/.test(state.out), 5000), `longjob never started:\n${state.out}`);
    mkdirSync(path.dirname(markerIn(data)), { recursive: true });
    writeFileSync(markerIn(data), JSON.stringify({ detail: 'drain-test' }));
    code = await Promise.race([exited, new Promise((r) => setTimeout(() => r('timeout'), 10000))]);
  } finally {
    child.kill();
    await exited;
  }
  assert.equal(code, 0, `expected exit 0 after drain:\n${state.out}`);
  assert.match(state.out, /restart requested by ws pull — draining 1 running job\(s\)/);
  assert.match(state.out, /longjob: skipped — restart pending \(draining\)/, 'a fire during the drain must be refused');
  const exitAt = state.out.indexOf('longjob: exit');
  const restartAt = state.out.indexOf('restarting to load pulled changes');
  assert.ok(exitAt !== -1 && restartAt !== -1 && exitAt < restartAt,
    `restart must wait for the running job (never mid-job):\n${state.out}`);
  rmSync(dir, { recursive: true, force: true });
});

test('TP-ssr-014: stale marker at boot is cleared — no exit, no boot loop', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'ws-ssr14-'));
  const data = path.join(dir, 'data');
  mkdirSync(path.dirname(markerIn(data)), { recursive: true });
  writeFileSync(markerIn(data), JSON.stringify({ detail: 'stale' }));
  const { child, state, exited } = spawnScheduler(dir, {
    jobs: [{ name: 'never', cron: '0 0 31 2 *', run: [process.execPath, '-e', '0'] }],
  }, { SKIP_CATCHUP: '1' });
  try {
    assert.ok(await until(() => /stale restart marker cleared at boot/.test(state.out), 5000), state.out);
    await new Promise((r) => setTimeout(r, 700)); // several poll intervals
    assert.equal(child.exitCode, null, `scheduler exited on a stale marker:\n${state.out}`);
    assert.ok(!existsSync(markerIn(data)), 'stale marker not cleared');
  } finally {
    child.kill();
    await exited;
  }
  rmSync(dir, { recursive: true, force: true });
});

test('TP-ssr-017/018: catch-up defaults — runJob block implies --if-missing; catchUp:false and explicit catchUpArgs override', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'ws-ssr17-'));
  /** @param {string} name */
  const dumpFile = (name) => path.join(dir, `${name}.txt`);
  /** @param {string} name */
  const dump = (name) =>
    `require('fs').writeFileSync(${JSON.stringify(dumpFile(name))}, process.argv.join(' '))`;
  const never = '0 0 31 2 *';
  const rj = { output: 'x/{date}.md', prompt: 'p' };
  // '--' so the appended catch-up args reach process.argv instead of node's own
  // option parser (real jobs are `ws run-job <name>` — plain positional args).
  const { child, state, exited } = spawnScheduler(dir, {
    jobs: [
      { name: 'a', cron: never, run: [process.execPath, '-e', dump('a'), '--'], runJob: rj },
      { name: 'b', cron: never, run: [process.execPath, '-e', dump('b'), '--'], runJob: rj, catchUp: false },
      { name: 'c', cron: never, run: [process.execPath, '-e', dump('c'), '--'], runJob: rj, catchUpArgs: ['--custom'] },
      { name: 'd', cron: never, run: [process.execPath, '-e', dump('d'), '--'] },
      { name: 'e', cron: never, run: [process.execPath, '-e', dump('e'), '--'], runJob: rj, disabled: true },
    ],
  });
  try {
    assert.ok(await until(() => existsSync(dumpFile('a')) && existsSync(dumpFile('c')), 5000),
      `catch-up runs missing:\n${state.out}`);
    await new Promise((r) => setTimeout(r, 400)); // grace for any wrong extra runs
  } finally {
    child.kill();
    await exited;
  }
  assert.match(readFileSync(dumpFile('a'), 'utf8'), /--if-missing/, 'runJob-block job must default to --if-missing catch-up');
  assert.match(readFileSync(dumpFile('c'), 'utf8'), /--custom/, 'explicit catchUpArgs must win');
  assert.doesNotMatch(readFileSync(dumpFile('c'), 'utf8'), /--if-missing/);
  assert.ok(!existsSync(dumpFile('b')), 'catchUp:false must suppress the default');
  assert.ok(!existsSync(dumpFile('d')), 'no runJob block, no catchUpArgs → no catch-up');
  assert.ok(!existsSync(dumpFile('e')), 'disabled job must never catch up');
  rmSync(dir, { recursive: true, force: true });
});

// --- log API supervision (TP-api3, backlog 3 — see ws plan get
// test-plan-obs-pair-api-supervision). Probe/adopt semantics: correct both with the
// old baked entrypoint (which backgrounds server/start.sh) and with the updated one
// (scheduler spawns the server itself).

import { EventEmitter } from 'node:events';
import net from 'node:net';
import { superviseLogApi } from '../util/scheduler.js';
import { portOpen } from '../util/tunnel.js';

class FakeChild extends EventEmitter {
  constructor() {
    super();
    /** @type {number|null} */
    this.exitCode = null;
    this.killed = false;
  }
  kill() {
    this.killed = true;
    this.exitCode = 0;
    this.emit('exit', 0);
    return true;
  }
}

/** A throwaway API-host root: has server/server.js, no environments.json (no tunnel). */
function apiRoot() {
  const root = mkdtempSync(path.join(tmpdir(), 'ws-api-'));
  mkdirSync(path.join(root, 'server'), { recursive: true });
  writeFileSync(path.join(root, 'server', 'server.js'), '// placeholder — tests inject spawnServer');
  return root;
}

/** @param {Record<string, unknown>} [over] */
function apiHarness(over = {}) {
  const state = {
    bound: false,
    /** @type {FakeChild[]} */ spawns: [],
    /** @type {Array<Record<string, unknown>>} */ logs: [],
    /** @type {string[]} */ lines: [],
  };
  const sup = superviseLogApi(/** @type {any} */ ({
    root: apiRoot(),
    log: (/** @type {string} */ l) => state.lines.push(l),
    env: {},
    probe: async () => state.bound,
    spawnServer: async () => {
      const c = new FakeChild();
      state.spawns.push(c);
      state.bound = true;
      c.on('exit', () => { state.bound = false; });
      return c;
    },
    apiLog: async (/** @type {Record<string, unknown>} */ e) => { state.logs.push(e); },
    pollMs: 20,
    graceMs: 80,
    backoffMs: 10,
    maxBackoffMs: 40,
    ...over,
  }));
  return { sup, state, out: () => state.lines.join('\n') };
}

test('TP-api3-001: gates — SKIP_LOG_API, tunnel-configured environment, missing server → supervision off', () => {
  /** @type {string[]} */
  const lines = [];
  const log = (/** @type {string} */ l) => lines.push(l);
  assert.equal(superviseLogApi({ root: apiRoot(), log, env: { SKIP_LOG_API: '1' } }), null);
  assert.match(lines.join('\n'), /supervision off \(SKIP_LOG_API=1\)/);
  // A tunnel-configured environment is a client, never the API host.
  const tunneled = apiRoot();
  mkdirSync(path.join(tunneled, 'configs'), { recursive: true });
  writeFileSync(path.join(tunneled, 'configs', 'environments.json'), JSON.stringify({
    environments: { 'api-gate-test-env': { logApiTunnel: { sshTarget: 'user@host' } } },
  }));
  const prev = process.env.WS_ENV;
  process.env.WS_ENV = 'api-gate-test-env';
  try {
    assert.equal(superviseLogApi({ root: tunneled, log, env: {} }), null);
  } finally {
    if (prev === undefined) delete process.env.WS_ENV;
    else process.env.WS_ENV = prev;
  }
  assert.match(lines.join('\n'), /supervision off \(this environment reaches the API over a tunnel/);
  // No server code at all (a bare root).
  const bare = mkdtempSync(path.join(tmpdir(), 'ws-api-bare-'));
  assert.equal(superviseLogApi({ root: bare, log, env: {} }), null);
  assert.match(lines.join('\n'), /supervision off \(no server at/);
});

test('TP-api3-002: adopt — an already-listening server is adopted, never fought', async () => {
  const { sup, state, out } = apiHarness({
    spawnServer: async () => { throw new Error('must not spawn while the external server serves'); },
  });
  state.bound = true; // external server (old entrypoint's start.sh) already listening
  try {
    assert.ok(await until(() => /log-api: adopted/.test(out()), 3000), out());
    await new Promise((r) => setTimeout(r, 150)); // several poll cycles
    assert.equal(state.spawns.length, 0);
    assert.doesNotMatch(out(), /spawn failed|starting server/);
  } finally {
    sup?.stop();
  }
});

test('TP-api3-005: boot race — a server that binds within the grace window is adopted, no bind fight', async () => {
  const { sup, state, out } = apiHarness({ graceMs: 2000 });
  setTimeout(() => { state.bound = true; }, 60); // the entrypoint's copy finishes binding
  try {
    assert.ok(await until(() => /log-api: adopted/.test(out()), 3000), out());
    assert.equal(state.spawns.length, 0, 'must not spawn during the boot grace');
  } finally {
    sup?.stop();
  }
});

test('TP-api3-006/007: first-ever spawn logs NOTHING; stop() kills the supervised child', async () => {
  const { sup, state, out } = apiHarness();
  try {
    assert.ok(await until(() => /log-api: serving on/.test(out()), 3000), out());
    assert.equal(state.spawns.length, 1);
    assert.equal(state.logs.length, 0, 'a normal boot start is not a recovery — no central line');
  } finally {
    sup?.stop();
  }
  assert.equal(state.spawns[0].killed, true, 'shutdown must kill the managed child');
});

test('TP-api3-003: takeover — adopted server goes away → replacement spawned + ONE api-watch recovery line', async () => {
  const { sup, state, out } = apiHarness();
  state.bound = true; // external first
  try {
    assert.ok(await until(() => /log-api: adopted/.test(out()), 3000), out());
    state.bound = false; // the entrypoint-started server crashed
    assert.ok(await until(() => state.logs.length === 1, 3000), out());
    assert.equal(state.spawns.length, 1);
    const line = state.logs[0];
    assert.equal(line.area, 'log-api');
    assert.equal(line.status, 'done');
    assert.equal(line.agent, 'api-watch');
    assert.match(String(line.message), /log API restarted by the scheduler/);
    assert.match(String(line.message), /previously-adopted server went away/);
  } finally {
    sup?.stop();
  }
});

test('TP-api3-004: crash respawn with backoff — second recovery inside the window is rate-limited', async () => {
  const { sup, state, out } = apiHarness();
  state.bound = true; // external first, so every child spawn is a recovery
  try {
    assert.ok(await until(() => /log-api: adopted/.test(out()), 3000), out());
    state.bound = false;
    assert.ok(await until(() => state.logs.length === 1, 3000), out()); // first recovery logged
    // Crash our child: exit(1) → respawn after capped backoff.
    const c = state.spawns[0];
    c.exitCode = 1;
    c.emit('exit', 1);
    assert.ok(await until(() => state.spawns.length === 2 && /rate-limited/.test(out()), 3000), out());
    assert.equal(state.logs.length, 1, 'the flap must not write a second central line');
    assert.match(out(), /next attempt in \d+ms/);
  } finally {
    sup?.stop();
  }
});

test('TP-api3-008: E2E — ws scheduler adopts an external listener, takes over when it dies, drain kills the child', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'ws-api-e2e-'));
  const data = path.join(dir, 'data');
  // The "old entrypoint's" server: a listener owned by the test process.
  const external = net.createServer();
  await new Promise((r) => external.listen(0, '127.0.0.1', () => r(undefined)));
  const port = /** @type {import('node:net').AddressInfo} */ (external.address()).port;
  // Stub API server the supervisor spawns via the WS_API_SERVER seam (CJS, temp dir).
  const stub = path.join(dir, 'stub-server.js');
  writeFileSync(stub, [
    "const net = require('net');",
    'const s = net.createServer();',
    "s.listen(Number(process.env.LOG_API_PORT), '127.0.0.1');",
    'setTimeout(() => process.exit(0), 30000); // safety net if never killed',
  ].join('\n'));
  const { child, state, exited } = spawnScheduler(dir, { jobs: [] }, {
    SKIP_CATCHUP: '1',
    SKIP_LOG_API: '', // re-enable: the helper disables supervision for the older tests
    WS_API_SERVER: stub,
    LOG_API_PORT: String(port),
    WS_API_POLL_MS: '50',
    WS_API_BOOT_GRACE_MS: '200',
  });
  /** @param {() => Promise<boolean>} cond @param {number} ms */
  const untilAsync = async (cond, ms) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      if (await cond()) return true;
      await new Promise((r) => setTimeout(r, 100));
    }
    return cond();
  };
  let code;
  try {
    assert.ok(await until(() => /log-api: adopted/.test(state.out), 8000), state.out);
    await new Promise((r) => external.close(() => r(undefined))); // the adopted server dies
    assert.ok(await until(() => /log-api: serving on/.test(state.out), 8000), state.out);
    assert.equal(await portOpen(port), true, 'the replacement must actually serve');
    // Recovery line rode the offline fallback (LOG_API_URL points at a dead port).
    const fallback = path.join(data, 'fallback', 'log.md');
    assert.ok(await untilAsync(async () => existsSync(fallback), 5000), state.out);
    assert.match(readFileSync(fallback, 'utf8'), /log-api \| done \| log API restarted by the scheduler/);
    // Graceful drain (signal-free, Windows-safe): the managed child dies with the scheduler.
    mkdirSync(path.dirname(markerIn(data)), { recursive: true });
    writeFileSync(markerIn(data), JSON.stringify({ detail: 'api-e2e' }));
    code = await Promise.race([exited, new Promise((r) => setTimeout(() => r('timeout'), 10000))]);
    assert.equal(code, 0, `expected drain exit 0:\n${state.out}`);
    assert.ok(await untilAsync(async () => !(await portOpen(port)), 5000),
      'the supervised server must be killed on shutdown');
  } finally {
    child.kill();
    await exited;
    external.close();
  }
  rmSync(dir, { recursive: true, force: true });
});
