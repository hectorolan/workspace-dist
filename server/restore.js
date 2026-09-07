// restore.js — rebuild the logging DB from a plain-SQL dump (server/dump.js output).
// Disaster recovery: clone workspace-backups, then `node restore.js logs.sql [db-path]`.
// Refuses to overwrite an existing non-empty DB unless --force is given.
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { DatabaseSync } = require('node:sqlite');

const args = process.argv.slice(2).filter((a) => a !== '--force');
const force = process.argv.includes('--force');
const SQL_PATH = args[0];
if (!SQL_PATH) {
  console.error('usage: node restore.js <dump.sql> [db-path] [--force]');
  process.exit(1);
}
const DB_PATH = args[1] || process.env.LOG_DB_PATH || path.join(os.homedir(), 'sources', 'data', 'logs.db');

if (fs.existsSync(DB_PATH) && !force) {
  try {
    const existing = new DatabaseSync(DB_PATH, { readOnly: true });
    const { n } = existing.prepare('SELECT COUNT(*) AS n FROM log').get();
    existing.close();
    if (n > 0) {
      console.error(`refusing to overwrite ${DB_PATH} (${n} entries) — pass --force to replace it`);
      process.exit(1);
    }
  } catch {
    /* unreadable/empty file: safe to replace */
  }
}

fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
if (fs.existsSync(DB_PATH)) fs.rmSync(DB_PATH);
const db = new DatabaseSync(DB_PATH);
db.exec(fs.readFileSync(SQL_PATH, 'utf8'));
const counts = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
  .all()
  .map((t) => `${t.name}=${db.prepare(`SELECT COUNT(*) AS n FROM "${t.name}"`).get().n}`);
console.log(`restored into ${DB_PATH}: ${counts.join(', ')}`);
