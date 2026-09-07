// audit() — the never-silent audit write, for scripted writers that have ALREADY
// changed state.
//
// WHY THIS EXISTS (backlog 42): `pr-watch` closed a test-plan with `planSet` and
// then wrote its `done` line; if that write failed, the plan was closed with no
// audit line and nothing said so — and `plan-close` wrote the same lines as
// `await log({...}).catch(() => {})`, swallowing the failure outright, one module
// over. Both break CLAUDE.md's own rule: if it's not in the log, it didn't happen.
//
// THE BAR IS "NEVER SILENT", NOT "NEVER FAILS" (backlog 42): `api.log`
// already falls back to the offline md when the API is unreachable and `ws pull`
// replays it, so the only failure left is a rare non-network one (a locked or
// unwritable fallback file). No retry queue: a loud console diagnostic plus a
// durable line is the whole contract.
//
// It NEVER throws. These callers have already performed the irreversible half of
// the operation, so aborting them mid-sweep would trade a missing line for a
// half-finished sweep — the caller must be free to carry on and report.
import { appendFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import * as api from './apiclient.js';
import { dataDir, today } from './clock.js';

/**
 * Where a log line goes when even the offline fallback refused it. Deliberately
 * NOT `fallback/log.md`: that file is the replay queue `ws pull` drains, and a
 * line lands here precisely because writing it failed. This is an incident
 * record in the same `date | area | status | message` format, so
 * `server/import-log-md.js` can re-import it during recovery.
 */
export function auditFailureFile() {
  return path.join(dataDir(), 'fallback', 'audit-failures.md');
}

/**
 * One audit line that cannot vanish quietly.
 * @param {{area: string, status: string, message: string, repo?: string, agent?: string}} entry
 * @param {{log?: typeof api.log, sink?: string}} [deps] injectable for tests
 * @returns {Promise<{ok: boolean, line?: string, fallback?: string, error?: string}>}
 */
export async function audit(entry, { log = api.log, sink } = {}) {
  try {
    const r = await log(entry);
    if (r && r.ok === false) {
      // Not a hole: the line is queued offline and `ws pull` replays it. Say so
      // anyway — a silent degradation is how a queue grows unnoticed.
      console.error(`audit: log API unreachable — ${entry.area} | ${entry.status} queued to ${r.fallback}`);
    }
    return r;
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    const line = `${today()} | ${entry.area} | ${entry.status} | ${entry.message}`;
    console.error(
      `AUDIT WRITE FAILED (${detail}) — the action already happened and has no log line: ` +
      `${entry.agent || '?'} | ${entry.repo || 'workspace'} | ${line}`
    );
    const target = sink || auditFailureFile();
    try {
      mkdirSync(path.dirname(target), { recursive: true });
      appendFileSync(target, line + '\n', 'utf8');
      console.error(`audit: recorded to ${target} — re-import with server/import-log-md.js`);
    } catch (e2) {
      console.error(
        `audit: ${target} could not be written either (${e2 instanceof Error ? e2.message : e2}) — ` +
        'the console line above is the only record'
      );
    }
    return { ok: false, error: detail };
  }
}
