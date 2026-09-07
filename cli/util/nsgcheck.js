// nsgcheck.js — does the control plane's NSG ssh rule still admit THIS station's
// public IP? (test plan `ws plan get nsg-ip-mismatch-check-2026-08-26`)
//
// WHY: on 2026-08-25 this station's public IP rotated on a DHCP renewal
// (23.93.84.179 → 23.93.91.227). The NSG's inbound ssh rule still named the old
// address, so port 22 to the VM went dark — and with it the log-API SSH tunnel —
// for hours. Nothing said why: the supervisor just respawned ssh, blindly, over
// and over. The whole diagnosis is one comparison (station IP vs rule prefixes)
// and the whole fix is one `az network nsg rule update` a HUMAN runs.
//
// HARD RULES:
// - READ ONLY. Every az verb this module can produce is `list`. It never runs the
//   update — printing the exact command IS the deliverable (env-doctor's D5 rule).
// - Only a MEASURED mismatch is a FAIL. No az, no `az login`, no public IP, no
//   controlPlane config, no tunnel on this station → INFO/skip.
// - Names are config (`configs/environments.json` → `controlPlane.azure`), never
//   literals here: change the config and the printed command changes with it.
// - Cost: the az call is cached per station (`<WS_DATA_DIR>/control-plane/nsg-ssh.json`)
//   and skipped while the cached verdict is `covered` AND the freshly probed IP is
//   unchanged — so the 15-minute tick pays a cheap IP probe in steady state, and an
//   IP rotation still re-reads the rule on the very next tick.
import path from 'node:path';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { probe as sharedProbe } from './probe.js';
import { dataDir, workspaceDir } from './clock.js';
import { publicIp } from './station.js';

/** @typedef {{resourceGroup: string, nsgName: string, sshRuleName: string}} AzureNames */
/** @typedef {{name?: string, src?: string|null, srcs?: string[]|null, port?: string|null}} NsgRule */
/** @typedef {'OK'|'WARN'|'FAIL'|'INFO'} Level */
/** @typedef {{id: string, level: Level, name: string, detail: string, data?: Record<string, unknown>}} CheckResult */

/** The az query for inbound Allow rules — the same shape station-bootstrap reads. */
export const RULE_QUERY = "[?access=='Allow' && direction=='Inbound'].{name:name,src:sourceAddressPrefix,srcs:sourceAddressPrefixes,port:destinationPortRange}";

/** How long a `covered` verdict may be served from cache without re-reading the rule. */
const CACHE_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/**
 * Is an IPv4 address inside an NSG source prefix? Handles the wildcard forms an NSG rule
 * can carry as well as CIDR. (Lives here — the shared util — because two callers need it:
 * this check and `cli/util-tools/station-bootstrap.js`, which re-exports it.)
 * @param {string} ip @param {string} prefix
 * @returns {boolean}
 */
export function ipInPrefix(ip, prefix) {
  const p = String(prefix || '').trim();
  if (!p) return false;
  if (p === '*' || p === 'Internet' || p === 'Any' || p === '0.0.0.0/0') return true;
  const toInt = (/** @type {string} */ a) => {
    const parts = a.split('.');
    if (parts.length !== 4) return null;
    let n = 0;
    for (const part of parts) {
      const v = Number(part);
      if (!/^\d+$/.test(part) || v < 0 || v > 255) return null;
      n = n * 256 + v;
    }
    return n;
  };
  const [net, bitsRaw] = p.split('/');
  const target = toInt(ip);
  const base = toInt(net);
  if (target === null || base === null) return false;
  if (bitsRaw === undefined) return target === base;
  const bits = Number(bitsRaw);
  if (!Number.isInteger(bits) || bits < 0 || bits > 32) return false;
  if (bits === 0) return true;
  const mask = (0xffffffff << (32 - bits)) >>> 0;
  return ((target & mask) >>> 0) === ((base & mask) >>> 0);
}

/**
 * Does any Allow-SSH NSG rule admit this station's measured public IP?
 * @param {string|null} ip
 * @param {NsgRule[]} rules
 * @returns {{state: 'covered'|'not-covered'|'unknown', by: string|null}}
 */
export function nsgCoverage(ip, rules) {
  if (!ip) return { state: 'unknown', by: null };
  if (!Array.isArray(rules) || !rules.length) return { state: 'unknown', by: null };
  for (const r of rules) {
    const prefixes = [r.src, ...(Array.isArray(r.srcs) ? r.srcs : [])].filter(Boolean);
    for (const p of prefixes) {
      if (ipInPrefix(ip, String(p))) return { state: 'covered', by: `${r.name || 'rule'} (${p})` };
    }
  }
  return { state: 'not-covered', by: null };
}

/** @param {string} ip @returns {boolean} IPv4-shaped (the only form NSG prefixes are compared in here) */
export const isIpv4 = (ip) => /^(\d{1,3}\.){3}\d{1,3}$/.test(String(ip || '')) && String(ip).split('.').every((o) => Number(o) <= 255);

