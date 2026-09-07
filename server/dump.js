// dump.js — write the logging DB as plain-SQL text on stdout (ALL user tables).
// Text (not the binary .db) is what gets committed to the backup repo: tables are
// append-only, so each day's git diff is just the new INSERT lines and history stays tiny.
// Usage: node dump.js [db-path]   (default: LOG_DB_PATH or ~/sources/data/logs.db)
'use strict';

const path = require('node:path');
const os = require('node:os');
const { DatabaseSync } = require('node:sqlite');

const DB_PATH = process.argv[2] || process.env.LOG_DB_PATH || path.join(os.homedir(), 'sources', 'data', 'logs.db');
const db = new DatabaseSync(DB_PATH, { readOnly: true });

const esc = (v) => (v === null || v === undefined ? 'NULL' : `'${String(v).replace(/'/g, "''")}'`);

const out = [];
out.push('-- logs.sql — full dump of the central logging DB (restore with server/restore.js)');
out.push('BEGIN TRANSACTION;');
for (const t of db.prepare(
  "SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
).all()) {
  out.push(`DROP TABLE IF EXISTS "${t.name}";`);
  out.push(t.sql + ';');
  for (const i of db.prepare(
    "SELECT sql FROM sqlite_master WHERE type = 'index' AND tbl_name = ? AND sql IS NOT NULL"
  ).all(t.name)) {
    out.push(i.sql + ';');
  }
  const cols = db.prepare(`PRAGMA table_info("${t.name}")`).all().map((c) => c.name);
  const colList = cols.map((c) => `"${c}"`).join(', ');
  for (const r of db.prepare(`SELECT * FROM "${t.name}" ORDER BY rowid`).all()) {
    out.push(`INSERT INTO "${t.name}" (${colList}) VALUES (${cols.map((c) => esc(r[c])).join(', ')});`);
  }
}
out.push('COMMIT;');
process.stdout.write(out.join('\n') + '\n');
