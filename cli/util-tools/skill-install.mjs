#!/usr/bin/env node
// Vendor an external agent skill into .claude/skills/<name> and pin it in
// .claude/skills/sources.json (logic: ../util/skillsync.js `installSkill`).
// The source repo must be a key of `external_skills_git` in
// configs/environments.json — a repo outside that registry is refused here, not
// argued about in a session. Existing skills are refused too: updates arrive
// only through the upstream sync's review PR.
//
//   node cli/util-tools/skill-install.mjs --name webapp-testing \
//        --repo anthropics/skills --path skills/webapp-testing
//
// Prints the pinned sha + vendored file list; commit with the normal `ws sync`.
import { installSkill } from '../util/skillsync.js';

/** @param {string} flag @returns {string|undefined} */
const arg = (flag) => {
  const i = process.argv.indexOf(flag);
  return i === -1 ? undefined : process.argv[i + 1];
};

const name = arg('--name');
const repo = arg('--repo');
const path = arg('--path');
if (!name || !repo || !path) {
  console.error('usage: skill-install.mjs --name <skill> --repo <owner/repo> --path <path/in/repo>');
  process.exit(2);
}

try {
  const r = installSkill({ name, repo, path });
  console.log(`skill-install: ${r.name} <- ${r.repo}/${r.path} @ ${r.sha}`);
  console.log(`  files: ${r.files.join(', ')}`);
} catch (e) {
  console.error(`skill-install: FAILED — ${e instanceof Error ? e.message.split('\n')[0] : e}`);
  process.exit(1);
}
