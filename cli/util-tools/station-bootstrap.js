// station-bootstrap - walk the "add a station" procedure (plan
// `environment-setup-streamlining`, Workstream S / W6) on THIS box, in dependency order,
// with every step ending in a machine check.
//
// Usage:
//   node cli/util-tools/station-bootstrap.js            walk every step, instruct on the first gap
//   node cli/util-tools/station-bootstrap.js --all      print instructions for EVERY unsatisfied step
//   node cli/util-tools/station-bootstrap.js --deep     run the network probes even when already proven
//   node cli/util-tools/station-bootstrap.js --fast     skip the test suite inside the acceptance gate
//   node cli/util-tools/station-bootstrap.js --json     the same walk as a structured payload
//   node cli/util-tools/station-bootstrap.js --step s6  full detail + actions for one step
// Windows operators: double-click setup-scripts\windows\station-bootstrap.cmd instead.
//
// Exit codes: 0 = every applicable step satisfied | 1 = a human action is owed
//             2 = the tool itself failed (its own error, never a station verdict)
//
// ===========================================================================
// D5 - THE HARD BOUNDARY (plan decision, not a style preference)
// ---------------------------------------------------------------------------
// This tool READS, PROBES, COMPARES and REPORTS. A HUMAN performs every credential
// action. It never reads, echoes, transports or writes a secret VALUE: it verifies
// that a variable is SET (and, where a real probe exists, that it WORKS), prints the
// exact command for the operator to run, and then verifies the result on the next run.
// The 2026-07-28 GITHUB_TOKEN leak came from a generated helper script that handled a
// token value - hence `redactSecrets()` scrubbing every line on its way out, as a
// backstop to the rule that no value is ever collected in the first place.
// ===========================================================================
//
// PROBE, NEVER ASSUME. Two 2026-07-28 assumptions each cost real time and were settled
// only by measuring, so this tool measures both rather than inferring them:
//   (a) NSG coverage - a SUCCESSFUL ssh connection proves the station's egress IP is
//       admitted; only when the connection fails does the tool read the NSG rule and
//       compare it against the measured public IP.
//   (b) ssh-keyscan against the VM - it is run and its outcome REPORTED (it fails on an
//       OpenSSH 9.5 client that cannot negotiate this VM's KEX, and may succeed on a
//       newer one). The instruction is the Azure control-plane path either way, because
//       that is a policy choice (no trust-on-first-use), not a capability workaround.
//
// Resumable and idempotent by construction: the tool holds NO state between runs. Every
// step re-derives its verdict from the machine, so a satisfied step is skipped on the
// next run because it MEASURES as satisfied, not because a marker says so.
//
// env-doctor stays the verifier: steps 2,3,6,7,8,9 consume `collectChecks()` results
// rather than re-probing. This tool orchestrates, sequences and instructs.
import { existsSync, readFileSync, appendFileSync, mkdirSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { probe as sharedProbe } from '../util/probe.js';
import { spawnSync } from 'node:child_process';
import { workspaceDir, dataDir, query, stationList, stamp } from '../util/index.js';
import { publicIp } from '../util/station.js';
import { nsgCoverage } from '../util/nsgcheck.js';
import { collectChecks, checksFailed } from './env-doctor.js';
import { originOwner } from '../util/distmanifest.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/** @typedef {'ok'|'todo'|'blocked'|'skipped'} StepStatus */
/** @typedef {{level: 'OK'|'WARN'|'FAIL'|'INFO', msg: string}} Finding */
/** @typedef {{id: string, n: number, title: string, deps: string[], status: StepStatus, findings: Finding[], actions: string[]}} Step */

// ---------------------------------------------------------------------------
// Pure helpers (exported for cli/test/station-bootstrap.test.js)
// ---------------------------------------------------------------------------

/** Variable names whose VALUE this tool must never render (D5). */
export const SECRETISH = /token|key|secret|password|credential/i;

/**
 * Last-line-of-defence scrub applied to EVERY line this tool prints or logs. Nothing
 * upstream collects a secret value, so this should never fire; it exists because the
 * incident that produced D5 was an error message echoing a line it never meant to.
 * Short values are ignored - a 3-character secret would turn the report into confetti,
 * and real credentials are long.
 * @param {string} text
 * @param {Record<string, string|undefined>} env
 * @returns {string}
 */
export function redactSecrets(text, env) {
  let out = String(text);
  for (const [name, value] of Object.entries(env)) {
    if (!value || value.length < 8 || !SECRETISH.test(name)) continue;
    out = out.split(value).join(`<redacted:${name}>`);
  }
  return out;
}

/**
 * Presence-only view of the variables a station needs. Returns whether each name is
 * SET - never the value, never its length, never a prefix (D5).
 * @param {{name: string, why: string}[]} spec
 * @param {Record<string, string|undefined>} env
 * @returns {{name: string, why: string, set: boolean, secret: boolean, value: string|null}[]}
 */
export function secretPresence(spec, env) {
  return spec.map(({ name, why }) => {
    const raw = env[name];
    const set = typeof raw === 'string' && raw.trim() !== '';
    const secret = SECRETISH.test(name);
    return { name, why, set, secret, value: set && !secret ? String(raw) : null };
  });
}

/**
 * `LOG_API_URL` is DERIVED, not mirrorable (plan section 3, correction 4): it resolves
 * from THIS station's own `logApiTunnel.localPort`, so copying another box's value
 * verbatim is wrong wherever the ports differ.
 * @param {{localPort?: number}|null|undefined} tunnel
 * @returns {string|null} null when the station hosts the API itself (no tunnel block)
 */
export function derivedLogApiUrl(tunnel) {
  if (!tunnel || !tunnel.localPort) return null;
  return `http://127.0.0.1:${tunnel.localPort}`;
}

/**
 * What a real, non-interactive ssh attempt actually proved. Measured, never inferred -
 * each outcome points at a different owner: a denial is a key that was never installed,
 * a timeout is a network/NSG question, a host-key failure is an unseeded known_hosts.
 * @param {number|null} status @param {string} out
 * @returns {{state: 'connected'|'denied'|'host-key'|'unreachable'|'unknown', detail: string}}
 */
export function classifySsh(status, out) {
  const text = String(out || '');
  if (/Host key verification failed|REMOTE HOST IDENTIFICATION HAS CHANGED|No (?:ED25519|RSA|ECDSA) host key is known/i.test(text)) {
    return { state: 'host-key', detail: 'host key not in known_hosts (or changed) - the VM was never seeded from the Azure control plane' };
  }
  if (/Permission denied|no matching host key|publickey|Too many authentication failures/i.test(text)) {
    return { state: 'denied', detail: 'reached the host, authentication refused - this station\'s public key is not installed on the VM' };
  }
  if (/timed out|timeout|Network is unreachable|Connection refused|No route to host|Could not resolve/i.test(text)) {
    return { state: 'unreachable', detail: 'no answer from the host - network path or NSG source rule' };
  }
  if (status === 0) return { state: 'connected', detail: 'connected and ran a command - key installed, host key trusted, NSG admits this station' };
  return { state: 'unknown', detail: `ssh exited ${status} with no recognised diagnostic` };
}

/**
 * What `ssh-keyscan` did against the VM. Reported as EVIDENCE (assumption (b) above),
 * never as the instruction: host keys come from the Azure control plane either way.
 * @param {number|null} status @param {string} out
 * @returns {{state: 'usable'|'kex-unsupported'|'no-response'|'failed', detail: string}}
 */
export function classifyKeyscan(status, out) {
  const text = String(out || '');
  if (/Unable to negotiate|no matching key exchange method|kex_exchange_identification/i.test(text)) {
    return { state: 'kex-unsupported', detail: 'this ssh client cannot negotiate the VM\'s key exchange - keyscan is not an option here' };
  }
  if (/^[^#\s]+\s+(?:ssh-ed25519|ssh-rsa|ecdsa-sha2-\S+)\s+\S+/m.test(text)) {
    return { state: 'usable', detail: 'keyscan negotiated and returned host keys - but it is trust-on-first-use, so it is still not the instruction' };
  }
  if (status !== 0 || !text.trim()) return { state: 'no-response', detail: 'keyscan returned nothing' };
  return { state: 'failed', detail: 'keyscan produced no host-key line' };
}

// NSG prefix maths lives in the shared util (cli/util/nsgcheck.js) because two callers
// need the SAME comparison: this bootstrap walk, and the env-doctor / tunnel-watch check
// that catches a rotated public IP. Re-exported here so this tool keeps its own surface.
export { ipInPrefix, nsgCoverage } from '../util/nsgcheck.js';

/**
 * Fold a subset of env-doctor results into this step's findings. env-doctor remains the
 * verifier; a FAIL there is a `todo` here.
 * @param {{id: string, level: string, name: string, detail: string}[]} results
 * @param {(id: string) => boolean} match
 * @returns {{findings: Finding[], failed: boolean}}
 */
export function foldDoctor(results, match) {
  const picked = results.filter((r) => match(r.id));
  const findings = picked.map((r) => ({ level: /** @type {Finding['level']} */ (r.level), msg: `${r.name}: ${r.detail}` }));
  return { findings, failed: picked.some((r) => r.level === 'FAIL') };
}

/**
 * The project-work smoke check (the 2026-07-28 lesson: a station passed every plumbing
 * gate and still could not do project work, because no step cloned the project repos).
 * Cloned is not enough - the clone must have a reachable origin, which is what proves
 * the git credential works for PROJECT repos and not merely for the workspace one.
 * @param {string[]} repos
 * @param {(repo: string) => {cloned: boolean, isGit: boolean, remoteOk: boolean, hasClaudeMd: boolean}} probe
 * @returns {Finding[]}
 */
export function smokeFindings(repos, probe) {
  /** @type {Finding[]} */
  const findings = [];
  for (const repo of repos) {
    const s = probe(repo);
    if (!s.cloned || !s.isGit) {
      findings.push({ level: 'FAIL', msg: `${repo}: no sibling clone under sources/ - this station cannot do project work` });
      continue;
    }
    if (!s.remoteOk) {
      findings.push({ level: 'FAIL', msg: `${repo}: cloned, but 'git ls-remote origin' failed - the git credential does not work for this repo here` });
      continue;
    }
    findings.push({ level: 'OK', msg: `${repo}: clone + origin reachable${s.hasClaudeMd ? ' + CLAUDE.md present' : ' (no CLAUDE.md - check the clone)'}` });
  }
  return findings;
}

/**
 * Which of a step's dependencies are not satisfied.
 * @param {string[]} deps @param {Map<string, StepStatus>} statusById
 * @returns {string[]}
 */
export function unmetDeps(deps, statusById) {
  return deps.filter((d) => {
    const s = statusById.get(d);
    return s !== 'ok' && s !== 'skipped';
  });
}

/**
 * A station is bootstrapped when nothing is owed. `blocked` counts as owed - it means a
 * step could not even be probed.
 * @param {Step[]} steps @returns {number}
 */
export function overallExit(steps) {
  return steps.some((s) => s.status === 'todo' || s.status === 'blocked') ? 1 : 0;
}

/** @param {Step[]} steps */
export function summarize(steps) {
  const count = (/** @type {StepStatus} */ s) => steps.filter((x) => x.status === s).length;
  return { ok: count('ok'), todo: count('todo'), blocked: count('blocked'), skipped: count('skipped'), total: steps.length };
}

// ---------------------------------------------------------------------------
// Probes (I/O; fixed literal argv only - no operator input reaches a shell)
// ---------------------------------------------------------------------------

/**
 * Probe an external tool. Fixed literal argv in every call site. Platform split and the
 * DEP0190 rationale live in `cli/util/probe.js` — ONE owner, shared with env-doctor.
 * @param {string} cmd @param {string[]} argv @param {number} [timeout] @param {string} [cwd]
 * @returns {{ok: boolean, out: string, status: number|null}}
 */
const run = (cmd, argv, timeout = 30000, cwd = ROOT) => sharedProbe(cmd, argv, { timeout, cwd });

// The GitHub account is DERIVED from this clone's own origin remote, never written
// in code or config (distribution decision D6: the "CEO is config" rule applied to
// the account). Placeholder only if this tool somehow runs outside a clone.
const OWNER = originOwner(ROOT) || '<your-github-account>';

/**
 * Run one of OUR node tools. Deliberately shell-free: `process.execPath` is
 * `C:\Program Files\nodejs\node.exe`, and under `shell: true` the unquoted space made
 * cmd try to run `C:\Program`, which surfaced as a phantom "agent-doctor: exit 1" on a
 * station where agent-doctor is green. Measured, then fixed.
 * @param {string[]} argv @param {number} [timeout]
 * @returns {{ok: boolean, out: string, status: number|null}}
 */
function runNode(argv, timeout = 300000) {
  const r = spawnSync(process.execPath, argv, { encoding: 'utf8', timeout, windowsHide: true, cwd: ROOT });
  return { ok: r.status === 0 && !r.error, out: `${r.stdout || ''}${r.stderr || ''}`.trim(), status: r.status };
}

// ---------------------------------------------------------------------------
// The walk
// ---------------------------------------------------------------------------

/** The ten ordered steps of Workstream S. Order IS the dependency order. */
const PLAN = [
  { id: 's1', title: 'Station entry in configs/environments.json (pushed)', deps: /** @type {string[]} */ ([]) },
  { id: 's2', title: 'Workspace clone, .claude junction, project repos as siblings', deps: ['s1'] },
  { id: 's3', title: 'Tool set installed (+ git on the MACHINE PATH)', deps: ['s1'] },
  { id: 's4', title: 'Control-plane secrets present as env vars (presence only)', deps: ['s1'] },
  { id: 's5', title: 'Per-account logins (gh, git identity, Claude)', deps: ['s3'] },
  { id: 's6', title: 'SSH transport to the log API (measured, never assumed)', deps: ['s1', 's3', 's4'] },
  { id: 's7', title: 'Per-machine harness config (~/.claude/settings.json)', deps: ['s2'] },
  { id: 's8', title: 'Claude-WorkspacePull registered (the 15-min tick)', deps: ['s2', 's3'] },
  { id: 's9', title: 'Acceptance gate', deps: ['s2', 's3', 's5', 's6', 's7', 's8'] },
  { id: 's10', title: 'Recorded centrally (station registry + docs + one log line)', deps: ['s9'] },
];

/**
 * Walk every step against this machine.
 * @param {{all?: boolean, deep?: boolean, fast?: boolean, only?: string|null}} opts
 * @returns {Promise<{steps: Step[], env: string|null, notes: string[]}>}
 */
export async function walk(opts = {}) {
  /** @type {Step[]} */
  const steps = [];
  /** @type {Map<string, StepStatus>} */
  const statusById = new Map();
  /** @type {string[]} */
  const notes = [];

  /** @param {string} id @returns {Step} */
  const begin = (id) => {
    const def = PLAN.find((p) => p.id === id);
    if (!def) throw new Error(`unknown step ${id}`);
    const step = { id, n: PLAN.indexOf(def) + 1, title: def.title, deps: def.deps, status: /** @type {StepStatus} */ ('ok'), findings: /** @type {Finding[]} */ ([]), actions: /** @type {string[]} */ ([]) };
    steps.push(step);
    return step;
  };
  /** @param {Step} s @param {StepStatus} status */
  const end = (s, status) => {
    s.status = status;
    statusById.set(s.id, status);
  };
  /** @param {Step} s @returns {boolean} true when the step must be skipped as blocked */
  const gate = (s) => {
    const unmet = unmetDeps(s.deps, statusById);
    if (!unmet.length) return false;
    s.findings.push({ level: 'INFO', msg: `not probed - waiting on step(s) ${unmet.join(', ')}` });
    end(s, 'blocked');
    return true;
  };

  // --- shared context -------------------------------------------------------
  const self = process.env.WS_ENV || null;
  /** @type {any} */
  let envs = null;
  try {
    envs = JSON.parse(readFileSync(path.join(ROOT, 'configs', 'environments.json'), 'utf8'));
  } catch (e) {
    notes.push(`configs/environments.json unreadable: ${e instanceof Error ? e.message : e}`);
  }
  const entry = self && envs?.environments ? envs.environments[self] : null;
  const tunnel = entry?.logApiTunnel || null;
  const kindRole = `${entry?.kind || ''} ${entry?.role || ''}`;
  const interactive = /interactive/i.test(kindRole);
  /** @type {string[]} */
  const activeRepos = Array.isArray(envs?.activeProjectRepos) ? envs.activeProjectRepos.map(String) : [];
  const cp = envs?.controlPlane?.azure || {};

  // env-doctor is the verifier for every capability check; collect once.
  const doctor = await collectChecks();

  // ==========================================================================
  // Step 1 - the station's definition, and it must be PUSHED
  // Everything else resolves from this entry (including the tunnel a station needs
  // to reach the DB at all), so it is unconditionally first.
  // ==========================================================================
  {
    const s = begin('s1');
    if (!self) {
      s.findings.push({ level: 'FAIL', msg: 'WS_ENV is not set in this shell - the station cannot identify itself' });
      s.actions.push('Pick a station name, then (Windows, NEW terminal picks it up):');
      s.actions.push('  setx WS_ENV <station-name>');
      end(s, 'todo');
    } else if (!envs) {
      s.findings.push({ level: 'FAIL', msg: 'configs/environments.json could not be read - is the workspace cloned here?' });
      s.actions.push('Clone the workspace repo first (step 2), then re-run.');
      end(s, 'todo');
    } else if (!entry) {
      s.findings.push({ level: 'FAIL', msg: `WS_ENV='${self}' has no entry in configs/environments.json` });
      s.actions.push(`Add an "${self}" entry under "environments" per .claude/SETUP.md "New environment bootstrap" step 1`);
      s.actions.push('  (kind, role, where, identifiesAs, and a logApiTunnel block if it is off-host)');
      s.actions.push('  Add NO capability flag of any kind - a station must stay disposable.');
      s.actions.push(`  node cli/ws.js sync "chore: add station ${self} to environments.json" --paths configs/environments.json`);
      end(s, 'todo');
    } else {
      s.findings.push({ level: 'OK', msg: `WS_ENV=${self} - kind '${entry.kind}', ${tunnel ? `tunnel to ${tunnel.sshTarget} :${tunnel.localPort}` : 'no tunnel (hosts the API)'}` });
      // Pushed? An entry that exists only locally is invisible to every other station.
      const pushed = run('git', ['show', 'origin/main:configs/environments.json'], 20000);
      if (!pushed.ok) {
        s.findings.push({ level: 'WARN', msg: 'could not read origin/main:configs/environments.json (offline?) - could not confirm the entry is pushed' });
        end(s, 'ok');
      } else if (!new RegExp(`"${self.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"\\s*:`).test(pushed.out)) {
        s.findings.push({ level: 'FAIL', msg: `the '${self}' entry exists locally but is NOT on origin/main - unpushed config is invisible to every other environment` });
        s.actions.push(`  node cli/ws.js sync "chore: add station ${self} to environments.json" --paths configs/environments.json`);
        end(s, 'todo');
      } else {
        s.findings.push({ level: 'OK', msg: 'entry is present on origin/main (pushed)' });
        end(s, 'ok');
      }
    }
  }

  // ==========================================================================
  // Step 2 - clone, config junction, project repos as siblings
  // ==========================================================================
  {
    const s = begin('s2');
    if (!gate(s)) {
      let bad = false;
      const ws = workspaceDir();
      const sources = path.dirname(ws);
      if (!existsSync(path.join(ws, '.git'))) {
        s.findings.push({ level: 'FAIL', msg: `no workspace clone at ${ws}` });
        s.actions.push(`  git clone https://github.com/${OWNER}/workspace.git "${ws}"`);
        bad = true;
      } else {
        s.findings.push({ level: 'OK', msg: `workspace clone at ${ws}` });
      }
      // The junction/symlink is what makes .claude load in every session started from sources/.
      const link = path.join(sources, '.claude');
      let linkOk = false;
      try {
        linkOk = existsSync(path.join(link, 'CLAUDE.md')) && statSync(path.join(link, 'CLAUDE.md')).size > 0;
      } catch {
        linkOk = false;
      }
      if (!linkOk) {
        s.findings.push({ level: 'FAIL', msg: `${link} does not resolve to the repo's .claude (agents/skills will not load)` });
        s.actions.push('  Preserve any existing settings.local.json first (gitignored, local-only), then:');
        s.actions.push(`  New-Item -ItemType Junction -Path "${link}" -Target "${path.join(ws, '.claude')}"`);
        bad = true;
      } else {
        s.findings.push({ level: 'OK', msg: `${link} resolves into the repo's .claude` });
      }
      const fold = foldDoctor(doctor, (id) => id === 'project-repos');
      s.findings.push(...fold.findings);
      if (fold.failed) {
        for (const r of activeRepos) s.actions.push(`  gh repo clone ${OWNER}/${r} "${path.join(sources, r)}"`);
        s.actions.push('  (configs/environments.json activeProjectRepos is the source of truth for this list)');
        bad = true;
      }
      end(s, bad ? 'todo' : 'ok');
    }
  }

  // ==========================================================================
  // Step 3 - the tool set, and git on the MACHINE PATH
  // ==========================================================================
  {
    const s = begin('s3');
    if (!gate(s)) {
      const fold = foldDoctor(doctor, (id) => id === 'node' || id.startsWith('tool:') || id === 'git-machine-path');
      s.findings.push(...fold.findings);
      if (fold.failed) {
        s.actions.push('  Install what env-doctor reports missing (winget on Windows):');
        s.actions.push('    winget install OpenJS.NodeJS / Git.Git / GitHub.cli / Microsoft.AzureCLI / Docker.DockerDesktop');
        s.actions.push('    claude: https://code.claude.com/docs (the harness installs itself)');
        s.actions.push('  If git is missing from the MACHINE PATH, add its directory to the SYSTEM Path');
        s.actions.push('    (Settings > System > About > Advanced system settings > Environment Variables > System variables)');
        s.actions.push('    - an S4U scheduled task cannot see the user PATH, so the 15-min tick fails silently otherwise.');
      }
      end(s, fold.failed ? 'todo' : 'ok');
    }
  }

  // ==========================================================================
  // Step 4 - control-plane secrets, value-blind (D5)
  // Presence only. This tool never reads, echoes, transports or writes a value; the
  // operator copies it env-var to env-var from wherever it already lives.
  // ==========================================================================
  {
    const s = begin('s4');
    if (!gate(s)) {
      const spec = [
        { name: 'LOG_API_KEY', why: 'every call to the central log API' },
        { name: 'GMAIL_APP_PASSWORD', why: 'ws email + the inbox (one password covers both directions)' },
        { name: 'OWNER_EMAIL', why: 'identity - no code default since 2026-07-20' },
        { name: 'AGENT_EMAIL', why: 'identity - no code default since 2026-07-20' },
      ];
      const seen = secretPresence(spec, process.env);
      let bad = false;
      for (const v of seen) {
        if (v.set) s.findings.push({ level: 'OK', msg: `${v.name} is set${v.secret ? ' (value never read by this tool)' : ` = ${v.value}`}` });
        else {
          s.findings.push({ level: 'FAIL', msg: `${v.name} is NOT set - needed for ${v.why}` });
          bad = true;
        }
      }
      // LOG_API_URL is DERIVED from this station's own localPort - never copied verbatim.
      const want = derivedLogApiUrl(tunnel);
      const got = process.env.LOG_API_URL || null;
      if (!want) {
        s.findings.push({ level: 'INFO', msg: 'LOG_API_URL: this station declares no tunnel (it hosts the API) - nothing to derive' });
      } else if (!got) {
        s.findings.push({ level: 'FAIL', msg: `LOG_API_URL is not set - derive it from this station's own logApiTunnel.localPort: ${want}` });
        bad = true;
      } else if (got.replace(/\/$/, '') !== want) {
        s.findings.push({ level: 'FAIL', msg: `LOG_API_URL='${got}' does not match this station's derived value '${want}' - it is derived, not mirrorable` });
        bad = true;
      } else {
        s.findings.push({ level: 'OK', msg: `LOG_API_URL matches the derived value ${want}` });
      }
      if (bad) {
        s.actions.push('  A HUMAN copies each value env-var to env-var. Never paste a secret into a chat or an agent session.');
        s.actions.push('  Windows (a NEW terminal picks these up; setx writes the user environment):');
        for (const v of seen.filter((x) => !x.set)) s.actions.push(`    setx ${v.name} "<the value, from where it already lives>"`);
        if (want && got !== want) s.actions.push(`    setx LOG_API_URL "${want}"`);
        s.actions.push('  Sources: LOG_API_KEY + GMAIL_APP_PASSWORD live in the VM .env and in your password manager.');
        s.actions.push('  Do NOT provision CLAUDE_CODE_OAUTH_TOKEN or GITHUB_TOKEN on a station (rollback lane excepted).');
      }
      end(s, bad ? 'todo' : 'ok');
    }
  }

  // ==========================================================================
  // Step 5 - per-account logins. A human must log in; nothing here is copyable.
  // ==========================================================================
  {
    const s = begin('s5');
    if (!gate(s)) {
      let bad = false;
      const gh = run('gh', ['auth', 'status'], 25000);
      if (!gh.ok) {
        s.findings.push({ level: 'FAIL', msg: 'gh is not authenticated on this station' });
        s.actions.push(`  gh auth login --web        (account ${OWNER}, https protocol)`);
        s.actions.push('  Intended scopes: gist, read:org, repo - deliberately NO `workflow` (.claude/SETUP.md).');
        bad = true;
      } else {
        s.findings.push(...foldDoctor(doctor, (id) => id === 'gh-scopes').findings);
        s.findings.push({ level: 'OK', msg: 'gh is authenticated' });
      }
      const name = run('git', ['config', '--global', 'user.name'], 10000);
      const mail = run('git', ['config', '--global', 'user.email'], 10000);
      if (!name.ok || !name.out || !mail.ok || !mail.out) {
        s.findings.push({ level: 'FAIL', msg: 'global git identity is incomplete' });
        s.actions.push(`  git config --global user.name ${OWNER}`);
        s.actions.push(`  git config --global user.email ${process.env.OWNER_EMAIL || '<your-email, the OWNER_EMAIL value>'}`);
        bad = true;
      } else {
        s.findings.push({ level: 'OK', msg: `git identity ${name.out} <${mail.out}>` });
        if (process.env.OWNER_EMAIL && mail.out !== process.env.OWNER_EMAIL) {
          s.findings.push({ level: 'WARN', msg: `git user.email differs from OWNER_EMAIL (${process.env.OWNER_EMAIL}) - commits will be authored as someone else` });
        }
      }
      // Claude auth: EXISTENCE of the harness credential store, never its content.
      const credStore = path.join(os.homedir(), '.claude', '.credentials.json');
      if (existsSync(credStore) || process.env.CLAUDE_CODE_OAUTH_TOKEN) {
        s.findings.push({ level: 'OK', msg: 'Claude harness credential present (existence checked; contents never read)' });
      } else {
        s.findings.push({ level: 'FAIL', msg: 'no Claude harness credential found on this station' });
        s.actions.push('  Run `claude` once and complete the login in the browser.');
        bad = true;
      }
      end(s, bad ? 'todo' : 'ok');
    }
  }

  // ==========================================================================
  // Step 6 - SSH transport to the log API. PROBE, NEVER ASSUME.
  // ==========================================================================
  {
    const s = begin('s6');
    if (!gate(s)) {
      if (!tunnel) {
        s.findings.push({ level: 'INFO', msg: 'this station declares no logApiTunnel - it hosts the API itself' });
        end(s, 'skipped');
      } else {
        let bad = false;
        const target = String(tunnel.sshTarget || '');
        const host = target.includes('@') ? target.split('@')[1] : target;
        // The VM login user comes from the station's own sshTarget config - never hardcoded.
        const sshUser = target.includes('@') ? target.split('@')[0] : '<vm-user>';
        const idFile = tunnel.identityFile ? String(tunnel.identityFile) : null;

        // (i) the keypair: EXISTENCE only. This tool never reads a key, never generates one.
        const candidates = idFile ? [idFile] : ['id_ed25519', 'id_rsa'].map((f) => path.join(os.homedir(), '.ssh', f));
        const haveKey = candidates.find((c) => existsSync(c)) || null;
        if (haveKey) s.findings.push({ level: 'OK', msg: `ssh private key present at ${haveKey} (existence only - never read)` });
        else {
          s.findings.push({ level: 'FAIL', msg: `no ssh private key at ${candidates.join(' or ')}` });
          bad = true;
        }

        // (ii) known_hosts, seeded from the control plane (no trust-on-first-use)
        const kh = run('ssh-keygen', ['-F', host], 15000);
        const known = kh.status === 0 && /found:/i.test(kh.out);
        if (known) s.findings.push({ level: 'OK', msg: `${host} is in known_hosts` });
        else {
          s.findings.push({ level: 'FAIL', msg: `${host} is NOT in known_hosts` });
          bad = true;
        }

        // (iii) THE measurement: a real connection. Success proves key + host key + NSG
        // in one shot, which is why it runs before any rule is read.
        /** @type {ReturnType<typeof classifySsh>} */
        let sshVerdict = { state: 'unknown', detail: 'not attempted' };
        if (haveKey) {
          const argv = ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8', '-o', 'StrictHostKeyChecking=yes'];
          if (idFile) argv.push('-i', `"${idFile}"`);
          argv.push(target, 'true');
          const probe = run('ssh', argv, 30000);
          sshVerdict = classifySsh(probe.status, probe.out);
          s.findings.push({ level: sshVerdict.state === 'connected' ? 'OK' : 'FAIL', msg: `ssh probe: ${sshVerdict.state} - ${sshVerdict.detail}` });
          if (sshVerdict.state !== 'connected') bad = true;
        }

        // (iv) NSG coverage - MEASURED, not inferred. A successful connection already
        // proved it; only a failure makes the rule worth reading.
        const ip = await publicIp();
        s.findings.push({ level: 'INFO', msg: `this station's public egress IP: ${ip || 'unknown (probe failed)'}` });
        if (sshVerdict.state === 'connected' && !opts.deep) {
          s.findings.push({ level: 'OK', msg: 'NSG coverage: PROVEN by the successful connection above (rule not read - measurement beats inference)' });
        } else if (cp.resourceGroup && cp.nsgName) {
          const q = "[?access=='Allow' && direction=='Inbound'].{name:name,src:sourceAddressPrefix,srcs:sourceAddressPrefixes,port:destinationPortRange}";
          const az = run('az', ['network', 'nsg', 'rule', 'list', '-g', cp.resourceGroup, '--nsg-name', cp.nsgName, '--query', `"${q}"`, '-o', 'json'], 90000);
          /** @type {any[]} */
          let rules = [];
          try {
            rules = JSON.parse(az.out);
          } catch {
            rules = [];
          }
          const sshRules = rules.filter((r) => String(r.port || '') === '22' || String(r.port || '') === '*');
          const cov = nsgCoverage(ip, sshRules);
          s.findings.push({ level: cov.state === 'covered' ? 'OK' : cov.state === 'unknown' ? 'WARN' : 'FAIL', msg: `NSG SSH coverage for ${ip || 'unknown IP'}: ${cov.state}${cov.by ? ` via ${cov.by}` : ''}${az.ok ? '' : ' (az query failed - is `az login` done?)'}` });
          if (cov.state === 'not-covered') bad = true;
        } else {
          s.findings.push({ level: 'WARN', msg: 'configs/environments.json controlPlane.azure is missing - cannot read the NSG rule to compare' });
        }

        // (v) ssh-keyscan - RUN AND REPORTED as evidence, never as the instruction.
        if (!known || opts.deep) {
          const ks = run('ssh-keyscan', ['-T', '8', host], 25000);
          const v = classifyKeyscan(ks.status, ks.out);
          s.findings.push({ level: 'INFO', msg: `ssh-keyscan measured: ${v.state} - ${v.detail}` });
        }

        // (vi) the functional end: does the API actually answer through the tunnel?
        const apiFold = foldDoctor(doctor, (id) => id === 'log-api');
        s.findings.push(...apiFold.findings);
        if (apiFold.failed) bad = true;

        if (bad) {
          s.actions.push('  A HUMAN performs each of these. This tool never mints, installs or reads a key.');
          if (!haveKey) s.actions.push(`    ssh-keygen -t ed25519 -C "${self || 'station'}" -f "${candidates[0]}"`);
          if (cp.resourceGroup && cp.vmName) {
            s.actions.push('    Install the PUBLIC half on the VM through the Azure control plane (no SSH needed first):');
            s.actions.push(`      az vm run-command invoke -g ${cp.resourceGroup} -n ${cp.vmName} --command-id RunShellScript \\`);
            s.actions.push(`        --scripts "echo '<paste the .pub line>' >> /home/${sshUser}/.ssh/authorized_keys"`);
            s.actions.push('    Read the VM\'s REAL host keys from the control plane (this is why keyscan is not the instruction:');
            s.actions.push('    keyscan is trust-on-first-use, the control plane is authenticated):');
            s.actions.push(`      az vm run-command invoke -g ${cp.resourceGroup} -n ${cp.vmName} --command-id RunShellScript \\`);
            s.actions.push('        --scripts "cat /etc/ssh/ssh_host_ed25519_key.pub"');
            s.actions.push(`      then add "${host} ssh-ed25519 <that key>" to %USERPROFILE%\\.ssh\\known_hosts`);
          }
          s.actions.push('  Then re-run this tool - the ssh probe above is the verification.');
        }
        end(s, bad ? 'todo' : 'ok');
      }
    }
  }

  // ==========================================================================
  // Step 7 - per-machine harness config (the class that travels in NOTHING)
  // ==========================================================================
  {
    const s = begin('s7');
    if (!gate(s)) {
      const fold = foldDoctor(doctor, (id) => id === 'harness');
      s.findings.push(...fold.findings);
      if (fold.failed) {
        s.actions.push(`  Edit ${path.join(os.homedir(), '.claude', 'settings.json')} BY HAND so it carries the keys declared in`);
        s.actions.push('  configs/harness-settings.json (today: fallbackModel). The harness reads that file at startup,');
        s.actions.push('  before any workspace code runs, so it can never be repo- or DB-supplied.');
      }
      end(s, fold.failed ? 'todo' : 'ok');
    }
  }

  // ==========================================================================
  // Step 8 - the 15-minute tick (pull + tunnel keeper + fallback replay)
  // ==========================================================================
  {
    const s = begin('s8');
    if (!gate(s)) {
      const fold = foldDoctor(doctor, (id) => id === 'pull-task');
      s.findings.push(...fold.findings);
      const skipped = doctor.some((r) => r.id === 'pull-task' && r.level === 'INFO');
      if (fold.failed) {
        s.actions.push('  Double-click (or run) setup-scripts\\windows\\register-pull-task.cmd');
        s.actions.push('  - the .cmd launcher, never the bare .ps1: the default LocalMachine Restricted policy');
        s.actions.push('    makes an unbypassed .ps1 silently never start. It preflights, self-elevates,');
        s.actions.push('    registers S4U, test-fires, and reports LastTaskResult.');
      }
      end(s, fold.failed ? 'todo' : skipped ? 'skipped' : 'ok');
    }
  }

  // ==========================================================================
  // Step 9 - the acceptance gate. Plumbing green is NOT enough (2026-07-28: a station
  // passed every plumbing gate and still could not do project work).
  // ==========================================================================
  {
    const s = begin('s9');
    if (!gate(s)) {
      let bad = false;
      // (a) env-doctor 0
      if (checksFailed(doctor)) {
        s.findings.push({ level: 'FAIL', msg: 'env-doctor reports at least one FAIL - run `node cli/util-tools/env-doctor.js` for the detail' });
        bad = true;
      } else {
        s.findings.push({ level: 'OK', msg: 'env-doctor: no FAIL' });
      }
      // (b) agent-doctor 0
      const ad = runNode([path.join(ROOT, 'cli', 'util-tools', 'agent-doctor.js')], 120000);
      s.findings.push({ level: ad.ok ? 'OK' : 'FAIL', msg: `agent-doctor: exit ${ad.status}` });
      if (!ad.ok) {
        bad = true;
        s.actions.push('  node cli/util-tools/agent-doctor.js      (read its output - agent/skill frontmatter or README drift)');
      }
      // (c) the suite
      if (opts.fast) {
        s.findings.push({ level: 'WARN', msg: 'test suite skipped (--fast) - the gate is not complete without it' });
      } else {
        const t = runNode(['--test', 'cli/test/*.test.js'], 600000);
        // The default spec reporter and the TAP reporter both carry "pass N ... fail N";
        // matching the numbers only keeps this reporter-agnostic (and ASCII-only).
        const m = /pass (\d+)[\s\S]*?fail (\d+)/.exec(t.out);
        s.findings.push({ level: t.ok ? 'OK' : 'FAIL', msg: `npm test: exit ${t.status}${m ? ` (pass ${m[1]}, fail ${m[2]})` : ''}` });
        if (!t.ok) {
          bad = true;
          s.actions.push('  npm test        (a red suite on a fresh station is usually a missing tool, not a real regression)');
        }
      }
      // (d) a REAL ws query through the tunnel
      try {
        const out = await query({ endpoint: '/summary', params: { days: 7 } });
        s.findings.push({ level: 'OK', msg: `ws query through the tunnel: ${out.trim().split('\n').length} line(s) returned` });
      } catch (e) {
        s.findings.push({ level: 'FAIL', msg: `ws query failed: ${e instanceof Error ? e.message : e}` });
        s.actions.push('  node cli/util-tools/log-api-tunnel.js --status');
        bad = true;
      }
      // (e) the project-work smoke check
      const sources = path.dirname(workspaceDir());
      const smoke = smokeFindings(interactive ? activeRepos : [], (repo) => {
        const dir = path.join(sources, repo);
        const isGit = existsSync(path.join(dir, '.git'));
        const remote = isGit ? run('git', ['-C', `"${dir}"`, 'ls-remote', '--exit-code', 'origin', 'HEAD'], 60000) : { ok: false };
        return { cloned: existsSync(dir), isGit, remoteOk: Boolean(remote.ok), hasClaudeMd: existsSync(path.join(dir, 'CLAUDE.md')) };
      });
      if (!interactive) s.findings.push({ level: 'INFO', msg: 'project-work smoke check: n/a for this station kind' });
      s.findings.push(...smoke);
      if (smoke.some((f) => f.level === 'FAIL')) {
        bad = true;
        s.actions.push('  Clone the missing project repo(s) as SIBLINGS under sources/ (step 2) and confirm `gh auth status`.');
      }
      end(s, bad ? 'todo' : 'ok');
    }
  }

  // ==========================================================================
  // Step 10 - the record. A station nobody can see centrally is not finished.
  // ==========================================================================
  {
    const s = begin('s10');
    if (!gate(s)) {
      let bad = false;
      try {
        const row = await stationRow(self);
        if (row.reported) s.findings.push({ level: 'OK', msg: `station registry: ${row.line}` });
        else {
          s.findings.push({ level: 'FAIL', msg: `station registry: ${row.line}` });
          s.actions.push('  node cli/ws.js station report      (or wait one 15-min Claude-WorkspacePull tick)');
          bad = true;
        }
      } catch (e) {
        s.findings.push({ level: 'WARN', msg: `station registry unreadable: ${e instanceof Error ? e.message : e}` });
      }
      const doc = path.join(ROOT, '.claude', 'environments', 'environments_setup.md');
      const documented = self ? existsSync(doc) && readFileSync(doc, 'utf8').includes(self) : false;
      if (documented) s.findings.push({ level: 'OK', msg: `${self} appears in .claude/environments/environments_setup.md` });
      else {
        s.findings.push({ level: 'FAIL', msg: `${self} is not mentioned in .claude/environments/environments_setup.md` });
        s.actions.push('  Record the outcome there: summary block, a per-environment section, and a dated history line.');
        s.actions.push(`  node cli/ws.js sync "docs: record station ${self}" --paths .claude/environments/environments_setup.md`);
        s.actions.push(`  node cli/ws.js log -a devops -r workspace setup done "station ${self} bootstrapped"`);
        bad = true;
      }
      end(s, bad ? 'todo' : 'ok');
    }
  }

  return { steps, env: self, notes };
}

/**
 * This station's row in the registry, as a one-liner. Absence and staleness are judged
 * control-plane-side (the server computes them at read time), so the verdict is READ,
 * never recomputed here - a station cannot be the judge of its own silence.
 * @param {string|null} env
 * @returns {Promise<{reported: boolean, line: string}>}
 */
async function stationRow(env) {
  if (!env) return { reported: false, line: 'no WS_ENV' };
  const text = await stationList({});
  const line = text.split('\n').find((l) => l.split('|')[0].trim() === env) || '';
  if (!line) return { reported: false, line: `${env} has no row - has this station ticked yet?` };
  const reported = !/NEVER REPORTED|STALE/i.test(line);
  return { reported, line: line.trim() };
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

const SYMBOL = { ok: 'OK  ', todo: 'TODO', blocked: 'WAIT', skipped: 'n/a ' };

/**
 * @param {{steps: Step[], env: string|null, notes: string[]}} walked
 * @param {{all?: boolean, only?: string|null}} opts
 * @returns {string[]}
 */
export function render(walked, opts = {}) {
  /** @type {string[]} */
  const out = [];
  out.push(`station-bootstrap - ${walked.env || 'NO WS_ENV'} @ ${stamp()}`);
  out.push('Workstream S, in dependency order. This tool probes and instructs; a HUMAN performs every credential action.');
  out.push('');
  const firstTodo = walked.steps.find((s) => s.status === 'todo');
  for (const s of walked.steps) {
    out.push(`${SYMBOL[s.status]} ${String(s.n).padStart(2)}. ${s.title}`);
    const verbose = opts.all || s.status !== 'ok' || opts.only === s.id;
    if (verbose) for (const f of s.findings) out.push(`        ${f.level.padEnd(4)} ${f.msg}`);
    const showActions = s.actions.length && (opts.all || s === firstTodo || opts.only === s.id);
    if (showActions) {
      out.push('        --- do this (by hand) ---');
      for (const a of s.actions) out.push(`        ${a}`);
    }
  }
  const sum = summarize(walked.steps);
  out.push('');
  out.push(`Summary: ${sum.ok} satisfied, ${sum.todo} need a human, ${sum.blocked} waiting on a prerequisite, ${sum.skipped} n/a (of ${sum.total}).`);
  if (!sum.todo && !sum.blocked) out.push('This station is fully bootstrapped. Nothing is owed.');
  else if (firstTodo) out.push(`Next: step ${firstTodo.n} (${firstTodo.id}). Do the actions above, then re-run - it is safe to re-run any number of times.`);
  for (const n of walked.notes) out.push(`note: ${n}`);
  return out;
}

// ---------------------------------------------------------------------------
// Entry point - transcript + trap, because the first register-pull-task version left
// zero evidence when it failed and that alone turned one task into four attempts.
// ---------------------------------------------------------------------------

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  // env-doctor's Windows probes must use `shell: true` (gh/az/claude are .cmd shims that
  // execFile cannot launch), which trips Node's DEP0190 warning. In an operator-facing
  // report a stray node warning reads as a failure, so replace the default printer with
  // one that drops that single id and still prints everything else.
  process.removeAllListeners('warning');
  process.on('warning', (w) => {
    if (/** @type {any} */ (w).code === 'DEP0190') return;
    console.error(`${w.name}: ${w.message}`);
  });
  const argv = process.argv.slice(2);
  const stepIdx = argv.indexOf('--step');
  const opts = {
    all: argv.includes('--all'),
    deep: argv.includes('--deep'),
    fast: argv.includes('--fast'),
    only: stepIdx >= 0 ? argv[stepIdx + 1] || null : null,
  };
  /** @type {string[]} */
  const transcript = [];
  /** @param {string} line */
  const say = (line) => {
    const safe = redactSecrets(line, process.env);
    transcript.push(safe);
    console.log(safe);
  };
  let code = 2;
  try {
    const walked = await walk(opts);
    if (argv.includes('--json')) say(redactSecrets(JSON.stringify(walked, null, 2), process.env));
    else for (const line of render(walked, opts)) say(line);
    code = overallExit(walked.steps);
  } catch (e) {
    say(`FAIL station-bootstrap itself failed: ${e instanceof Error ? e.message : e}`);
    if (e instanceof Error && e.stack) say(e.stack);
    code = 2;
  } finally {
    try {
      const dir = path.join(dataDir(), 'setup');
      mkdirSync(dir, { recursive: true });
      const file = path.join(dir, 'station-bootstrap.log');
      appendFileSync(file, `\n===== ${stamp()} exit=${code} argv=${argv.join(' ')} =====\n${transcript.join('\n')}\n`);
      console.log(`\nTranscript: ${file}`);
    } catch (e) {
      console.log(`\n(could not append the transcript: ${e instanceof Error ? e.message : e})`);
    }
  }
  process.exit(code);
}
