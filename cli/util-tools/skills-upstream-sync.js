#!/usr/bin/env node
// Entry point for the vendored-skills upstream check (logic: ../util/skillsync.js —
// local re-check stamp, agent-doctor verification, PR-only updates titled
// "Agent: update for skill '<name>'", never a merge).
//
// The scheduled gh-workflow .github/workflows/skills-upstream-sync.yml is the
// production trigger and runs this file in the control plane; that runner is ephemeral,
// so it never carries a stamp and its cron IS the cadence. On a station the stamp
// throttles repeat runs and `--force` means exactly one thing: ignore it.
//   node cli/util-tools/skills-upstream-sync.js            # respects the local 3-day stamp
//   node cli/util-tools/skills-upstream-sync.js --force    # check now, ignore the stamp
//
// Exit code: 1 on any FAILED check (unreachable upstream, a repo outside the allow-list,
// agent-doctor rejecting the refreshed tree) AND on `skipped` — a pass that found no
// manifest scanned nothing, which is a misconfiguration, not a quiet success. That case
// is real: the first gh-workflow run reported green having checked zero skills, because
// WORKSPACE_DIR was unset and workspaceDir() defaulted to the station layout. Only
// `throttled` and a clean pass exit 0. syncSkills itself never throws.
import { syncSkills } from '../util/skillsync.js';

const force = process.argv.includes('--force');
syncSkills({ force }).then((summary) => {
  console.log(`skills-upstream-sync: ${summary}`);
  process.exit(/FAILED/.test(summary) || summary.startsWith('skipped') ? 1 : 0);
});
