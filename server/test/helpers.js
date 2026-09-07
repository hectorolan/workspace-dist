'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { ensureConversationSchema } = require('../conversations');

/** Same message DDL server.js bootstraps — tests build DBs the way production looks. */
const MESSAGE_DDL = `
  CREATE TABLE IF NOT EXISTS message (
    id      INTEGER PRIMARY KEY AUTOINCREMENT,
    ts      TEXT NOT NULL,
    date    TEXT NOT NULL,
    kind    TEXT NOT NULL,
    subject TEXT,
    ref     TEXT,
    body    TEXT NOT NULL,
    meta    TEXT
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_message_kind_ref ON message(kind, ref) WHERE ref IS NOT NULL;
`;

/** Fresh temp DB with the message table (pre-migration shape unless migrate=true). */
function makeDb({ migrate = true } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'logapi-test-'));
  const db = new DatabaseSync(path.join(dir, 'logs.db'));
  db.exec(MESSAGE_DDL);
  if (migrate) ensureConversationSchema(db);
  return db;
}

let seq = 0;

/** Insert a message row directly (as the live table would hold it). */
function insertMessage(db, { ts, kind, subject = null, ref = null, body = 'body', meta = null }) {
  const t = ts || new Date(Date.now() + seq++).toISOString();
  const info = db
    .prepare('INSERT INTO message (ts, date, kind, subject, ref, body, meta) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(t, t.slice(0, 10), kind, subject, ref, body, meta ? JSON.stringify(meta) : null);
  return db.prepare('SELECT * FROM message WHERE id = ?').get(info.lastInsertRowid);
}

module.exports = { MESSAGE_DDL, makeDb, insertMessage };
