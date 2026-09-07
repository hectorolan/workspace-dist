#!/usr/bin/env node
// ws — the one entry point for workspace mechanics: `node cli/ws.js <command>`.
// Runs identically on Windows and Linux; replaces the PowerShell/bash/Python twins
// phase by phase (`ws plan get 2026-07-19-nodejs-runtime-restructure`).
//
// Full client surface: log-API (log/query/msg/email-out/conv-title/conv-status/plan/thread/health), sync,
// email, pull, scheduler — THE client on every platform; scripts never reimplement it.
//
// util/ is imported RELATIVELY (zero npm install for every command that doesn't
// need a dependency — the freshness net and audit logging must never depend on
// node_modules existing). Forged tools in cli/util-tools/ do the same.
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { pullIfBehind, syncWorkspace } from './util/gitsync.js';
import * as api from './util/apiclient.js';
import { audit } from './util/audit.js';
import { retiredRepos, dropRetiredBlocks } from './util/repos.js';
import { today } from './util/clock.js';

const WORKSPACE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** @param {string} msg @param {number} code @returns {never} */
function die(msg, code) {
  console.error(msg);
  process.exit(code);
}

/**
 * Render a caught error for a degraded-path message. A bare `fetch failed` names
 * nothing that can be acted on — the actionable part is undici's `cause.code`
 * (`ECONNRESET`, `ECONNREFUSED`, `UND_ERR_SOCKET`, …), and a best-effort path that
 * swallows it turns a real, repeatable outage into an unfalsifiable one-liner
 * (windows-pc, 2026-08-18: two syncs in a row failed to advance the baseline with
 * nothing but "fetch failed" to go on).
 * @param {unknown} e
 * @returns {string}
 */
function why(e) {
  if (!(e instanceof Error)) return String(e);
  const cause = /** @type {{code?: string, message?: string}|undefined} */ (
    /** @type {{cause?: unknown}} */ (e).cause || undefined
  );
  const code = cause && (cause.code || cause.message);
  return code ? `${e.message}: ${code}` : e.message;
}

