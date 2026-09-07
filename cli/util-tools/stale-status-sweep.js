#!/usr/bin/env node
// stale-status-sweep — on-demand run of the stale-status sweep (util/statussweep.js),
// dry-run BY DEFAULT: prints every decision (resolve/leave + evidence) without
// writing a single audit line, so the judgement can be read before anything
// writes. `--apply` performs the real sweep (same thing every `ws pull` tick does).
//
//   node cli/util-tools/stale-status-sweep.js            # dry-run, full judgement
//   node cli/util-tools/stale-status-sweep.js --apply    # resolve for real
//
// Exit 0 always (a sweep that leaves everything alone is a healthy outcome);
// process.exitCode, never process.exit (ws.js hard-exit hazard note).
import { sweepStaleStatus } from '../util/statussweep.js';

const apply = process.argv.includes('--apply');
const { summary, decisions } = await sweepStaleStatus({ dryRun: !apply });

console.log(`stale-status-sweep${apply ? '' : ' (dry-run)'}: ${summary}`);
for (const d of decisions) {
  const mark = d.action === 'resolve' ? (apply ? 'RESOLVED' : 'WOULD RESOLVE') : 'LEAVE';
  console.log(`  ${mark}  ${d.repo} | ${d.area} | ${d.status} (log id ${d.id})`);
  console.log(`          ${d.reason}`);
}
if (!decisions.length) console.log('  nothing dangling');
process.exitCode = 0;
