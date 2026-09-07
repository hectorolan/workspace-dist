# Workspace Architecture — the whole system on one page

Living document (update when reality changes). Companion docs: SYSTEM.md (operational
spec), SETUP.md (environment state), server/README.md (logging API), CLAUDE.md (rules
every agent follows), setup-scripts/README.md (infrastructure scripts).

## 1. What this system is

A solo-developer operation where Claude agents do the implementation and operations work,
and the CEO reviews, merges, and approves anything irreversible. It runs 24/7 without the
PC being on, communicates with the CEO by email in both directions, keeps an auditable
trail of everything it does, and is designed so any machine can die without losing data.

The motto is **consistency under configuration**: the repo IS the system's
configuration — agents, skills, schedule, environment identity, tools — and every
environment and every run is consistent because they all execute the same
versioned truth. Eight principles explain the decisions:

1. **GitHub is the source of truth.** Every environment syncs through the workspace repo.
   If it's not pushed, it didn't happen.
2. **Scripts own mechanics; AI owns content.** Git pushes, email delivery, audit logging,
   backups, retries are deterministic scripts. Agent sessions only produce content
   (code, reports, replies). This cuts token cost and failure modes at the same time.
3. **Human gates on irreversible actions.** PR merges, production deploys, spending —
   the CEO only. Agents stop and ask when blocked on auth, payments, or migrations.
4. **One path, no fallbacks.** A failing path gets investigated and fixed, never
   quietly detoured around. No dormant alternates, no duplicates that drift.
5. **Tools over turns.** Mechanical, repeatable work runs as forged deterministic
   scripts (`cli/util-tools/`), never through the LLM twice.
6. **Configuration over procedure.** Operational facts are data in git — the
   schedule (`configs/jobs/`), the job-host owner (`configs/environments.json`) —
   not runbooks in anyone's head.
7. **Can't beats don't.** Remove the capability instead of requesting the behavior:
   the digest composer physically cannot email, a non-owner scheduler physically
   cannot arm, a failed dependency install physically cannot half-boot.
8. **Taxonomy is the mental model** (Hector 2026-07-20). Right names and one home
   per capability are what make onboarding, routing, and dedup possible: "does
   this already exist?" must be answerable in seconds ("we currently have a
   health"), or duplicated work slips in unnoticed. Renames that improve the
   taxonomy (`setup-scripts/`, `docs/`) are worth their migration cost; every
   folder explains itself (READMEs); one clock, one client, one sender, one data
   dir are this principle applied to time, API access, email, and runtime state.

## 2. The machines

The roster — which machines exist, what each is for, and the history of every change to
them — is `.claude/environments/environments_setup.md`, not restated here. In shape: one
Azure VM runs the agent container (scheduler + jobs + log API + DB) plus the hub app
behind Caddy/TLS, and the interactive Windows boxes run Claude Code sessions, a windowless
15-minute freshness task, and a local Docker Desktop rollback lane, reaching the log API
over SSH tunnels.

## 3. GitHub repos

