// Retired-repo handling for the portfolio sweep. The log API stays complete and
// honest — every repo's history remains queryable — so the filtering happens
// here, in the one client, at read time. Config: configs/repos.json.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { workspaceDir } from './clock.js';

/**
 * Repos marked retired in configs/repos.json. Unreadable/absent config is not an
 * error: it just means nothing is retired (the sweep shows everything).
 * @returns {string[]}
 */
export function retiredRepos() {
  try {
    const cfg = JSON.parse(readFileSync(path.join(workspaceDir(), 'configs', 'repos.json'), 'utf8'));
    return Array.isArray(cfg.retired) ? cfg.retired.map(String) : [];
  } catch {
    return [];
  }
}

/**
 * Drop retired repos' blocks from a `/summary` text response. The endpoint emits
 * one `## <repo>` block per repo, so blocks are split on that heading.
 * @param {string} text @param {string[]} retired @returns {string}
 */
export function dropRetiredBlocks(text, retired) {
  if (!retired.length || !text) return text;
  const kept = text
    .split(/\n(?=## )/)
    .filter((block) => {
      const m = block.match(/^## (.+?)\s*$/m);
      return !(m && retired.includes(m[1]));
    });
  return kept.join('\n');
}
