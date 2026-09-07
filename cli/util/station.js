// station.js - the station-registry reporter (plan environment-setup-streamlining,
// W3/D1b). Every station's 15-minute `ws pull` tick calls reportStation() so the
// control plane knows, from anywhere, what stations exist and what state they are
// in - instead of Hector auditing a box in person.
//
// Contract (decided, not open):
// - REUSE, never re-derive: the payload IS cli/util-tools/env-doctor.js
//   `payload(collectChecks())` (W1's handoff), plus one added field: publicIp.
// - Observed state only: the definition (identity, ports, tunnel) stays in
//   configs/environments.json; this module never writes definitional data.
// - Fail soft, never slow: the API health probe runs FIRST, and an unreachable
//   API skips every tool probe - the tick's other jobs matter more. No outcome
//   here ever throws to the caller, changes `ws pull`'s exit code, or writes a
//   `ws log` line (scheduled runs don't log; the registry write is state).
// - No secrets: env-doctor already redacts values and reports gh scope NAMES
//   only; this module adds nothing but the public IP.
import { stationReport, health } from './apiclient.js';

const IP_URL_DEFAULT = 'https://api.ipify.org';

/**
 * This station's public IP, fail-soft: any error, non-OK response, timeout, or
 * non-IP-shaped answer returns null - a dead IP service never blocks a report.
 * @param {{url?: string, timeoutMs?: number, fetchFn?: typeof fetch}} [opts]
 * @returns {Promise<string|null>}
 */
export async function publicIp({ url = process.env.WS_PUBLIC_IP_URL || IP_URL_DEFAULT, timeoutMs = 5000, fetchFn = fetch } = {}) {
  try {
    const res = await fetchFn(url, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return null;
    const text = (await res.text()).trim();
    return /^[0-9a-fA-F.:]{3,45}$/.test(text) ? text : null;
  } catch {
    return null;
  }
}

/**
 * Collect this station's observed state and PUT it to the registry
 * (one row per station, last-write-wins - PUT /station/:env).
 * Seams are injectable for tests only; production callers pass nothing.
 * @param {{
 *   env?: string,
 *   healthFn?: () => Promise<string>,
 *   collect?: () => Promise<Record<string, unknown>>,
 *   ip?: () => Promise<string|null>,
 *   put?: (env: string, report: Record<string, unknown>) => Promise<{line: string, created: boolean}>,
 * }} [seams]
 * @returns {Promise<{status: 'reported'|'offline'|'no-identity'|'failed', env?: string, ok?: boolean, detail: string}>}
 */
export async function reportStation({ env = process.env.WS_ENV, healthFn = health, collect, ip = publicIp, put = stationReport } = {}) {
  if (!env) return { status: 'no-identity', detail: 'WS_ENV not set - nothing to key the row by' };
  // Reachability first: when the API is down the report cannot land anyway, so
  // skip the (multi-second) env-doctor probes entirely and keep the tick fast.
  try {
    const h = /** @type {{ok?: boolean}} */ (JSON.parse(await healthFn()));
    if (!h.ok) throw new Error('health not ok');
  } catch {
    return { status: 'offline', env, detail: 'log API unreachable - skipped without probing' };
  }
  try {
    if (!collect) {
      // Lazy so tests never touch the real probes, and so a broken tool file
      // degrades to 'failed' instead of taking the import of this module down.
      const doctor = await import('../util-tools/env-doctor.js');
      collect = async () => doctor.payload(await doctor.collectChecks());
    }
    const report = await collect();
    report.publicIp = await ip();
    const { created } = await put(env, report);
    return { status: 'reported', env, ok: Boolean(report.ok), detail: created ? 'row created' : 'row updated' };
  } catch (e) {
    return { status: 'failed', env, detail: e instanceof Error ? e.message : String(e) };
  }
}