/**
 * Does an NSG rule's destination port range include 22? Covers the forms a rule can
 * carry: `*`, a single port, a range, and a comma list.
 * @param {string|null|undefined} range
 * @returns {boolean}
 */
export function portCovers22(range) {
  const text = String(range ?? '').trim();
  if (!text) return false;
  if (text === '*') return true;
  return text.split(',').some((part) => {
    const [lo, hi] = part.trim().split('-');
    const a = Number(lo);
    const b = hi === undefined ? a : Number(hi);
    return Number.isFinite(a) && Number.isFinite(b) && a <= 22 && 22 <= b;
  });
}

/**
 * The Azure control-plane NAMES from config — never defaulted in code, so a station
 * without the block gets a skip rather than a guess at someone's resource group.
 * @param {string} [root] workspace root
 * @returns {{names: AzureNames|null, missing: string[]}}
 */
export function azureNames(root) {
  const file = path.join(root || workspaceDir(), 'configs', 'environments.json');
  /** @type {any} */
  let cfg = null;
  try {
    cfg = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return { names: null, missing: ['configs/environments.json (unreadable)'] };
  }
  const az = cfg?.controlPlane?.azure || {};
  const missing = ['resourceGroup', 'nsgName', 'sshRuleName'].filter((k) => !az[k]);
  if (missing.length) return { names: null, missing };
  return { names: { resourceGroup: String(az.resourceGroup), nsgName: String(az.nsgName), sshRuleName: String(az.sshRuleName) }, missing: [] };
}

/**
 * Does THIS station depend on the ssh path at all? (Only a station with a
 * `logApiTunnel.sshTarget` does — the container hosts the API locally.)
 * @param {string} [root] @param {string} [env] WS_ENV
 * @returns {boolean}
 */
export function stationHasTunnel(root, env = process.env.WS_ENV) {
  if (!env) return false;
  try {
    const cfg = JSON.parse(readFileSync(path.join(root || workspaceDir(), 'configs', 'environments.json'), 'utf8'));
    return Boolean(cfg?.environments?.[env]?.logApiTunnel?.sshTarget);
  } catch {
    return false;
  }
}

/**
 * THE deliverable: the exact command the CEO runs, with the new IP filled in.
 * @param {AzureNames} names @param {string} ip
 * @returns {string}
 */
export function fixCommand(names, ip) {
  return `az network nsg rule update --nsg-name ${names.nsgName} -g ${names.resourceGroup} --name ${names.sshRuleName} --source-address-prefixes ${ip}`;
}

/**
 * What an `az` invocation actually told us. A missing binary and an unauthenticated
 * CLI are both "cannot answer", never "the rule is wrong".
 * @param {{ok: boolean, out: string}} r
 * @returns {'absent'|'not-logged-in'|'error'|'ok'}
 */
