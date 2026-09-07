// Scheduled job runner (port of scripts/container/run-job.sh). Owns: run logging,
// network wait, compose via the provider seam, skip-if-exists, compliance audit,
// delivery, audit line. ONE attempt — retries live in the scheduler
// (configs/jobs/jobs.json: retries/retryDelayMin). Per-job compose config
// (prompt, output artifact, delivery, audit areas) lives in the job's own
// `runJob` block in jobs.json — adding a scheduled agent job is a config change,
// not a code change (backlog 6c generalization, 2026-07-21). Outputs and run logs
// live in the per-machine data dir (WS_DATA_DIR), unversioned — the runner stores
// each output as a DB message and pushes nothing.
import { readFileSync, writeFileSync, mkdirSync, appendFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import * as api from './apiclient.js';
import { runAgent } from './agent.js';
import { sendEmail } from './smtp.js';
import { pruneRepo } from './prune.js';
import { today, hourNow, dowNow, stamp, dataDir } from './clock.js';

/** Same slug derivation as apiclient.emailOut — the compliance check must match it. @param {string} s */
export const slug = (s) => {
  let out = s.replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return out.length > 60 ? out.slice(0, 60) : out;
};

// --- pure audit/delivery decisions (exported for tests, TP-runjob) --------------
// Every 2026-07-20 incident lived in this logic; keep it free of I/O so the
// contracts stay pinned by cli/test/runjob.test.js.

/**
 * Classify today's email-out captures for this job's subject ref. The runner tags
 * its own sends (smtp meta sender:'runner'), so a tagged capture is a delivery
 * record from an earlier runner attempt; an untagged capture for this ref can
 * only come from an AI session — a violation. CONTRACT: every legitimate
 * non-agent sender must tag itself, or it will be accused here.
 * @param {{ref?: string, meta?: string}[]} entries
 * @param {string} ref
 * @returns {{agentEmailed: boolean, runnerEmailed: boolean}}
 */
export function classifyEmailCaptures(entries, ref) {
  let agentEmailed = false;
  let runnerEmailed = false;
  for (const m of entries.filter((e) => e.ref === ref)) {
    let sender = '';
    try { sender = JSON.parse(m.meta || '{}').sender || ''; } catch { /* unparseable meta = untagged */ }
    if (sender === 'runner') runnerEmailed = true;
    else agentEmailed = true;
  }
  return { agentEmailed, runnerEmailed };
}

/**
 * Delivery decision from the audit flags. An agent violation wins (its skip is
 * the recorded consequence); a runner capture means an earlier attempt already
 * delivered; otherwise the runner sends.
 * @param {{agentEmailed: boolean, runnerEmailed: boolean}} flags
 * @returns {'skip-agent-violation'|'skip-already-delivered'|'send'}
 */
export function deliveryAction({ agentEmailed, runnerEmailed }) {
  if (agentEmailed) return 'skip-agent-violation';
  if (runnerEmailed) return 'skip-already-delivered';
  return 'send';
}

/**
 * The sanctioned Bash surface of a scheduled compose session, as `--allowedTools`
 * patterns. Claude Code matches Bash rules by LITERAL COMMAND PREFIX, so every
 * invocation form the model actually types must be listed — that is why the CLI
 * appears here both relative to the session cwd (the parent of the workspace) and
 * as an absolute path. 2026-07-26 incident: the digest subagent located the CLI
 * with `find` and then called it absolutely (`node /home/node/sources/workspace/
 * cli/ws.js plan get ...`); the relative-only allowlist answered "This command
 * requires approval" to every ws call, and a headless run has no approver — the
 * whole digest composed with no portfolio, no rolling summary, no COO brief.
 * `query` and `plan` only: `log`/`sync`/`email` stay unreachable by construction,
 * so a compose session cannot write audit lines, push, or send mail even if a
 * prompt constraint gets dropped on the way to a subagent (the runner owns those).
 * @param {string} ws absolute path of the workspace clone
 * @returns {string} comma-separated --allowedTools value
 */
export function composeTools(ws) {
  const abs = path.join(ws, 'cli', 'ws.js');
  const forms = new Set([
    'node workspace/cli/ws.js',
    'node ./workspace/cli/ws.js',
    `node ${abs}`,
    `node ${abs.replace(/\\/g, '/')}`, // git-bash form of a Windows path
  ]);
  const bash = [];
  for (const form of forms) for (const sub of ['query', 'plan']) bash.push(`Bash(${form} ${sub}:*)`);
  bash.push('Bash(printenv:*)');
  return ['Read', 'Write', 'Glob', 'Grep', 'Task', 'WebSearch', 'WebFetch', ...bash].join(',');
}

/**
 * Prompt preamble naming the exact command forms that work in a headless run.
 * The allowlist above is the wall; this is the sign on it — without it the model
 * burns the run discovering the wall by trial and error (2026-07-26: ~10 denied
 * calls, then it gave up on the DB entirely and shipped a gap-flagged digest).
 * @returns {string}
 */
export function composeGuardrail() {
  return [
    'SCHEDULED RUN — no interactive approver exists in this session: any command outside the',
    'sanctioned set below comes back "This command requires approval" and simply fails.',
    'Sanctioned commands (run them verbatim from this session\'s working directory, relative form,',
    'not piped into anything else, no absolute path, no hunting for the CLI with find/ls):',
    '  node workspace/cli/ws.js query ...              — read the audit log',
    '  node workspace/cli/ws.js plan get <slug>        — read a plan',
    '  node workspace/cli/ws.js plan set <slug> --file <path>  — write a plan you own',
    'Logging, email, git and push are the job runner\'s responsibility, deliberately unavailable',
    'here — do not attempt them, and do not report their absence as an error.',
    '',
  ].join('\n');
}

/**
 * Areas whose audit lines were written BY THIS RUN's compose session — the
 * compliance verdict. Date-only matching accused the innocent: on 2026-07-26 the
 * container's 07:00 digest was flagged because a PC session had logged a `digest`
 * line hours earlier the same day (the DB is shared by every environment). The
 * window is the compose session itself, and the runner's own lines never count.
 * @param {{area?: string, ts?: string, agent?: string|null}[]} entries json rows from GET /log
 * @param {string[]} areas the job's agentAuditAreas
 * @param {string} since ISO instant captured immediately before the compose session
 * @returns {string[]} violating areas, in the order given
 */
export function violatingAreas(entries, areas, since) {
  return areas.filter((area) => entries.some((e) => (
    e.area === area && e.agent !== 'runner' && typeof e.ts === 'string' && e.ts >= since
  )));
}

// --- report titles (pure, exported for tests, TP-report-titles) -----------------
// Backlog 72: the compose session may open its output file with a one-line
// headline marker (`Title: <headline>`, documented in the daily-digest skill).
// The runner lifts it into the stored-message and email
// subject and strips it from the delivered body. Parsing is defensive by
// contract: anything missing or degenerate falls back to the base subject —
// a title is polish, never worth failing a delivery.

/**
 * Extract the title marker from a compose output. Only the FIRST non-empty line
 * counts (a "Title:" deeper in the file is prose); bold/heading dressing around
 * the marker is tolerated. Returns the body with the marker line (and the blank
 * line after it) removed; without a usable marker the body is returned untouched.
 * @param {string} content
 * @returns {{title: string|null, body: string}}
 */
export function extractTitle(content) {
  const text = String(content ?? '');
  const lines = text.split(/\r?\n/);
  let i = 0;
  while (i < lines.length && lines[i].trim() === '') i++;
  const m = /^\s*(?:#{1,6}\s+)?\*{0,2}Title\*{0,2}\s*:\s*(.*)$/i.exec(lines[i] ?? '');
  if (!m) return { title: null, body: text };
  let title = m[1].replace(/^[*_\s]+|[*_\s]+$/g, '');
  if (!title) return { title: null, body: text };
  if (title.length > 120) title = `${title.slice(0, 119)}…`;
  let j = i + 1;
  while (j < lines.length && lines[j].trim() === '') j++;
  return { title, body: lines.slice(j).join('\n') };
}

/**
 * Resolve a report's final subject and delivery body from the archived compose
 * output. Titled: subject gains `: <title>` (the base template — and therefore
 * the date and any JOB_TAG — stays intact for mail filters and findability) and
 * the stripped body is delivered from a `.body.md` sibling; the archive file
 * keeps the marker so a delivery-only retry re-derives the identical subject and
 * the email-out dedupe ref stays stable. Untitled: everything passes through.
 * @param {{subject: string, content: string, output: string}} p
 * @returns {{subject: string, title: string|null, body: string, deliverPath: string}}
 */
export function resolveReportTitle({ subject, content, output }) {
  const { title, body } = extractTitle(content);
  if (!title) return { subject, title: null, body, deliverPath: output };
  const deliverPath = output.endsWith('.md') ? `${output.slice(0, -3)}.body.md` : `${output}.body`;
  return { subject: `${subject}: ${title}`, title, body, deliverPath };
}

// --- per-job config resolution (pure, exported for tests, TP-runjob-gen) --------

/**
 * Fill {date}/{output}-style placeholders; unknown placeholders stay intact.
 * @param {string} s @param {Record<string, string>} vars
 */
export const fill = (s, vars) => s.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? vars[k] : m));

