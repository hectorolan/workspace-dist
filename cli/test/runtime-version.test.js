// Runtime-version coherence + the node:sqlite API surface the log API depends on.
// Plan: `ws plan get test-plan-node24-image` (container base Node 22 -> Node 24;
// the same assertions carried the Node 24 -> 26 move on 2026-08-15).
//
// Why this file exists: SYSTEM.md used to record a *known, accepted mismatch* —
// production ran Node 22 while `@types/node` was ^24, so typecheck could approve an
// API the container did not have. The mismatch is gone; TP-node24-007 is what stops
// it coming back silently, since a typings bump ahead of the image now fails here
// instead of on the VM at 3am. The case IDs keep their `node24` prefix as stable
// identifiers — they assert coherence with whatever major the Dockerfile pins, which
// is read from the Dockerfile itself, never hardcoded.
//
// The node:sqlite cases are not ceremony: it is an *experimental* built-in whose API
// has moved across majors, and it backs the entire audit trail (log, plans, messages,
// stations). A silent change there costs every station its API and takes the scheduler
// with it, so the surface server.js actually uses is pinned by assertion.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (/** @type {string[]} */ ...p) => readFileSync(path.join(ROOT, ...p), 'utf8');
const json = (/** @type {string[]} */ ...p) => JSON.parse(read(...p));

/** The Node major the production container is built on — the number everything else tracks. */
function imageMajor() {
  const from = /^FROM\s+node:(\d+)-\S+\s*$/m.exec(read('Dockerfile'));
  assert.ok(from, 'Dockerfile has no pinned `FROM node:<major>-<variant>` line');
  return Number(from[1]);
}

/**
 * Remove a temp dir without letting Windows' lazy release of a just-closed sqlite
 * handle (EPERM/EBUSY) fail an otherwise-passing test — cleanup is hygiene, not the
 * assertion, and the OS reaps the temp dir regardless.
 * @param {string} dir
 */
const cleanup = (dir) => {
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  } catch {
    /* temp dir; the OS will reap it */
  }
};

/** First major mentioned in a semver-ish range, e.g. ">=24" / "^24.0.0" / ">= 18". */
const firstMajor = (/** @type {string} */ range) => {
  const m = /(\d+)/.exec(range);
  return m ? Number(m[1]) : NaN;
};

// ---------------------------------------------------------------------------
// Version coherence: Dockerfile is the source of truth, everything tracks it.
// ---------------------------------------------------------------------------

test('TP-node24-006: the Dockerfile pins a node:<major>-bookworm-slim base and engines.node agrees', () => {
  const major = imageMajor();
  assert.match(read('Dockerfile'), /^FROM node:\d+-bookworm-slim\s*$/m, 'base image must stay a pinned slim tag');
  assert.ok(major >= 24, `container base is Node ${major}; the upgrade to 24 is expected to hold`);

  const engines = json('package.json').engines?.node;
  assert.ok(engines, 'package.json must declare engines.node');
  assert.equal(
    firstMajor(engines),
    major,
    `engines.node is "${engines}" but the image is Node ${major} — the declared floor must match what production runs`,
  );
});

test('TP-node24-007: @types/node never resolves ahead of the container image major', () => {
  const major = imageMajor();
  const declared = json('package.json').devDependencies?.['@types/node'];
  assert.ok(declared, 'package.json must declare @types/node');
  assert.ok(
    firstMajor(declared) <= major,
    `@types/node is "${declared}" but the container runs Node ${major}. Typings ahead of the runtime is exactly the ` +
      'hazard this guard exists for: typecheck would approve a node: API production does not have. ' +
      'Move the Dockerfile base first, then the typings.',
  );

  // ...and the installed copy, not just the declared range, since that is what tsc reads.
  const installedPath = path.join(ROOT, 'node_modules', '@types', 'node', 'package.json');
  if (existsSync(installedPath)) {
    const installed = JSON.parse(readFileSync(installedPath, 'utf8')).version;
    assert.ok(
      firstMajor(installed) <= major,
      `installed @types/node ${installed} is ahead of the Node ${major} container image`,
    );
  }
});

test('TP-node24-005: the suite runs on a Node major at or above the one production runs', () => {
  const running = Number(process.versions.node.split('.')[0]);
  assert.ok(
    running >= imageMajor(),
    `tests are running on Node ${running} but production runs Node ${imageMajor()} — ` +
      'testing below production means green here proves nothing there',
  );
});