/** @type {Record<string, (args: string[]) => number | Promise<number>>} */
const commands = {
  async pull() {
    const root = process.env.WORKSPACE_DIR || WORKSPACE_ROOT;
    const result = pullIfBehind(root);
    console.log(`ws pull: ${result}`);
    // Self-heal on EVERY tick, not only when this tick's pull landed something:
    // other jobs (run-inbox, run-job) pull the repo themselves, so a lockfile
    // change can arrive between our ticks — the marker comparison is two file
    // reads, and it guarantees deps converge within one pull cycle regardless
    // of which job pulled.
    const { ensureDeps } = await import('./util/deps.js');
    const deps = ensureDeps(root);
    if (deps !== 'ok') console.log(`ws pull: deps ${deps}`);
    if (deps === 'failed') return 1; // loud — investigate, don't limp
    // Self-restart flag (backlog 1): when the pulled range (since this machine's
    // last check) touched server/**, the scheduler, jobs.json, or the lockfile,
    // syntax-gate the changes and touch the restart marker the scheduler consumes
    // between fires (cli/util/selfrestart.js). A broken push writes ONE loud
    // `failed` line (agent `self-restart`) and flags nothing — old code keeps
    // running, never a boot-loop. Inert off the schedule owner (the PC). Runs
    // AFTER ensureDeps on purpose: a lockfile change only flags a restart once
    // the install succeeded. Diagnostic-only — never fails the pull.
    try {
      const { flagRestartIfNeeded } = await import('./util/selfrestart.js');
      const r = await flagRestartIfNeeded({ root });
      if (r.status === 'flagged') console.log(`ws pull: self-restart flagged (${r.detail})`);
      if (r.status === 'check-failed') console.log(`ws pull: self-restart REFUSED broken push — old code keeps running (${(r.failures || []).join('; ')})`);
    } catch (e) {
      console.log(`ws pull: self-restart skipped (${e instanceof Error ? e.message : e})`);
    }
    // Log-API tunnel: environments that reach the API across the internet talk to it
    // through SSH (configs/environments.json → logApiTunnel; no key = no-op, e.g. the
    // container that hosts the API). Ensured BEFORE pr-watch/fallback-replay because
    // both need the API, and this tick is what heals the tunnel after a reboot.
    try {
      const { ensureTunnel } = await import('./util/tunnel.js');
      const t = await ensureTunnel(root);
      if (t !== 'no-config' && t !== 'up') console.log(`ws pull: log-api tunnel ${t}`);
    } catch (e) {
      console.log(`ws pull: log-api tunnel skipped (${e instanceof Error ? e.message : e})`);
    }
    // PR watch: deterministic transition log of open PRs incl. Dependabot — a
    // scripted log writer (CLAUDE.md "Logging convention"; util/prwatch.js).
    // Diagnostic-only: it never throws and never changes this command's exit code.
    try {
      const { sweepPRs } = await import('./util/prwatch.js');
      console.log(`ws pull: pr-watch ${await sweepPRs()}`);
    } catch (e) {
      console.log(`ws pull: pr-watch skipped (${e instanceof Error ? e.message : e})`);
    }
    // Test-plan close, cadence-driven (util/planclose.js sweepFromBaseline): judge
    // this repo's active test-plans against the STORED baseline — by definition
    // the last green run of each suite — so a plan authored AFTER its landing
    // sync's sweep (the dist-phase2-rulings-2026-08-26 stranding: plan revision
    // 631 vs that sync's baseline advance at 629) closes on the next tick instead
    // of waiting for an unrelated push. The `ws sync` sweep stays the fast path on
    // the pushing station; this is the safety net. Idempotent and quiet by
    // construction (a close is terminal; a hold logs on transition only), and an
    // unreadable baseline is a quiet skip retried next tick. Runs BEFORE the
    // status-sweep so a close this tick resolves blocked lines citing it in the
    // same tick. A scripted log writer (agent plan-close — roster: CLAUDE.md
    // "Logging convention"). Diagnostic-only: never changes this exit code.
    try {
      const { sweepFromBaseline } = await import('./util/planclose.js');
      console.log(`ws pull: plan-close ${(await sweepFromBaseline({ repo: 'workspace' })).summary}`);
    } catch (e) {
      console.log(`ws pull: plan-close skipped (${e instanceof Error ? e.message : e})`);
    }
    // Stale-status sweep: resolves (repo, area) pairs whose newest line is
    // non-terminal (PR-open/blocked) but whose work is PROVABLY finished — the
    // cited PR is merged/closed, the cited test-plan is done/archived — so the
    // status board (`ws query --summary`) stops showing finished work as open.
    // Runs AFTER pr-watch so catch-up resolutions written this tick are visible.
    // A scripted log writer (agent status-sweep; util/statussweep.js). Doubt
    // always leaves the line; diagnostic-only, never changes this exit code.
    try {
      const { sweepStaleStatus } = await import('./util/statussweep.js');
      console.log(`ws pull: status-sweep ${(await sweepStaleStatus()).summary}`);
    } catch (e) {
      console.log(`ws pull: status-sweep skipped (${e instanceof Error ? e.message : e})`);
    }
    // Fallback replay: drain <data>/fallback/log.md into the API when it is healthy
    // again, so no offline audit line stays stranded on one machine. The other
    // scripted log writer (with pr-watch) — logs loudly (agent 'fallback-replay')
    // only when a line fails to post while the API is reachable.
    try {
      const { replayFallback, log } = await import('./util/apiclient.js');
      const r = await replayFallback();
      if (r.status !== 'none') console.log(`ws pull: fallback-replay ${r.status} (${r.replayed} replayed, ${r.remaining} remaining)`);
      if (r.status === 'failed') {
        await log({ area: 'fallback-replay', status: 'failed', agent: 'fallback-replay',
          message: `${r.remaining} fallback line(s) failed to replay while the API was reachable — see <data>/fallback/log.md` });
      }
    } catch (e) {
      console.log(`ws pull: fallback-replay skipped (${e instanceof Error ? e.message : e})`);
    }
    // Station registry (W3/D1b, cli/util/station.js): report this station's
    // observed state - the env-doctor payload plus public IP - to the DB, one
    // row per station, last-write-wins (PUT /station/:env). Observed state
    // only; the definition stays in configs/environments.json. Fail-soft by
    // contract: an unreachable API skips the probes entirely, and nothing here
    // can change this tick's exit code or write a log line (scheduled runs
    // don't log - a registry write is state, not an audit line).
    try {
      const { reportStation } = await import('./util/station.js');
      const s = await reportStation();
      console.log(`ws pull: station-report ${s.status}${s.env ? ` (${s.env}${s.status === 'reported' ? `, ${s.ok ? 'ok' : 'FAILING'}` : ''})` : ''}`);
    } catch (e) {
      console.log(`ws pull: station-report skipped (${e instanceof Error ? e.message : e})`);
    }
    // No skills-upstream check here: it moved to the control plane in 2026-07-28
    // (.github/workflows/skills-upstream-sync.yml), so no station is structurally
    // special and none has to be powered on for skills to stay current.
    // Freshness-net semantics: offline / no-repo are quiet no-ops, not failures.
    return result === 'pull-failed' ? 1 : 0;
  },

  async 'ensure-deps'() {
    const { ensureDeps } = await import('./util/deps.js');
    const result = ensureDeps(process.env.WORKSPACE_DIR || WORKSPACE_ROOT);
    console.log(`ws ensure-deps: ${result}`);
    return result === 'failed' ? 1 : 0;
  },

  async log(args) {
    let repo = 'workspace';
    let agent = '';
    while (args[0] === '-r' || args[0] === '-a') {
      const flag = args.shift();
      const val = args.shift() ?? '';
      if (flag === '-r' && val) repo = val;
      if (flag === '-a') agent = val;
    }
    const [area, status, ...rest] = args;
    if (!area || !status || rest.length === 0) {
      die('usage: ws log [-r repo] [-a agent] <area> <status> <message...>', 2);
    }
    const result = await api.log({ area, status, message: rest.join(' '), repo, agent });
    if (result.ok) {
      console.log(result.line);
    } else {
      console.error(`ws log: API unreachable — entry appended to ${result.fallback} instead`);
    }
    return 0; // fallback still recorded the line; never lose an entry, never fail the caller
  },

  async msg(args) {
    const [kind, subject, ref, bodyPath, meta] = args;
    if (!kind || !subject || !ref || !bodyPath) {
      die('usage: ws msg <kind> <subject> <ref> <body-file> [meta-json]\n'
        + '       msg WRITES a document to the store. To READ one: ws query --message-id <id>', 2);
    }
    try {
      console.log(await api.storeMessage({ kind, subject, ref, bodyPath, meta }));
      return 0;
    } catch {
      console.error(`ws msg: message store failed for ${bodyPath} — file remains the source of truth`);
      return 1;
    }
  },

  async 'email-out'(args) {
    const [subject, bodyPath, meta] = args;
    if (!subject || !bodyPath) die('usage: ws email-out <subject> <body-file> [meta-json]', 2);
    try {
      console.log(await api.emailOut({ subject, bodyPath, meta }));
      return 0;
    } catch {
      console.error(`ws email-out: capture failed for ${bodyPath} — file remains the source of truth`);
      return 1;
    }
  },

  async 'conv-title'(args) {
    const [id, ...title] = args;
    if (!id || title.length === 0) die('usage: ws conv-title <conversation-id> <title...>', 2);
    try {
      console.log(await api.convTitle(id, title.join(' ')));
      return 0;
    } catch {
      console.error(`ws conv-title: failed for conversation ${id} — subject-based title remains`);
      return 1;
    }
  },

  async 'conv-status'(args) {
    const [id, status] = args;
    if (!id || (status !== 'active' && status !== 'archived')) {
      die('usage: ws conv-status <conversation-id> <active|archived>', 2);
    }
    try {
      console.log(await api.convStatus(id, status));
      return 0;
    } catch {
      console.error(`ws conv-status: failed for conversation ${id} — status unchanged`);
      return 1;
    }
  },

  async plan(args) {
    const usage =
      'usage: ws plan list [--status <s>] [--kind <k>] | plan get <slug> | plan history <slug> [--limit <n>] | ' +
      'plan set <slug> [--title "<t>"] [--file <path.md> | --body "<md>"] [--kind plan|audit|design|test-plan|doc|baseline] [--status <s>] [--repo <r>] [-a <agent>]' +
      '  (create needs --title + a body; update on an existing slug takes any subset — e.g. --title alone retitles, keeping body + created-date, bumping updated-date, snapshotting a revision)';
    const sub = args.shift();
    if (sub === 'list') {
      const { values } = parseArgs({ args, options: { status: { type: 'string' }, kind: { type: 'string' } } });
      try {
        process.stdout.write(await api.planList({ status: values.status, kind: values.kind }));
        return 0;
      } catch {
        console.error('ws plan list: API unreachable');
        return 1;
      }
    }
    if (sub === 'get') {
      const slug = args[0];
      if (!slug) die(usage, 2);
      try {
        process.stdout.write(await api.planGet(slug));
        return 0;
      } catch (e) {
        console.error(`ws plan get: ${e instanceof Error ? e.message : 'API unreachable'}`);
        return 1;
      }
    }
    if (sub === 'history') {
      const slug = args.shift();
      if (!slug) die(usage, 2);
      const { values } = parseArgs({ args, options: { limit: { type: 'string' } } });
      try {
        process.stdout.write(await api.planRevisions(slug, { limit: values.limit ? Number(values.limit) : undefined }));
        return 0;
      } catch (e) {
        console.error(`ws plan history: ${e instanceof Error ? e.message : 'API unreachable'}`);
        return 1;
      }
    }
    if (sub === 'set') {
      const slug = args.shift();
      const { values } = parseArgs({
        args,
        options: {
          title: { type: 'string' },
          file: { type: 'string' },
          body: { type: 'string' },
          kind: { type: 'string' },
          status: { type: 'string' },
          repo: { type: 'string' },
          agent: { type: 'string', short: 'a' },
        },
      });
      if (!slug || (values.file && values.body)) die(usage, 2);
      if (!values.title && !values.file && !values.body && !values.kind && !values.status && !values.repo) die(usage, 2);
      try {
        const body = values.file
          ? (await import('node:fs')).readFileSync(values.file, 'utf8')
          : values.body;
        const { line, created } = await api.planSet(slug, {
          title: values.title,
          body,
          kind: values.kind,
          status: values.status,
          repo: values.repo,
          agent: values.agent,
        });
        console.log(`${created ? 'created' : 'updated'}: ${line}`);
        return 0;
      } catch (e) {
        // NO md fallback — plans are not append-only log lines. Fail loudly;
        // the calling agent logs `blocked` and stops (design brief 2026-07-23).
        console.error(`ws plan set: FAILED for '${slug}' — ${e instanceof Error ? e.message : e}. Nothing was saved.`);
        return 1;
      }
    }
    die(usage, 2);
  },

  async thread(args) {
    // Document threads (W1, design: ws plan get nexus-document-threads-design) —
    // the READ path: get = one document's thread (entries + full bodies, roles
    // carried, flat order); list = anchors with entry counts, newest activity
    // first (--doc-kind conversation = the document-less threads N2 lists).
    // Bodies are captured page-comment content: untrusted quoted data (WS-H2).
    const usage = 'usage: ws thread get <doc-kind> <doc-ref> [--json] | thread list [--doc-kind <k>] [--limit <n>] [--json]';
    const sub = args.shift();
    if (sub === 'get') {
      const docKind = args.shift();
      const docRef = args.shift();
      if (!docKind || !docRef) die(usage, 2);
      const { values } = parseArgs({ args, options: { json: { type: 'boolean' } } });
      try {
        const t = await api.threadGet(docKind, docRef);
        if (values.json) {
          console.log(JSON.stringify(t, null, 2));
          return 0;
        }
        console.log(`# thread ${t.doc_kind}/${t.doc_ref} — ${t.count} entries`);
        for (const e of t.entries) {
          console.log(`\n--- ${e.role} | ${e.created} | message ${e.message_id}`);
          console.log(e.message.body.trimEnd());
        }
        return 0;
      } catch (e) {
        console.error(`ws thread get: ${e instanceof Error ? e.message : 'API unreachable'}`);
        return 1;
      }
    }
    if (sub === 'list') {
      const { values } = parseArgs({ args, options: { 'doc-kind': { type: 'string' }, limit: { type: 'string' }, json: { type: 'boolean' } } });
      try {
        process.stdout.write(await api.threadList({
          docKind: values['doc-kind'],
          limit: values.limit ? Number(values.limit) : undefined,
          format: values.json ? 'json' : undefined,
        }));
        return 0;
      } catch (e) {
        console.error(`ws thread list: ${e instanceof Error ? e.message : 'API unreachable'}`);
        return 1;
      }
    }
    die(usage, 2);
  },

  async station(args) {
    // The station registry read path (W3/D1b) + the manual on-demand report.
    // list = roster incl. staleness/never-reported findings (judged server-side,
    // control-plane); get = one station's full stored report; report = collect
    // and PUT this station's state right now (what the pull tick does each 15 min).
    const usage = 'usage: ws station list [--stale-minutes <n>] [--json] | station get <env> [--json] | station report';
    const sub = args.shift();
    if (sub === 'list') {
      const { values } = parseArgs({ args, options: { 'stale-minutes': { type: 'string' }, json: { type: 'boolean' } } });
      try {
        process.stdout.write(await api.stationList({
          staleMinutes: values['stale-minutes'] ? Number(values['stale-minutes']) : undefined,
          format: values.json ? 'json' : undefined,
        }));
        return 0;
      } catch {
        console.error('ws station list: API unreachable');
        return 1;
      }
    }
    if (sub === 'get') {
      const env = args.shift();
      if (!env) die(usage, 2);
      const { values } = parseArgs({ args, options: { json: { type: 'boolean' } } });
      try {
        process.stdout.write(await api.stationGet(env, { format: values.json ? 'json' : undefined }));
        return 0;
      } catch (e) {
        console.error(`ws station get: ${e instanceof Error ? e.message : 'API unreachable'}`);
        return 1;
      }
    }
    if (sub === 'report') {
      const { reportStation } = await import('./util/station.js');
      const s = await reportStation();
      console.log(`ws station report: ${s.status}${s.env ? ` (${s.env})` : ''} - ${s.detail}`);
      return s.status === 'reported' ? 0 : 1;
    }
    die(usage, 2);
  },

  async query(args) {
    const { values } = parseArgs({
      args,
      options: {
        summary: { type: 'boolean' },
        messages: { type: 'boolean' },
        repo: { type: 'string' },
        area: { type: 'string' },
        status: { type: 'string' },
        kind: { type: 'string' },
        // --state: page-comment lifecycle filter (waiting|read|answered|never_processed)
        // for --messages — how Hector sees what was dropped (state machine: server/README.md).
        state: { type: 'string' },
        q: { type: 'string' },
        days: { type: 'string' },
        limit: { type: 'string' },
        json: { type: 'boolean' },
        'message-id': { type: 'string' },
        'include-retired': { type: 'boolean' },
      },
    });
    // --message-id <id> is the read half of the message store: `--messages` lists
    // the index (bodies elided), this fetches one whole document. It lives on
    // query — the read command — so scheduled jobs reach it through their
    // existing `ws query` allowlist entry, while `ws msg` (a write) stays out of
    // reach. NOT named --body: that flag already means inline content on
    // `plan set --body "<md>"`, and one flag name must not mean both a document
    // and a pointer to one.
    const msgId = values['message-id'];
    if (msgId !== undefined) {
      if (!/^\d+$/.test(msgId)) {
        die('usage: ws query --message-id <id>   (numeric id, from `ws query --messages`)', 2);
      }
      try {
        process.stdout.write(await api.messageBody(msgId) + '\n');
        return 0;
      } catch (e) {
        // .status present → the API answered and said no; absent → it never answered.
        const status = /** @type {{status?: number}} */ (e).status;
        if (status) {
          console.error(`ws query --message-id: no message ${msgId} (HTTP ${status})`);
          return 3;
        }
        console.error('ws query: API unreachable — fall back to reading <data>/fallback/log.md');
        return 1;
      }
    }
    const endpoint = values.summary ? '/summary' : values.messages ? '/message' : '/log';
    try {
      const text = await api.query({
        endpoint: /** @type {'/log'|'/summary'|'/message'} */ (endpoint),
        params: {
          repo: values.repo,
          area: values.area,
          status: values.status,
          kind: values.kind,
          state: values.state,
          q: values.q,
          days: values.days,
          limit: values.limit,
          format: values.json ? 'json' : undefined,
        },
      });
      // Retired projects stay in the DB (history is never deleted) but drop out
      // of the portfolio sweep, so finished work stops surfacing in the daily
      // digest. --include-retired, or --repo <name>, still reaches them.
      const retired = values.summary && !values['include-retired'] ? retiredRepos() : [];
      process.stdout.write(dropRetiredBlocks(text, retired));
      return 0;
    } catch {
      console.error('ws query: API unreachable — fall back to reading <data>/fallback/log.md');
      return 1;
    }
  },

  async health() {
    try {
      console.log(await api.health());
      return 0;
    } catch {
      console.error('ws health: API unreachable');
      return 1;
    }
  },

  async sync(args) {
    // ws sync "<msg>" [--paths <p1> <p2> ...] [--no-guard] — with --paths only those
    // pathspecs are staged/committed (concurrent-session safety, backlog 32); default
    // stays whole-tree for scheduled runners but prints what it commits (never prompts).
    //
    // ci-guard (backlog 58): this repo is main-direct, so `ws sync` IS the only
    // pre-push gate that exists. The guard runs the affected fast CI subset
    // (util/ciguard.js) and, by default, REFUSES a push that would land main red.
    //  - refuse (default, the interactive agent path): nothing is committed, the
    //    changes stay staged, exit 1, one loud `failed` line, agent `ci-guard`.
    //  - warn (WS_SYNC_GUARD=warn — the seam for any future scheduled runner that
    //    pushes on an agent's behalf): the push LANDS so composed work is never
    //    stranded, and the same loud `failed` line records that main went red.
    //  - --no-guard: explicit human/emergency bypass, also logged as `failed`.
    // A guard that cannot run (no node_modules, timeout, spawn error) degrades to a
    // printed note and allows the push — a broken guard must never lock out a station.
    const noGuard = args.includes('--no-guard');
    args = args.filter((a) => a !== '--no-guard');
    const flag = args.indexOf('--paths');
    const paths = flag >= 0 ? args.slice(flag + 1) : undefined;
    const message = (flag >= 0 ? args.slice(0, flag) : args).join(' ');
    if (!message || (paths && paths.length === 0)) {
      die('usage: ws sync <commit message> [--paths <p1> <p2> ...] [--no-guard]', 2);
    }
    const dir = api.workspaceDir();
    const mode = process.env.WS_SYNC_GUARD === 'warn' ? 'warn' : 'refuse';
    // Imported lazily (and only when the guard is on) so every other ws command
    // keeps its zero-work startup; ciguard.js itself has no npm dependencies.
    // A guard module that fails to LOAD must not take `ws sync` down with it —
    // that would strand every station until someone pushed a fix they could not
    // push. Same reason the preflight body below can only ever allow the push.
    let ciguard = null;
    if (!noGuard) {
      try {
        ciguard = await import('./util/ciguard.js');
      } catch (e) {
        console.log(`ws sync: ci-guard unavailable (${e instanceof Error ? e.message : e}) — proceeding unguarded`);
      }
    }
    // Regression baseline (backlog 59): fetched here, in async context, and handed
    // to the synchronous guard. BEST EFFORT ONLY — an unreachable API, a missing
    // plan or an unparseable body all read as "no baseline" (the ABSENT state),
    // which is normal on a fresh clone and must never wedge a station's sync.
    let baselineMod = null;
    /** @type {import('./util/baseline.js').Baseline|null} */
    let baseline = null;
    if (ciguard) {
      try {
        baselineMod = await import('./util/baseline.js');
        baseline = baselineMod.parseBaseline(await api.planGet(baselineMod.baselineSlug('workspace')));
      } catch {
        baseline = null; // absent / unreachable — reported by the guard, never fatal
      }
    }
    // Plan-scoped temp-tests (backlog 60, util/planreap.js): tests tagged
    // `@plan:<slug>` whose plan has since closed are reaped PRE-commit, so the
    // deletion rides this sync's own commit instead of dirtying the tree after
    // the push. Stateless and idempotent — the plan status IS the state — and
    // conservative: any doubt leaves the file untouched with a note. Skipped
    // with --no-guard (emergency path; the next guarded sync reaps). The
    // baseline strip keeps the removed case IDs and the dropped pass counts
    // from reading as a false regression, both for this sync's compare (the
    // in-memory copy) and for any retried one (the DB write).
    if (ciguard) {
      try {
        const planreap = await import('./util/planreap.js');
        const reap = await planreap.sweepReap({ root: dir });
        for (const n of reap.notes) console.log(`ws sync: reap ${n}`);
        const touched = [...reap.changedFiles, ...reap.deletedFiles];
        if (touched.length) {
          const plansHit = [...new Set([...reap.reapedPlans, ...reap.promotedPlans])].join(', ');
          console.log(`ws sync: reaped plan-scoped tests for ${plansHit} — deleted ${reap.deletedFiles.length} file(s), edited ${reap.changedFiles.length}; rides this commit`);
          if (paths) paths.push(...touched);
          const strip = await planreap.stripBaselinePlan({
            repo: 'workspace',
            removedCaseIds: reap.removedCaseIds,
            reapedSuites: reap.reapedSuites,
            current: baseline,
          });
          if (strip.note) console.log(`ws sync: reap ${strip.note}`);
          if (strip.changed) baseline = strip.baseline;
        }
      } catch (e) {
        console.log(`ws sync: reap skipped (${e instanceof Error ? e.message : e})`);
      }
    }
    // Holder object, not a bare `let`: TS control-flow analysis does not track
    // assignments made inside a closure, so a plain variable would narrow to `never`.
    const held = { guard: /** @type {import('./util/ciguard.js').GuardResult|null} */ (null) };
    const guardModule = ciguard;
    const preflight = !guardModule ? undefined : /** @param {string[]} staged */ (staged) => {
      /** @type {import('./util/ciguard.js').GuardResult} */
      let g;
      try {
        g = guardModule.runCiGuard({ root: dir, staged, mode, commitMessage: message, baseline, today: today() });
      } catch (e) {
        console.log(`ws sync: ci-guard crashed (${e instanceof Error ? e.message : e}) — push allowed, gate skipped`);
        return { ok: true };
      }
      held.guard = g;
      for (const n of g.notes) console.log(`ws sync: ci-guard ${n}`);
      if (g.decision !== 'skip') {
        console.log(`ws sync: ci-guard ${g.decision} — ran ${g.ran.join(', ') || 'nothing'} in ${(g.ms / 1000).toFixed(1)}s`);
      }
      for (const f of g.failures) console.error(`ws sync: ci-guard FAILED ${f.gate} — ${f.summary}`);
      // Baseline findings are printed for every state EXCEPT `matched` (silence is
      // the "nothing moved" signal). They never affect the return value.
      for (const v of g.baselineVerdicts || []) {
        if (v.state !== 'matched') console.log(`ws sync: baseline ${v.detail}`);
      }
      return { ok: g.decision !== 'refuse' };
    };
    /**
     * One loud `failed` line per guard event — never silent (CLAUDE.md). Routed
     * through util/audit.js (backlog 42): the event it records has already
     * happened (a refused push, a bypassed gate, a red main pushed in warn mode),
     * so a failing audit write must be loud and durable rather than an exception
     * that surfaces as a generic `ws sync` failure and loses the compliance line.
     * @param {string} m
     */
    const logGuard = (m) =>
      audit({ area: 'ci-guard', status: 'failed', agent: 'ci-guard', repo: 'workspace', message: m });
    try {
      const { status, staged, leftBehind, warning } = syncWorkspace(dir, message, { paths, preflight });
      if (status === 'refused') {
        console.error(`ws sync: REFUSED — ${staged.length} file(s) stay staged, nothing pushed. Fix the gate, or bypass with --no-guard (logged).`);
        await logGuard(held.guard ? held.guard.logMessage : 'ws sync REFUSED by ci-guard');
        return 1;
      }
      if (status === 'clean') {
        console.log(paths
          ? 'ws sync: nothing to commit within --paths (scoped tree clean after pull)'
          : 'ws sync: nothing to commit (working tree clean after pull)');
      } else {
        console.log(`ws sync: committed and pushed — ${message}`);
        console.log(`ws sync: committed ${staged.length} file(s): ${staged.join(', ')}`);
      }
      if (leftBehind.length) console.log(`ws sync: left uncommitted: ${leftBehind.join(', ')}`);
      if (warning) console.log(warning);
      if (status === 'pushed' && noGuard) {
        await logGuard(`ws sync ci-guard BYPASSED (--no-guard) — pushed unverified, main may be red: ${message}`);
      }
      if (status === 'pushed' && held.guard && held.guard.decision === 'warn') {
        console.error('ws sync: WARN MODE — the push landed anyway; main is RED and needs a fix commit.');
        await logGuard(held.guard.logMessage);
      }
      // Advance the baseline: a push whose test gates ran GREEN is exactly the
      // "last green commit" a baseline records, so the common path maintains itself
      // with no agent turns. Best effort — a write failure prints and never fails
      // the sync, because the push has already landed and the baseline is a record
      // of it, not a gate on it.
      if (status === 'pushed' && baselineMod && held.guard && held.guard.decision === 'pass') {
        const green = Object.fromEntries(
          Object.entries(held.guard.suiteRuns).filter(([, r]) => r.fail === 0 && r.pass > 0)
        );
        if (Object.keys(green).length) {
          try {
            const commit = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim();
            const withCommit = Object.fromEntries(Object.entries(green).map(([s, r]) => [s, { ...r, commit }]));
            const { baseline: next, recorded } = baselineMod.foldGreenRuns(baseline, 'workspace', withCommit, today());
            await api.planSet(baselineMod.baselineSlug('workspace'), {
              title: 'Regression baseline - workspace',
              body: baselineMod.renderBaseline(next),
              kind: baselineMod.BASELINE_KIND,
              status: 'active',
              repo: 'workspace',
              agent: 'ci-guard',
            });
            console.log(`ws sync: baseline advanced to ${commit} — ${recorded.map((s) => `${s}=${next.suites[s].pass} pass`).join(', ')}`);
            // The same green run is the closure evidence for this repo's active
            // test-plans (util/planclose.js). Main-direct repos have no PR merge
            // for the pr-watch sweep to hook, so without this they accumulate
            // forever. Best effort for the same reason as the baseline above:
            // the push has landed, and bookkeeping never undoes it.
            try {
              const planclose = await import('./util/planclose.js');
              // Covered = the BASELINE's cases (this run already folded in), not
              // just this run's. ci-guard picks gates from the staged paths, so a
              // commit touching only cli/ never runs the server suite — and a plan
              // whose cases live there would then look uncovered and could never
              // close, no matter how many green syncs happened. The baseline is
              // exactly "the last green run of each suite", which is the standing
              // evidence this decision needs.
              const covered = new Set(
                Object.values(next.suites || {}).flatMap((s) => s.cases || [])
              );
              const sweep = await planclose.sweepClosures({ repo: 'workspace', covered });
              if (sweep.closed.length) console.log(`ws sync: test-plan(s) closed — ${sweep.closed.join(', ')}`);
              // Name from config, never a literal (CLAUDE.md "The CEO is config"):
              // the module is already loaded here via planclose, so this costs nothing.
              const { ceoName } = await import('./util/ceo.js');
              if (sweep.held.length) console.log(`ws sync: test-plan(s) need ${ceoName()} — ${sweep.held.join(', ')}`);
              for (const n of sweep.notes) console.log(`ws sync: plan-close ${n}`);
            } catch (e) {
              console.log(`ws sync: test-plan sweep skipped (${why(e)}) — push already landed`);
            }
            // Windows/libuv: the hard process.exit() in the dispatcher below can abort
            // (`!(handle->flags & UV_HANDLE_CLOSING)`, src/win/async.c) when it lands
            // while the socket of a request made right after a long execFileSync run is
            // still closing — turning a successful push into exit 127, which every
            // caller reads as failure. A few event-loop turns let the handles finish.
            await new Promise((r) => setTimeout(r, 100));
          } catch (e) {
            console.log(`ws sync: baseline not advanced (${why(e)}) — push already landed, nothing else affected`);
          }
        }
      }
      return 0;
    } catch (e) {
      console.error(e instanceof Error ? `ws sync: ${e.message}` : 'ws sync: failed');
      return 1;
    }
  },

  async scheduler() {
    const { runScheduler } = await import('./util/scheduler.js');
    try {
      await runScheduler({
        root: WORKSPACE_ROOT,
        configPath: process.env.WS_JOBS_CONFIG || path.join(WORKSPACE_ROOT, 'configs', 'jobs', 'jobs.json'),
      });
    } catch (e) {
      console.error(`ws scheduler: ${e instanceof Error ? e.message : e}`);
      return 1; // loud refusal (ownership/config errors) — one live job host only
    }
    return 0; // unreachable — runScheduler resolves only via signal exit
  },

  async 'run-job'(args) {
    const job = args[0];
    if (!job) die('usage: ws run-job <job> [--if-missing]', 2);
    const { runJob } = await import('./util/runjob.js');
    return runJob(job, { ifMissing: args.includes('--if-missing') });
  },

  async 'run-inbox'() {
    const { runInbox } = await import('./util/runinbox.js');
    return runInbox();
  },

  async 'inbox-check'() {
    const { checkInbox } = await import('./util/inbox.js');
    const files = await checkInbox({ log: (l) => console.error(l) });
    for (const f of files) console.log(f);
    return 0;
  },

  async backup() {
    const { backup } = await import('./util/backup.js');
    return backup();
  },

  async email(args) {
    const { values } = parseArgs({
      args,
      options: {
        subject: { type: 'string' },
        'body-path': { type: 'string' },
        to: { type: 'string' },
        'in-reply-to': { type: 'string' },
        html: { type: 'boolean' },
      },
    });
    if (!values.subject || !values['body-path']) {
      die('usage: ws email --subject <s> --body-path <file> [--to addr] [--in-reply-to id] [--html]', 2);
    }
    try {
      const { sendEmail } = await import('./util/smtp.js');
      const { to } = await sendEmail({
        subject: values.subject,
        bodyPath: values['body-path'],
        to: values.to,
        inReplyTo: values['in-reply-to'],
        html: Boolean(values.html),
      });
      console.log(`Sent: '${values.subject}' to ${to}`);
      return 0;
    } catch (e) {
      const code = e instanceof Error && 'code' in e ? e.code : undefined;
      console.error(e instanceof Error ? `ws email: ${e.message}` : 'ws email: failed');
      return code === 'NO_PASSWORD' || code === 'NO_IDENTITY' ? 2 : code === 'NO_BODY' ? 3 : 1;
    }
  },
};