/**
 * Catch-up window from the job's own cron — the schedule fact lives once, in
 * the cron field. Fixed numeric hour/day-of-week are gates; anything else
 * (wildcards, steps, ranges) is open (null). Croner's dow 7 = Sunday = 0.
 * @param {string} cron
 * @returns {{hour: number|null, dow: number|null}}
 */
export function cronWindow(cron) {
  const f = String(cron || '').trim().split(/\s+/);
  /** @param {string} [s] */
  const num = (s) => (/^\d+$/.test(s ?? '') ? Number(s) : null);
  if (f.length !== 5) return { hour: null, dow: null };
  const dow = num(f[4]);
  return { hour: num(f[1]), dow: dow === 7 ? 0 : dow };
}

/**
 * @typedef {{
 *   name: string, outputRel: string, output: string, prompt: string,
 *   delivery: 'email'|'none', subject: string, agentAuditAreas: string[],
 *   tools?: string, schedHour: number|null, schedDow: number|null,
 * }} JobRunSpec
 */

/**
 * Resolve a job's `runJob` block from the jobs config into a concrete spec for
 * this date. `outputRel` is the job's path within the data dir (from jobs.json,
 * e.g. `job-out/2026-07-24.md`); `output` is the absolute data-dir path the
 * compose prompt tells the agent to write to. Null when the job is unknown or has
 * no compose config.
 * @param {{jobs?: {name: string, cron?: string, runJob?: Record<string, any>}[]}|null} cfg
 * @param {string} name
 * @param {{date: string, tag?: string, dataDir?: string}} ctx
 * @returns {JobRunSpec|null}
 */
