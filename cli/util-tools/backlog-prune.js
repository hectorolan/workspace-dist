#!/usr/bin/env node
// backlog-prune — the monthly backlog prune (util/backlogprune.js), dry-run BY
// DEFAULT: prints exactly which Resolved sections and marker-dated items would
// move to which `backlog-history-YYYY-MM` plan, what stays for the current
// month, and what was refused as ambiguous (with the reason) — without writing
// anything. `--apply` performs the real prune: history written and verified
// FIRST, backlog trimmed after (spec: SYSTEM.md "Monthly backlog prune").
//
//   node cli/util-tools/backlog-prune.js            # dry-run, full judgement
//   node cli/util-tools/backlog-prune.js --apply    # what the monthly job runs
//
// Exit 0 on a healthy run (including "nothing to prune"); 1 when the module
// reports a failure, so the scheduler's declarative retries fire.
// process.exitCode, never process.exit (ws.js hard-exit hazard note).
import { historySlug, pruneBacklog } from '../util/backlogprune.js';

const apply = process.argv.includes('--apply');
const res = await pruneBacklog({ dryRun: !apply });

console.log(`backlog-prune${apply ? '' : ' (dry-run)'}: ${res.summary}`);
if (res.plan) {
  const mark = apply && res.applied ? 'MOVED  ' : 'MOVE   ';
  for (const u of res.plan.moves) {
    console.log(`  ${mark}${u.kind === 'section' ? 'section' : 'item'}  → ${historySlug(u.month)}`);
    console.log(`         ${u.label}`);
  }
  for (const k of res.plan.keptCurrent) {
    console.log(`  KEEP   (current month ${k.month})  ${k.label}`);
  }
  for (const a of res.plan.ambiguous) {
    console.log(`  REFUSE (ambiguous)  ${a.label}`);
    console.log(`         ${a.reason}`);
  }
  if (!res.plan.moves.length && !res.plan.ambiguous.length && !res.plan.keptCurrent.length) {
    console.log('  no resolved material found — the backlog is all pending work');
  }
}
if (res.threads) {
  const mark = apply && res.applied ? 'MOVED  ' : 'MOVE   ';
  for (const tm of res.threads.moves) {
    console.log(`  ${mark}thread entry ${tm.id} (${tm.role}, message ${tm.messageId} dated ${tm.date})  → ${historySlug(tm.month)}`);
  }
  for (const k of res.threads.kept) {
    console.log(`  KEEP   (current month ${k.month})  thread entry ${k.id}`);
  }
  for (const l of res.threads.left) {
    console.log(`  LEAVE  thread entry ${l.id} — ${l.reason}`);
  }
}
process.exitCode = res.ok ? 0 : 1;
