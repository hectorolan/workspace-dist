// import-log-md.js — import a classic md audit file (the workspace offline
// fallback at <WS_DATA_DIR>/fallback/log.md, or a project repo's ops/log.md) into
// the logging DB. Disaster-recovery / bulk tool; the common case is drained
// automatically by `ws pull` (apiclient.replayFallback).
// Parses the `date | area | status | message` convention; non-matching lines are
// reported and skipped. Idempotent: an identical imported row is not inserted twice.
// Usage: node import-log-md.js <path-to-log.md> [repo-name] [db-path]
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { DatabaseSync } = require('node:sqlite');

const MD_PATH = process.argv[2];
if (!MD_PATH) {
  console.error('usage: node import-log-md.js <ops-log.md> [repo] [db-path]');
  process.exit(1);
}
const REPO = process.argv[3] || 'workspace';
const DB_PATH = process.argv[4] || process.env.LOG_DB_PATH || path.join(os.homedir(), 'sources', 'data', 'logs.db');

const db = new DatabaseSync(DB_PATH);
const LINE = /^(\d{4}-\d{2}-\d{2})\s*\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|\s*(.+)$/;

const exists = db.prepare(
  "SELECT 1 FROM log WHERE source = 'import' AND repo = ? AND date = ? AND area = ? AND status = ? AND message = ? LIMIT 1"
);
const insert = db.prepare(
  "INSERT INTO log (ts, date, repo, area, status, message, agent, source) VALUES (?, ?, ?, ?, ?, ?, NULL, 'import')"
);

let imported = 0;
let skippedDup = 0;
const unparsed = [];
for (const raw of fs.readFileSync(MD_PATH, 'utf8').split(/\r?\n/)) {
  const t = raw.trim();
  if (!t || t.startsWith('#') || t.startsWith('<!--')) continue;
  const m = t.match(LINE);
  if (!m) {
    unparsed.push(t);
    continue;
  }
  const [, date, area, status, message] = m;
  if (exists.get(REPO, date, area, status, message)) {
    skippedDup++;
    continue;
  }
  insert.run(`${date}T00:00:00.000Z`, date, REPO, area, status, message);
  imported++;
}

console.log(`imported ${imported} entries from ${MD_PATH} as repo='${REPO}' (${skippedDup} duplicates skipped)`);
if (unparsed.length) {
  console.log(`unparsed lines (${unparsed.length}) — review manually:`);
  for (const l of unparsed) console.log('  ' + l);
}