export function resolveJobSpec(cfg, name, { date, tag = '', dataDir = '' }) {
  const entry = (cfg?.jobs || []).find((j) => j.name === name);
  const rj = entry?.runJob;
  if (!rj || !rj.output || !rj.prompt) return null;
  const outputRel = fill(rj.output, { date });
  const output = dataDir ? `${String(dataDir).replace(/[\\/]+$/, '')}/${outputRel}` : outputRel;
  const { hour, dow } = cronWindow(entry?.cron || '');
  return {
    name,
    outputRel,
    output,
    prompt: fill(rj.prompt, { date, output }),
    delivery: rj.delivery === 'email' ? 'email' : 'none',
    subject: fill(rj.subject || `${name} — {date}`, { date }) + tag,
    agentAuditAreas: rj.agentAuditAreas || [],
    tools: rj.tools,
    schedHour: hour,
    schedDow: dow,
  };
}

/**
 * Catch-up (--if-missing) decision: run only when the output is missing AND
 * today is the scheduled day (when the cron fixes one) AND the scheduled hour
 * has passed (when the cron fixes one).
 * @param {{outputExists: boolean, hour: number, dow: number, schedHour: number|null, schedDow: number|null}} p
 */
export function catchUpDue({ outputExists, hour, dow, schedHour, schedDow }) {
  if (outputExists) return false;
  if (schedDow !== null && dow !== schedDow) return false;
  if (schedHour !== null && hour < schedHour) return false;
  return true;
}

