// plan-reap — on-demand run of the plan-scoped temp-test reaper (util/planreap.js,
// backlog 60). `ws sync` runs the same sweep automatically pre-commit; this tool
// is the dry-run/verification path and the manual catch-up for a checkout.
//
// usage: node cli/util-tools/plan-reap.js [--dry-run] [--root <dir>]
//
// Applies edits to the working tree only — never commits; the next `ws sync`
// carries them. With --dry-run it prints what WOULD happen and writes nothing
// (no file edits, no baseline strip). Defaults are the workspace repo's; another
// repo hands util/planreap.js its own suite spec (backlog 61).
import { workspaceDir } from '../util/apiclient.js';
import { sweepReap, stripBaselinePlan, WORKSPACE_SUITES } from '../util/planreap.js';

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const rootIx = args.indexOf('--root');
const root = rootIx >= 0 && args[rootIx + 1] ? args[rootIx + 1] : workspaceDir();

const out = await sweepReap({ root, suites: WORKSPACE_SUITES, apply: !dryRun });
for (const n of out.notes) console.log(`plan-reap: ${n}`);
const touched = [...out.changedFiles, ...out.deletedFiles];
if (!touched.length) {
  console.log('plan-reap: nothing to reap (no tag whose plan has closed)');
} else {
  const plans = [...new Set([...out.reapedPlans, ...out.promotedPlans])].join(', ');
  console.log(`plan-reap${dryRun ? ' (dry-run)' : ''}: plans ${plans}`);
  for (const f of out.deletedFiles) console.log(`  delete ${f}`);
  for (const f of out.changedFiles) console.log(`  edit   ${f}`);
  if (out.removedCaseIds.length) console.log(`  case IDs removed: ${out.removedCaseIds.join(', ')}`);
  if (!dryRun) {
    const strip = await stripBaselinePlan({
      repo: 'workspace',
      removedCaseIds: out.removedCaseIds,
      reapedSuites: out.reapedSuites,
    });
    console.log(strip.changed
      ? 'plan-reap: baseline stripped of reaped coverage (pass counts reset; the next green advance re-records)'
      : 'plan-reap: baseline unchanged');
    if (strip.note) console.log(`plan-reap: ${strip.note}`);
    console.log('plan-reap: changes are uncommitted — the next `ws sync` carries them');
  }
}