/** @type {Record<string, string>} */
const pending = {
  boot: 'setup-scripts/container/entrypoint.sh (bash by necessity — it bootstraps Node itself)',
};

const argv = process.argv.slice(2);
const cmd = argv.shift();
if (cmd !== undefined && cmd in commands) {
  const code = await commands[cmd](argv);
  // This exit is HARD on purpose (some commands here hold handles open deliberately
  // and would hang under `process.exitCode`), which costs one Windows hazard: exiting
  // while the socket of a request made right after a long `execFileSync` run is still
  // closing aborts with `!(handle->flags & UV_HANDLE_CLOSING)` (src/win/async.c) and
  // replaces the real code with 127 — reproduced 3/3 on 2026-07-28, and a caller reads
  // 127 as failure even though the push landed. A command that ends in an HTTP write
  // after running child processes must therefore drain the loop before returning (see
  // the baseline advance in `sync`); forged tools set `process.exitCode` instead.
  process.exit(code);
}
if (cmd !== undefined && cmd in pending) {
  console.error(`ws ${cmd}: not ported yet — use ${pending[cmd]}`);
  process.exit(3);
}
console.error(
  [
    'usage: node cli/ws.js <command>',
    `ported:  ${Object.keys(commands).join(', ')}`,
    `pending: ${Object.keys(pending).join(', ')}`,
  ].join('\n'),
);
process.exit(2);
