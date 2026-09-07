// Last deploy per app, read from the central log (backlog item 13).
//
// One command answering "what is deployed where, since when": queries the audit
// trail's deploy-area lines and prints the newest line per repo. The deploy
// pipeline (deploy.sh) and the runners already log every deploy/rollback through
// `ws log`, so the trail IS the deploy ledger — this only reads it.
//
// Usage: node cli/util-tools/deploy-status.js [--days <n>]   (default 60)
import { query } from '../util/apiclient.js';
import { retiredRepos } from '../util/repos.js';

const daysIdx = process.argv.indexOf('--days');
const days = daysIdx > -1 ? Number(process.argv[daysIdx + 1]) || 60 : 60;

try {
  const text = await query({ endpoint: '/log', params: { area: 'deploy', days, limit: 500 } });
  const retired = retiredRepos();
  const lines = text.split('\n').filter(Boolean);
  /** @type {Map<string, string>} newest line per repo — lines arrive oldest-first, so later wins */
  const latest = new Map();
  for (const line of lines) {
    const repo = (line.split('|')[1] || '').trim();
    if (repo && !retired.includes(repo)) latest.set(repo, line);
  }
  if (!latest.size) {
    console.log(`no deploy-area log lines in the last ${days} day(s)`);
  } else {
    for (const line of latest.values()) console.log(line);
  }
} catch (/** @type {any} */ e) {
  console.error(`deploy-status: FAILED — ${e.message}`);
  process.exit(1);
}