test('TP-node24-008: every direct runtime dependency admits the container image major', () => {
  const major = imageMajor();
  /** @type {Record<string,string>} */
  const deps = { ...json('cli', 'package.json').dependencies, ...json('server', 'package.json').dependencies };
  const names = Object.keys(deps);
  assert.ok(names.length >= 5, `expected the runtime deps to still be declared, saw ${names.length}`);

  for (const name of names) {
    const pkgPath = ['node_modules', 'cli/node_modules', 'server/node_modules']
      .map((base) => path.join(ROOT, base, name, 'package.json'))
      .find((p) => existsSync(p));
    if (!pkgPath) continue; // not installed in this checkout; npm ci in CI covers it
    const range = JSON.parse(readFileSync(pkgPath, 'utf8')).engines?.node;
    if (!range) continue; // no constraint declared = every major admitted

    // A range is satisfied when ANY `||` clause admits our major.
    const ok = range.split('||').some((/** @type {string} */ clause) => {
      const lower = [...clause.matchAll(/(?:>=|\^)\s*(\d+)/g)].map((m) => Number(m[1]));
      const upper = [...clause.matchAll(/<\s*(\d+)/g)].map((m) => Number(m[1]));
      return lower.every((n) => major >= n) && upper.every((n) => major < n);
    });
    assert.ok(ok, `${name} declares engines.node "${range}", which does not admit Node ${major}`);
  }
});

test('TP-node24-009: SYSTEM.md records one Node runtime and no mismatch', () => {
  const row = read('SYSTEM.md')
    .split('\n')
    .find((l) => l.startsWith('| Node runtimes |'));
  assert.ok(row, 'SYSTEM.md Components table must still carry a Node runtimes row');
  assert.doesNotMatch(
    row,
    /mismatch/i,
    'the Node runtime mismatch is resolved — the row must state current truth, not a softened note',
  );
  assert.match(row, new RegExp(`node:${imageMajor()}-bookworm-slim`), 'the row must name the actual image tag');
});

// ---------------------------------------------------------------------------
// node:sqlite — the experimental built-in the whole audit trail sits on.
// ---------------------------------------------------------------------------

test('TP-node24-001: node:sqlite loads unflagged, so the --experimental-sqlite probes resolve to no flags', () => {
  // The identical probe run by server/start.sh, the container entrypoint,
  // cli/util/backup.js and cli/util/scheduler.js. If this ever fails, those all
  // start passing --experimental-sqlite instead — still correct, but it means the
  // built-in moved back behind a flag and the comments there are wrong.
  execFileSync(process.execPath, ['-e', "require('node:sqlite')"], { stdio: 'ignore' });
});

test('TP-node24-004: the node:sqlite API surface server.js depends on behaves as expected', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'ws-sqlite24-'));
  const dbPath = path.join(dir, 'probe.db');
  try {
    const db = new DatabaseSync(dbPath);

    // Boot schema: server.js creates its tables with one multi-statement exec().
    db.exec(`CREATE TABLE log (id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT, repo TEXT, status TEXT, n INTEGER);
             CREATE TABLE message (id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT, ref TEXT);
             CREATE INDEX idx_log_repo ON log(repo);`);

    // Migration probes (server.js reads pragma_table_info before ALTERing).
    const cols = new Set(db.prepare("SELECT name FROM pragma_table_info('message')").all().map((c) => c.name));
    assert.ok(cols.has('kind') && cols.has('ref'), 'pragma_table_info must list declared columns');
    const { n: hasComment } = /** @type {{n:number}} */ (
      db.prepare("SELECT COUNT(*) AS n FROM pragma_table_info('message') WHERE name = 'comment_state'").get()
    );
    assert.equal(hasComment, 0, 'COUNT(*) AS n must come back as a plain number for the migration guard');
    db.exec('ALTER TABLE message ADD COLUMN comment_state TEXT');
    assert.equal(
      /** @type {{n:number}} */ (
        db.prepare("SELECT COUNT(*) AS n FROM pragma_table_info('message') WHERE name = 'comment_state'").get()
      ).n,
      1,
      'ALTER TABLE ADD COLUMN must be visible to the next pragma read',
    );

    // Write path: server.js re-reads every insert by info.lastInsertRowid.
    const info = db.prepare('INSERT INTO log (ts, repo, status, n) VALUES (?, ?, ?, ?)').run('t0', 'workspace', 'done', 7);
    assert.equal(Number(info.changes), 1, 'run() must report changes');
    const row = /** @type {any} */ (db.prepare('SELECT * FROM log WHERE id = ?').get(info.lastInsertRowid));
    assert.equal(row.repo, 'workspace', 'lastInsertRowid must bind straight back as a parameter');
    assert.equal(typeof row.id, 'number', 'INTEGER columns must arrive as JS numbers, not BigInt — res.json() depends on it');

    // INSERT OR IGNORE backs /seen (inbox_seen dedupe).
    db.exec('CREATE TABLE seen (message_id TEXT PRIMARY KEY, ts TEXT)');
    const ins = db.prepare('INSERT OR IGNORE INTO seen (message_id, ts) VALUES (?, ?)');
    ins.run('m1', 't');
    assert.equal(Number(ins.run('m1', 't').changes), 0, 'INSERT OR IGNORE must report 0 changes on a duplicate');

    // Dynamic SET lists back the PATCH /conversation path.
    const sets = ['repo = ?', 'status = ?'];
    assert.equal(
      Number(db.prepare(`UPDATE log SET ${sets.join(', ')} WHERE id = ?`).run('ho-nexus', 'blocked', row.id).changes),
      1,
    );

    // Read path.
    assert.equal(db.prepare('SELECT * FROM log WHERE id = ?').get(-1), undefined, '.get() must be undefined on no rows');
    assert.equal(/** @type {any} */ (db.prepare('SELECT NULL AS x').get()).x, null, 'NULL must arrive as null');
    const grouped = db.prepare('SELECT status, COUNT(*) AS n FROM log GROUP BY status').all();
    // Rows come back with a NULL prototype, so deepStrictEqual against an object
    // literal would fail on the prototype alone. Harmless for res.json()/spread —
    // pinned here so the next runtime bump surfaces it as a change, not a mystery.
    assert.equal(Object.getPrototypeOf(grouped[0]), null, 'node:sqlite rows are null-prototype objects');
    assert.deepEqual(
      grouped.map((r) => ({ ...r })),
      [{ status: 'blocked', n: 1 }],
      'GROUP BY aggregates back /summary',
    );
    assert.equal(JSON.stringify(grouped), '[{"status":"blocked","n":1}]', 'rows must serialise for res.json()');
    assert.equal(db.prepare('SELECT * FROM log WHERE repo = ? ORDER BY id DESC LIMIT ?').all('ho-nexus', 5).length, 1);
    db.close();

    // readOnly open — used by restore.js and the entrypoint's db_has_rows().
    const ro = new DatabaseSync(dbPath, { readOnly: true });
    assert.equal(/** @type {{n:number}} */ (ro.prepare('SELECT COUNT(*) AS n FROM log').get()).n, 1);
    assert.throws(() => ro.exec("INSERT INTO log (ts) VALUES ('x')"), 'a readOnly handle must refuse writes');
    ro.close();
  } finally {
    cleanup(dir);
  }
});

