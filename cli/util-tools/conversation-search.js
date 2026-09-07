// Find past email threads / stored documents by keyword (backlog item 14).
//
// Thin wrapper over the message index's existing `?q=` filter: prints matching
// index lines (bodies elided — read one in full with `ws query --message-id <id>`).
//
// Usage: node cli/util-tools/conversation-search.js "<text>" [--kind <k>] [--days <n>] [--limit <n>]
import { listMessages } from '../util/apiclient.js';

/** @param {string} flag @returns {string|undefined} */
const argOf = (flag) => {
  const i = process.argv.indexOf(flag);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : undefined;
};

const q = process.argv[2];
if (!q || q.startsWith('--')) {
  console.error('usage: conversation-search.js "<text>" [--kind <k>] [--days <n>] [--limit <n>]');
  process.exit(2);
}

try {
  const entries = await listMessages({
    q,
    kind: argOf('--kind'),
    days: Number(argOf('--days')) || 365,
    limit: Number(argOf('--limit')) || 25,
  });
  if (!entries.length) {
    console.log(`no messages match "${q}"`);
  } else {
    for (const e of entries) console.log(`${e.id} | ${e.date} | ${e.kind} | ${e.subject || e.ref || ''}`);
  }
} catch (/** @type {any} */ e) {
  console.error(`conversation-search: FAILED — ${e.message}`);
  process.exit(1);
}