export function classifyAz(r) {
  const out = String(r?.out || '');
  if (/not recognized|command not found|No such file|is not recognized/i.test(out)) return 'absent';
  if (/az login|Please run ['"]?az login|not logged in|no subscription found|CredentialUnavailable|AADSTS|Interactive authentication is needed/i.test(out)) return 'not-logged-in';
  if (!r?.ok) return 'error';
  return 'ok';
}

/**
 * Inbound Allow rules that reach port 22, out of `az network nsg rule list` JSON.
 * @param {string} out
 * @returns {NsgRule[]}
 */
export function parseSshRules(out) {
  /** @type {any} */
  let parsed;
  try {
    parsed = JSON.parse(String(out || ''));
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return parsed.filter((r) => portCovers22(r?.port));
}

/** @returns {string} the per-station cache file (data dir, never git) */
export function cacheFile() {
  return path.join(dataDir(), 'control-plane', 'nsg-ssh.json');
}

/** @returns {{ip?: string, state?: string, at?: number}|null} */
function readCache() {
  try {
    if (!existsSync(cacheFile())) return null;
    return JSON.parse(readFileSync(cacheFile(), 'utf8'));
  } catch {
    return null;
  }
}

/** @param {{ip: string, state: string, at: number}} v */
function writeCache(v) {
  try {
    mkdirSync(path.dirname(cacheFile()), { recursive: true });
    writeFileSync(cacheFile(), JSON.stringify(v, null, 2));
  } catch {
    /* a cache that cannot be written just means the next tick re-reads the rule */
  }
}

/**
 * Serve from cache? Only a `covered` verdict for the SAME ip, within the max age —
 * anything else must be re-measured (which is what makes an IP rotation visible on
 * the next tick rather than tomorrow).
 * @param {{ip?: string, state?: string, at?: number}|null} cache
 * @param {string} ip @param {boolean} force @param {number} now
 * @returns {boolean}
 */
export function servesFromCache(cache, ip, force, now) {
  if (force || !cache) return false;
  return cache.state === 'covered' && cache.ip === ip && Number.isFinite(cache.at) && now - Number(cache.at) < CACHE_MAX_AGE_MS;
}

/**
 * The check, in env-doctor's CheckResult shape (so env-doctor, the station registry
 * row and the Stations page all render it with no extra wiring).
 * Seams (`ipFn`, `run`, `names`, `hasTunnel`, `cache*`) exist for tests; production
 * callers pass at most `{ force }`.
 * @param {{
 *   root?: string, env?: string, force?: boolean,
 *   hasTunnel?: boolean, names?: AzureNames|null, missing?: string[],
 *   ip?: string|null, ipFn?: () => Promise<string|null>,
 *   run?: (cmd: string, argv: string[]) => {ok: boolean, out: string, status: number|null},
 *   readCacheFn?: () => {ip?: string, state?: string, at?: number}|null,
 *   writeCacheFn?: (v: {ip: string, state: string, at: number}) => void,
 *   now?: () => number,
 * }} [opts]
 * @returns {Promise<CheckResult>}
 */
export async function nsgAllowlistCheck(opts = {}) {
  const {
    root, env = process.env.WS_ENV, force = false,
    ipFn = publicIp,
    run = (/** @type {string} */ cmd, /** @type {string[]} */ argv) => sharedProbe(cmd, argv, { timeout: 90000 }),
    readCacheFn = readCache, writeCacheFn = writeCache, now = Date.now,
  } = opts;
  /** @type {(level: Level, detail: string, data?: Record<string, unknown>) => CheckResult} */
  const result = (level, detail, data) => ({ id: 'nsg-ssh-allowlist', level, name: 'nsg-ssh', detail, ...(data ? { data } : {}) });

  const hasTunnel = opts.hasTunnel ?? stationHasTunnel(root, env);
  if (!hasTunnel) return result('INFO', 'skipped — this station has no logApiTunnel, so nothing here depends on the NSG ssh rule');

  const resolved = opts.names !== undefined ? { names: opts.names, missing: opts.missing || ['controlPlane.azure'] } : azureNames(root);
  if (!resolved.names) return result('INFO', `skipped — configs/environments.json controlPlane.azure is missing ${resolved.missing.join(', ')}; nothing in code supplies Azure names`);
  const names = resolved.names;

  const ip = opts.ip !== undefined ? opts.ip : await ipFn();
  if (!ip) return result('INFO', 'skipped — this station\'s public IP could not be probed (WS_PUBLIC_IP_URL / offline)');
  if (!isIpv4(ip)) return result('INFO', `skipped — public IP ${ip} is not IPv4; NSG prefix comparison here is IPv4-only`, { ip });

  const cached = readCacheFn();
  if (servesFromCache(cached, ip, force, now())) {
    return result('OK', `${names.nsgName}/${names.sshRuleName} admits this station (${ip}) — cached verdict, rule not re-read`, { ip, state: 'covered', cached: true });
  }

  const r = run('az', ['network', 'nsg', 'rule', 'list', '-g', names.resourceGroup, '--nsg-name', names.nsgName, '--query', RULE_QUERY, '-o', 'json']);
  const azState = classifyAz(r);
  if (azState === 'absent') return result('INFO', 'skipped — az CLI not on PATH here, so the NSG rule cannot be read (the tunnel still tells you when it breaks)');
  if (azState === 'not-logged-in') return result('INFO', 'skipped — az is present but not authenticated (`az login`), so the NSG rule cannot be read');
  if (azState === 'error') return result('INFO', `skipped — az could not read ${names.nsgName} (rule list failed; exit ${r.status})`, { ip });

  const rules = parseSshRules(r.out);
  const named = rules.find((x) => x.name === names.sshRuleName);
  const current = [named?.src, ...(Array.isArray(named?.srcs) ? named.srcs : [])].filter(Boolean).join(', ');
  const cov = nsgCoverage(ip, rules);

  if (cov.state === 'covered') {
    writeCacheFn({ ip, state: 'covered', at: now() });
    return result('OK', `${names.nsgName} admits this station's public IP ${ip} via ${cov.by}`, { ip, state: 'covered', rule: names.sshRuleName });
  }
  if (cov.state === 'unknown') {
    writeCacheFn({ ip, state: 'unknown', at: now() });
    return result('WARN', `${names.nsgName} reports no inbound Allow rule reaching port 22 — cannot compare against this station's IP ${ip}`, { ip, state: 'unknown' });
  }
  const fix = fixCommand(names, ip);
  writeCacheFn({ ip, state: 'not-covered', at: now() });
  return result(
    'FAIL',
    `this station's public IP is ${ip}, but ${names.nsgName}/${names.sshRuleName} allows ${current || 'other prefixes only'} — ssh (and the log-API tunnel) is blocked until the CEO runs: ${fix}`,
    { ip, state: 'not-covered', rule: names.sshRuleName, allows: current || null, fix },
  );
}
