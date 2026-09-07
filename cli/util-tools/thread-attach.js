// Provenance attach: link a conversation (or a single message) to the artifact
// it generated, as an entry on the artifact's document thread.
//
// The convention (the CEO, 2026-08-15, CLAUDE.md "Artifacts carry their provenance"):
// when a conversation produces a durable artifact — a plan, doc, design, audit —
// the generating session attaches the conversation's ORIGIN message to the
// artifact's thread as a role-`trigger` entry (rendered at the top of the thread),
// then archives the conversation. History travels with the artifact; the
// Conversations list holds only live correspondence. This tool is that convention
// as one command. Everything rides `cli/util/apiclient.js` — no raw API calls.
//
// Usage:
//   node cli/util-tools/thread-attach.js <doc-kind> <doc-ref> --conversation <id> [--keep-active]
//   node cli/util-tools/thread-attach.js <doc-kind> <doc-ref> --message <id> [--role <r>]
//
// --conversation: attaches the conversation's first message as `trigger`, then
//   archives the conversation (skip the archive with --keep-active).
// --message: attaches one message directly; --role defaults to `trigger`.
// Duplicate attaches are idempotent (the API dedupes) and reported, not errored.
import { threadPost, convGet, convStatus } from '../util/apiclient.js';

/** @param {string} flag @returns {string|null} */
const argOf = (flag) => {
  const i = process.argv.indexOf(flag);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : null;
};

const [docKind, docRef] = process.argv.slice(2);
const convId = argOf('--conversation');
const msgId = argOf('--message');
if (!docKind || !docRef || (!convId && !msgId)) {
  console.error('usage: thread-attach.js <doc-kind> <doc-ref> --conversation <id> [--keep-active] | --message <id> [--role <r>]');
  process.exit(2);
}

try {
  if (convId) {
    const { conversation, messages } = await convGet(convId);
    if (!messages.length) throw new Error(`conversation ${convId} has no messages`);
    const origin = messages[0];
    const { duplicate } = await threadPost({ docKind, docRef, messageId: origin.id, role: 'trigger' });
    console.log(
      `${duplicate ? 'already attached' : 'attached'}: conversation ${convId} ("${conversation.title || origin.subject || ''}") ` +
        `→ ${docKind}/${docRef} via origin message ${origin.id} (trigger)`,
    );
    if (!process.argv.includes('--keep-active') && conversation.status !== 'archived') {
      await convStatus(convId, 'archived');
      console.log(`archived: conversation ${convId} (reverse with: node cli/ws.js conv-status ${convId} active)`);
    }
  } else {
    const roleArg = argOf('--role') || 'trigger';
    if (roleArg !== 'trigger' && roleArg !== 'agent' && roleArg !== 'ceo') throw new Error(`invalid role "${roleArg}" — one of trigger|agent|ceo`);
    const role = /** @type {'trigger'|'agent'|'ceo'} */ (roleArg);
    const { duplicate } = await threadPost({ docKind, docRef, messageId: Number(msgId), role });
    console.log(`${duplicate ? 'already attached' : 'attached'}: message ${msgId} → ${docKind}/${docRef} (${role})`);
  }
} catch (/** @type {any} */ e) {
  console.error(`thread-attach: FAILED — ${e.message}`);
  process.exit(1);
}