/** @param {string} ws @param {string[]} args */
function git(ws, args) {
  return execFileSync('git', ['-C', ws, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

/** Wait up to 5 min for network (restart/catch-up runs can start before the host is online). */
async function waitOnline() {
  for (let i = 0; i < 30; i++) {
    try {
      await fetch('https://api.github.com', { signal: AbortSignal.timeout(5000) });
      return true;
    } catch { /* not yet */ }
    await new Promise((r) => setTimeout(r, 10000));
  }
  return false;
}

/**
 * @param {string} job
 * @param {{ifMissing?: boolean}} [opts]
 * @returns {Promise<number>} exit code (non-zero → the scheduler retries)
 */
export async function runJob(job, { ifMissing = false } = {}) {
  const ws = api.workspaceDir();
  const DATA = dataDir();
  const DATE = today();
  const tag = process.env.JOB_TAG || '';

  const cfgPath = process.env.WS_JOBS_CONFIG || path.join(ws, 'configs', 'jobs', 'jobs.json');
  /** @type {ReturnType<typeof JSON.parse>|null} */
  let cfg = null;
  try { cfg = JSON.parse(readFileSync(cfgPath, 'utf8')); } catch { /* falls through to unknown-job */ }
  const spec = resolveJobSpec(cfg, job, { date: DATE, tag, dataDir: DATA });
  if (!spec) {
    console.error(`ws run-job: unknown job '${job}' — no runJob block in ${cfgPath}`);
    return 1;
  }
  const { outputRel, subject, prompt } = spec;
  const output = path.join(DATA, outputRel);
  // The compose session is delivery-agnostic by construction (Hector 2026-07-19):
  // it produces files and DB reads/writes, nothing else — see composeTools() for
  // the allowlist and why it carries every path form of the ws client.
  const tools = spec.tools || process.env.AGENT_ALLOWED_TOOLS || composeTools(ws);

  const logFile = path.join(DATA, 'jobs', job, `${DATE}.log`);
  mkdirSync(path.dirname(logFile), { recursive: true });
  mkdirSync(path.dirname(output), { recursive: true });
  /** @param {string} line */
  const runlog = (line) => appendFileSync(logFile, `[${stamp()}] ${line}\n`, 'utf8');
  /** @param {string} area @param {string} status @param {string} message */
  const opslog = async (area, status, message) => {
    const r = await api.log({ area, status, message, agent: 'runner' });
    runlog(r.ok ? r.line : `(fallback) ${area} | ${status} | ${message}`);
  };

  if (ifMissing) {
    // Catch-up mode: run only if the job's slot (from its own cron) already
    // passed and the output is missing — for weekly jobs, only on their day.
    if (!catchUpDue({
      outputExists: existsSync(output),
      hour: hourNow(),
      dow: dowNow(),
      schedHour: spec.schedHour,
      schedDow: spec.schedDow,
    })) return 0;
    runlog('catch-up: schedule passed and output missing, running now');
  }

  runlog(`${job} start`);
  if (!(await waitOnline())) {
    await opslog(job, 'failed', 'no network after 5 minutes');
    return 1;
  }

  // Pull before work per CLAUDE.md GitHub sync rules (non-fatal on failure) — the
  // clone stays fresh even though this job no longer pushes anything.
  try { git(ws, ['pull', '--rebase', '--autostash']); } catch { runlog('git pull failed (non-fatal)'); }

  // Compose — skipped when the output already exists (a retry only needs delivery).
  const composeStart = new Date().toISOString(); // raw instant: the compliance window, not a calendar date
  let composedNow = false;
  if (!existsSync(output)) {
    const { code, output: agentOut } = await runAgent(composeGuardrail() + prompt, {
      tools,
      env: { AGENT_ALLOWED_TOOLS: tools, SCHEDULED_RUN: '1' },
    });
    appendFileSync(logFile, agentOut + '\n', 'utf8');
    runlog(`compose session exit ${code}`);
    if (existsSync(output)) {
      composedNow = true;
      await opslog(job, 'done', `output archived ${outputRel}`);
    }
  } else {
    runlog('output already exists, skipping compose — delivery only');
  }

  if (!existsSync(output)) {
    await opslog(job, 'failed', `output file missing after compose: ${outputRel}`);
    return 1;
  }

  // Title lift (backlog 72, TP-report-titles): re-derived from the archived file
  // on EVERY attempt, so a delivery-only retry lands on the identical subject and
  // the email-out dedupe ref below stays stable. No title → base subject, body as-is.
  const report = resolveReportTitle({ subject, content: readFileSync(output, 'utf8'), output });
  if (report.title) {
    writeFileSync(report.deliverPath, report.body, 'utf8');
    runlog(`title: ${report.title}`);
  }
  if (composedNow) {
    try {
      await api.storeMessage({ kind: job, subject: report.subject, ref: `${DATE}-${job}`, bodyPath: report.deliverPath });
    } catch { runlog('message store failed (file remains the source of truth)'); }
  }

  // --- compliance audit (Hector 2026-07-19: surface misbehavior, never hide it) ---
  // Each violation becomes a loud `failed` line; the only correction applied is
  // skipping the runner's own send when the AI already emailed — and that skip is
  // itself logged as the violation, never a silent dedupe.
  try {
    const raw = await api.query({ endpoint: '/log', params: { repo: 'workspace', days: 1, format: 'json' } });
    const entries = /** @type {{entries?: {area?: string, ts?: string, agent?: string|null}[]}} */ (JSON.parse(raw)).entries || [];
    for (const area of violatingAreas(entries, spec.agentAuditAreas, composeStart)) {
      await opslog(`${job}-compliance`, 'failed', `AI session wrote its own audit line (area '${area}') in a scheduled run — the compose prompt forbids logging`);
    }
  } catch { /* audit check skipped when API is down; the fallback md still records the run */ }

  // --- delivery (email jobs only — artifact-only jobs end here) -------------------
  if (spec.delivery === 'email') {
    let agentEmailed = false;
    let runnerEmailed = false;
    try {
      const raw = await api.query({ endpoint: '/message', params: { kind: 'email-out', days: 1, format: 'json' } });
      const entries = /** @type {{entries?: {ref?: string, meta?: string}[]}} */ (JSON.parse(raw)).entries || [];
      ({ agentEmailed, runnerEmailed } = classifyEmailCaptures(entries, `${DATE}-${slug(report.subject)}`));
      if (agentEmailed) {
        await opslog(`${job}-compliance`, 'failed', `AI session already emailed '${report.subject}' in a scheduled run — the compose prompt forbids sending; runner send (the duplicate) skipped, the agent's email-out capture stands as evidence`);
      }
    } catch { /* check skipped when API is down */ }

    let delivered = false;
    const action = deliveryAction({ agentEmailed, runnerEmailed });
    if (action === 'skip-agent-violation') {
      delivered = true;
      runlog('runner send skipped — AI session already delivered (compliance failure logged)');
    } else if (action === 'skip-already-delivered') {
      // Never a silent dedupe: the skip goes on the record.
      delivered = true;
      await opslog(`${job}-email`, 'done', 'duplicate send skipped — an earlier runner attempt already delivered today');
    } else {
      try {
        await sendEmail({ subject: report.subject, bodyPath: report.deliverPath, sender: 'runner' });
        delivered = true;
        await opslog(`${job}-email`, 'sent', 'delivered by ws run-job');
      } catch (e) {
        runlog(`email send failed: ${e instanceof Error ? e.message : e}`);
      }
    }

    if (!delivered) {
      await opslog(job, 'failed', 'email send failed (see log)');
      return 1;
    }
    runlog('done — output archived and delivered');
  } else {
    runlog('done — output archived (artifact-only job, no delivery)');
  }
  // Full history is in the DB (the output is stored as a message above); the data
  // dir keeps a rolling 30-day window — prune rotates it. Nothing is pushed.
  pruneRepo();
  return 0;
}