test('TP-node24-003: the entrypoint db_has_rows() probe distinguishes missing, empty and populated DBs', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'ws-hasrows-'));
  // Byte-for-byte the expression the container entrypoint runs.
  const probe = `
    const { DatabaseSync } = require("node:sqlite");
    try {
      const db = new DatabaseSync(process.argv[1], { readOnly: true });
      process.exit(db.prepare("SELECT COUNT(*) AS n FROM log").get().n > 0 ? 0 : 1);
    } catch { process.exit(1); }`;
  /** @param {string} p */
  const exitCode = (p) => {
    try {
      execFileSync(process.execPath, ['-e', probe, p], { stdio: 'ignore' });
      return 0;
    } catch (/** @type {any} */ e) {
      return e.status;
    }
  };
  try {
    assert.equal(exitCode(path.join(dir, 'missing.db')), 1, 'a missing DB must report empty so the restore fires');

    const empty = path.join(dir, 'empty.db');
    const db = new DatabaseSync(empty);
    db.exec('CREATE TABLE log (id INTEGER PRIMARY KEY)');
    db.close();
    assert.equal(exitCode(empty), 1, 'a schema-only DB must report empty so the restore fires');

    const full = path.join(dir, 'full.db');
    const db2 = new DatabaseSync(full);
    db2.exec('CREATE TABLE log (id INTEGER PRIMARY KEY); INSERT INTO log (id) VALUES (1);');
    db2.close();
    assert.equal(exitCode(full), 0, 'a populated DB must report non-empty so the restore is skipped');
  } finally {
    cleanup(dir);
  }
});

test('TP-node24-002: server/restore.js rebuilds a DB from a SQL dump and reports row counts', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'ws-restore24-'));
  const sql = path.join(dir, 'logs.sql');
  const dbPath = path.join(dir, 'logs.db');
  writeFileSync(
    sql,
    `CREATE TABLE log (id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT, repo TEXT);
     INSERT INTO log (ts, repo) VALUES ('t0','workspace');
     INSERT INTO log (ts, repo) VALUES ('t1','ho-nexus');
     CREATE TABLE plan (slug TEXT PRIMARY KEY, kind TEXT);
     INSERT INTO plan (slug, kind) VALUES ('p1','test-plan');`,
    'utf8',
  );
  try {
    const out = execFileSync(process.execPath, [path.join(ROOT, 'server', 'restore.js'), sql, dbPath, '--force'], {
      encoding: 'utf8',
    });
    assert.match(out, /log=2/, `restore.js must report per-table counts, got: ${out}`);
    assert.match(out, /plan=1/);

    const db = new DatabaseSync(dbPath, { readOnly: true });
    assert.equal(/** @type {{n:number}} */ (db.prepare('SELECT COUNT(*) AS n FROM log').get()).n, 2);
    db.close();

    // ...and it refuses to clobber a populated DB without --force (the DR safety net).
    assert.throws(
      () => execFileSync(process.execPath, [path.join(ROOT, 'server', 'restore.js'), sql, dbPath], { stdio: 'pipe' }),
      'restore.js must refuse to overwrite a non-empty DB without --force',
    );
  } finally {
    cleanup(dir);
  }
});