| Repo | Contents | Sync rule |
|---|---|---|
| `hectorolan/workspace` (private) | Docs, agent/skill config, automation scripts — **no product code** (digests, reports, inbox captures, run logs and the offline fallback live in the per-machine data dir + DB, never the repo) | Direct on `main` (carve-out so unattended sync works); every change pushed same session via `node cli/ws.js sync` |
| `hectorolan/workspace-backups` (private) | `logs.sql` — nightly SQL text dump of the central DB; git history = retention | Written only by `ws backup` on the VM |
| `hectorolan/hub` (private, renamed from `ho-nexus` 2026-08-16) | Operations hub web app (digest viewer = feature #1) | Full branch → PR → the CEO merges. All project repos work this way, via the agent flow (orchestrator dispatches, implementer codes + opens PR, devops tests/deploys) |
| Future project repos | Product code as passive-income ideas graduate | Same branch → PR flow, sibling clones under `sources/` |

## 4. The Azure VM, layer by layer

```
Azure VM agent-worker (Ubuntu 24.04)
│
├─ ~/agent/workspace                  ← "host clone": docker BUILD CONTEXT only
│   ├─ Dockerfile, docker-compose.yml    (what to build/run)
│   └─ .env                              (all secrets; never in git)
│   • Self-updated by deploy.sh (pulls at the start of every 5-min tick);
│     a manual pull is still step 1 of any rebuild (server/README.md runbook).
│
├─ docker: agent container (workspace-agent-1, restart unless-stopped)
│   ├─ entrypoint: env check → git identity → pull repo in volume → ws ensure-deps →
│   │              start log API (:8790) → ws scheduler (owns boot catch-up)
│   └─ ws scheduler (cli/ws.js + cli/util/scheduler.js, configs/jobs/jobs.json, TZ America/Los_Angeles):
│        07:00 daily   ws run-job daily-digest      → digest file (data dir) → DB message + email (no push)
│                        (Wed: weekly portfolio folded in — daily-digest skill §1)
│        05:30 daily   dependabot-triage            → gh scan; agent session only when a red Dependabot PR exists
│        */15 min      ws run-inbox                 → email requests + hub page comments → orchestrator → reply
│        :07/15 min    ws pull (cli/ws.js)          → pull if remote ahead + PR watch + fallback replay (zero tokens)
│        03:30 daily   ws backup                → logs.sql → workspace-backups
│        1st 03:50     backlog-prune                → prior-month resolved backlog items → history plans
│
├─ docker volume "sources" (survives rebuilds; lost only via `down -v` or VM deletion)
│   ├─ workspace/                     ← LIVE clone; pulls every ≤15 min (the real working copy)
│   ├─ data/                          ← WS_DATA_DIR: logs.db (central SQLite DB, outside any git tree)
│   │                                    + job-out/, jobs/, inbox-tmp/, fallback/log.md (runtime state, 30-day rotation)
│   └─ workspace-backups/             ← clone the backup job pushes from
│
├─ host cron (*/5 min): setup-scripts/deploy/deploy.sh hub
│     pull-based CD — after the CEO merges a PR: fetch main → require green GitHub
│     check runs → rebuild app container → health check → rollback on failure →
│     log via ws. ONE script for all deploys; devops runs the same script
│     manually instead of re-deriving steps (log: ~/agent/deploy.log)
│
├─ docker: hub app (separate compose project at ~/agent/hub)
│   ├─ app (Node, Google OAuth, only the CEO's account)
│   ├─ caddy: TLS for https://ho-nexus.westus2.cloudapp.azure.com (Let's Encrypt)
│   └─ reads digests from the log API (:8790 via host.docker.internal) — the DB is the source (see SETUP.md hub row)
│
└─ docker: hub-staging (separate compose project at ~/agent/hub-staging)
    └─ staging twin on host-local :8081 (no TLS, no login) — deployed by the
       hub CD gh-workflow, not by the host cron (SYSTEM.md)
```
Update paths: **content changes** (scripts, agents, skills, docs) reach the container via
its own git pull within 15 minutes — no rebuild. **Infrastructure changes** (Dockerfile,
compose, .env) need the host clone pulled + `docker compose up -d --build` — deliberate,
human-approved.

## 5. Folder architecture — what lives where

### PC: `C:\Users\olanh\sources\`  (every session starts here)

```
sources\
├─ .claude  → junction into workspace\.claude   (one config, loaded everywhere)
├─ workspace\                                   (the workspace repo, see below)
└─ <project repos as siblings>                  (e.g. hub\ when cloned locally)
```

### The workspace repo (`sources\workspace\`)

```
workspace\
├─ .claude\                  agent system config — tracked, so identical on every machine
│  ├─ CLAUDE.md              the rules: sync, logging, standing rules, model routing
│  ├─ SETUP.md               environment state checklist (living)
│  ├─ agents\                orchestrator / implementer / devops / newsroom / coo definitions
│  ├─ skills\                workspace-authored + vendored external skills (roster: the guarded
│  │                         table in .claude\README.md; upstream pins in skills\sources.json)
│  └─ settings.json          shared settings (e.g. attribution: none)
├─ cli\                      ws.js — the ONE entry point; util\ = shared Node modules;
│                            util-tools\ = forged token-saving scripts. README.md is the
│                            authoritative roster: subcommands + modules + tool inventory
├─ server\                   the log API SERVICE (server.js, conversations, dump/restore, start)
├─ setup-scripts\            infrastructure mechanics (README per folder)
│  ├─ container\             entrypoint.sh (container boot; baked into the image)
│  ├─ deploy\                deploy.sh — VM host CD
│  └─ azure\                 provision.ps1, vm-setup.sh (VM lifecycle / DR)
├─ configs\                  OUR config: jobs\jobs.json (the schedule + timezone),
│                            environments.json (environment inventory + scheduleOwner
│                            + non-sensitive instance config, e.g. backupRepoUrl)
├─ docs\                     architecture.md (this file), container-runtime.md,
│                            live-host-rebuild.md (DR runbook), distribution.md — the
│                            runtime/architecture references not better held as DB plans
├─ README.md                 the solution map (folders, docker, env files)
├─ Dockerfile, docker-compose.yml, .env.example, package.json (npm workspaces)
└─ SYSTEM.md                 operational spec (components, schedules, data locations)
```

Everything ephemeral or derived — digests, reports, inbox captures, run logs, job
outputs, the offline fallback — lives in the per-machine **data dir** (`WS_DATA_DIR`,
default `~/sources/data`, outside every git tree), NOT the repo. The DB is its source
of truth; decision/design/test-plan records are DB `plan` rows (`ws plan`; retired
material keeps its kind under `status: archived`).

## 6. Central logging, message & plans store (since 2026-07-17)

One SQLite DB on the VM replaces all `ops/log.md` file-appends. Headline tables
(full list + definitions: server/README.md and `GET /schema`):

- **`log`** — audit lines: `date | repo | area | status | message` (+ agent, source).
  Every agent operation = ONE call. Statuses: the canonical set in CLAUDE.md
  ("Logging convention").
- **`message`** — full documents: every inbox request/reply, page comment, digest, report.
  Runners store them automatically; deduped on (kind, ref); searchable (`?q=`);
  threaded kinds link to `conversation` rows.
- **`plan`** / **`plan_revision`** — the plans source of truth (since 2026-07-23):
  one row per plan slug, every update snapshots the prior body. Read/write only
  via `ws plan` (endpoints + rules: server/README.md).

Access paths:
- **One client**: `ws` (`node cli/ws.js`) — the full subcommand roster lives in
  cli/README.md (one doc, never restated; server/README.md documents the API). `ws log` falls back to an md line
  if the API is unreachable — nothing is ever lost; both email senders capture
  every sent mail automatically. Every script reuses it; API calls are never
  reimplemented elsewhere.
- **Read**: `node cli/ws.js query --summary` (the orchestrator's whole status sweep in one call),
  `query --messages [--kind|--q]` (message index), `query --message-id <id>` (one document's
  body). Endpoint definitions live in server/README.md (+ `GET /schema` for row counts).
- **From either PC**: an SSH tunnel to the VM (`LOG_API_URL=http://127.0.0.1:8790` +
  `X-Api-Key`); the transport and its self-healing are described in server/README.md
  ("PC (off-host) access"). Each PC opens its own tunnel from its own
  `logApiTunnel` block in `configs/environments.json`. Inside the container it's localhost.
- **Backup/DR**: nightly SQL text dump → `workspace-backups` repo. Restore on any machine:
  clone + `node server/restore.js logs.sql`. The DB is the sole source of truth for
  digests/reports/plans/audit lines, so the nightly dump is the durable copy — worst
  case loses < 24h; a `ws log` line that could not reach the API waits in
  `<WS_DATA_DIR>/fallback/log.md` and is replayed by `ws pull`.

## 7. Agents, skills, models

Models per agent are set in CLAUDE.md "Model routing" (the one source — not restated here).

| Agent | Job |
|---|---|
| orchestrator | Status sweeps (via log API), dispatch, tool forging, portfolio report, inbox handling |
| implementer | Feature/bug work: requirements → test plan → code → PR (project-iteration skill) |
| jr_implementer_github_dependabot | Red Dependabot PRs on the workspace repo only: diagnose, fix without touching tests, merge via the guarded tool (SYSTEM.md "Dependabot red-PR triage") |
| devops | CI pipelines (tests run in Actions, agent reads results), deploys via `deploy.sh` only, container health, log-API/backup health, regression baselines |
| newsroom | Daily digest (reads rolling-summary + last ≤3 digests, never the whole archive); adds 1–2 unvetted idea sparks (daily-digest skill §5) |
| coo | Business operator: on-demand market snapshot, viability gate on product definitions before the implementer (research → demand evidence → validate → go/no-go) |

Skills (tracked in `.claude/skills/`, synced everywhere): the roster is the guarded
table in `.claude/README.md` (workspace-authored + vendored, pinned in
`.claude/skills/sources.json`) — not restated here.

## 8. No-CLI remote control: email + hub page comments

- **Outbound**: scheduler emails digests/reports after archiving (script, not AI).
  Identity: sent from the +agent alias (Reply-To olanhector+agent@gmail.com).
- **Inbound (email)**: mail the CEO sends to olanhector+agent@gmail.com is captured every 15 min →
  one orchestrator session handles it → threaded reply lands in his inbox → request,
  reply, and audit lines stored in the DB (working files in `WS_DATA_DIR`, nothing
  pushed). Any subject works.
- **Inbound (page comments)**: the comment box on any hub page posts a
  `page-comment` message; the same `ws run-inbox` poll picks it up after the email
  poll, dispatches the orchestrator (page context trust-fenced as untrusted), and
  replies by email. Contract + trust boundary: server/README.md.

## 9. Security & guardrails

- Secrets only in `.env` (VM) / user env vars (each PC); never in git, chat, or logs.
- NSG: SSH locked to the PCs' public IPs (one source entry per PC — a new box, or a changed
  IP, means updating that rule); 80/443 public only for the hub's TLS. The log API port is
  not exposed at all — off-host access is the SSH tunnel only (server/README.md).
- The hub sits behind Google OAuth restricted to the CEO's account.
- No AI attribution anywhere (commits/PRs/docs authored as the CEO).
- Human-only: merges, production deploys, `docker compose down -v`, VM deletion.
- Rollback lane: local container on any interactive box (procedure: windows-hosting skill). The supported set is fixed and enumerated in `.claude/environments/environments_setup.md`.

## 10. Token-economy rules baked into the system

1. Audit logging: file-edit + git dance → one HTTP call.
2. Status reads: N markdown files → one summary call.
3. Digest memory: full history scans → the `digest-rolling-summary` plan (DB) + last 3 digests max.
4. Delivery/retry mechanics: always scripts, never agent turns (content jobs push nothing).
5. Scheduled prompts explicitly forbid the AI from logging, emailing, or running git.
