# SETUP.md — Environment state (living document)

This file lives at `.claude/SETUP.md`, next to CLAUDE.md. It owns **setup and configuration**: how to stand up an environment, what access the system requires, and how to obtain each piece. **Per-environment status and current config live in `.claude/environments/environments_setup.md`** — record outcomes there, not here. **Any agent that completes a setup step must update the relevant doc in the same session** — the procedure/access detail here, the resulting state there, plus a line in the log at the bottom, **and keep the Quick status block below in sync**. Agents must READ this file before assuming access exists.

## Quick status (agents: read this block, not the whole file — token rule)

- **Shape: one control plane + N stations.** The control plane exists exactly once: the DB + log API, hub, the GitHub org/repos, mail, and the Azure VM `agent-worker` container schedule (the six-job roster lives in `configs/jobs/jobs.json`; spec: SYSTEM.md "Scheduled tasks" — never restated here). Stations are the interchangeable boxes the CEO works from; a station must stay **disposable** ("if this machine died right now, nothing is lost" — one documented accepted exception: the rollback-lane `.env`, see Container runtime). Rollback = run the container locally (Docker Desktop).
- **Working (control plane):** email (Gmail app password, rotated) · central log API (+station SSH tunnels) · CD pipeline (`deploy.sh`, VM cron) · hub deployed (https://ho-nexus.westus2.cloudapp.azure.com) · workspace auto-pull every 15 min everywhere (`ws pull` — container job + PC S4U task running node directly) · skills upstream check as a scheduled gh-workflow.
- **Per-station truth is machine-derived, never prose:** checklist rows below state a requirement and its scope, not per-box completion. `node cli/util-tools/env-doctor.js` checks the station it runs on (the full check roster lives in its inventory row in `cli/README.md` — never restated here); every station also reports its observed state on each 15-min `ws pull` tick — read it centrally with `ws station list|get` (staleness/absence judged control-plane-side). **Standing up or repairing a station is one command:** `node cli/util-tools/station-bootstrap.js` (Windows: double-click `setup-scripts\windows\station-bootstrap.cmd`) — it walks the whole procedure below, probes only, and tells the CEO what is owed; it never performs a credential action.
- **Missing / pending:** the ❌ rows below (hosting-platform CLI, parked; custom pages root on the live host, awaiting the CEO — details in those rows) plus the DB `backlog` plan's awaiting-the-CEO section — this file does not restate the queue. (The 2026-07-28 `GITHUB_TOKEN` transcript exposure is a **ruled accepted risk** as of 2026-08-15 — rationale and reopen conditions in its backlog item.)
- **Pending/deferred work lives in the DB `backlog` plan** (`node cli/ws.js plan get backlog`) — the single queue of improvement items and open decisions; when asked to iterate on pending work, start there. This file only points at it (one-fact-one-doc).
- **Environments — roster, per-box status/current config, and history: `.claude/environments/environments_setup.md`** (the one doc; its summary block is the quick read). **This file owns *how* you set up and configure an environment; that one owns *what* currently exists and in what state.**
- **Identity env vars are required everywhere since 2026-07-20** (no code defaults — see `.env.example`): VM `.env` has all of them; each PC carries `OWNER_EMAIL` + `AGENT_EMAIL` as user env vars (new terminals pick them up) plus `WS_ENV`/`LOG_API_*`.
- If a task needs a ❌ item: follow "Agent protocol for missing access" below. Full detail in the tables that follow — read them only when needed.

## New environment bootstrap

**Run the tool; it is the procedure.** `setup-scripts\windows\station-bootstrap.cmd`
(double-clickable) or `node cli/util-tools/station-bootstrap.js` walks the ten steps below
in dependency order, ends each one in a machine check, and prints the exact command for the
step that is owed. It is **resumable and idempotent** — it holds no state, so every re-run
re-measures and skips whatever is already satisfied. **It never performs a credential
action** (plan decision D5): it verifies that a variable is *set* and, where a real probe
exists, that it *works*; a human does every login, key and secret. Exit 0 = nothing owed.
Behaviour, flags and the transcript: SYSTEM.md "Station bootstrap".

The steps below are what it checks — read them when a step needs doing by hand.
`configs/environments.json` is step 1 because **everything else resolves from it**
(including the tunnel a station needs to reach the DB at all), so nothing works until that
entry exists locally and is pushed.

1. **Add the entry and push it.** `configs/environments.json`: `kind`, `role`, `where`,
   `identifiesAs`, and a `logApiTunnel` block if it is off-host. **Add no capability flag of
   any kind** — a station must stay disposable, so nothing may run only there; work that must
   happen unattended belongs in the control plane (a scheduled gh-workflow or a `jobs.json`
   job). Leave `scheduleOwner` alone unless you are deliberately migrating the job host. Then
   `node cli/ws.js sync` — an unpushed entry is invisible to every other environment, so the
   tool checks `origin/main`, not just the local file. Others pick it up within one 15-min pull.
2. **Clone + link config**: `git clone https://github.com/hectorolan/workspace.git sources/workspace`,
   then Windows `New-Item -ItemType Junction -Path sources\.claude -Target sources\workspace\.claude`
   / Linux `ln -s workspace/.claude sources/.claude`. Preserve any existing
   `settings.local.json` first — it is gitignored and local-only. **Then clone the active
   project repos as siblings** under `sources/` (CLAUDE.md "GitHub sync" rule 6) — an
   interactive box with only `workspace/` cannot start any project work. Which repos those
   are is machine-readable: `activeProjectRepos` in `configs/environments.json`, and
   `env-doctor` fails the station until each one is a sibling clone.
3. **Install the tool set** — node, git, gh, claude, ssh, plus docker on a rollback-lane box
   and az where VM ops happen; `env-doctor` reports presence and version per station kind.
   **git must be on the MACHINE (system) PATH**, not just the user PATH — an S4U task cannot
   see the user PATH, so step 8's tick fails silently otherwise.
4. **Copy the control-plane secrets, value-blind** — `LOG_API_KEY`, `GMAIL_APP_PASSWORD`,
   plus the identity vars `OWNER_EMAIL`/`AGENT_EMAIL`, env-var to env-var, **never rendering
   a value** into a chat, a file or an agent session. Identity vars have no code defaults — a
   misconfigured box must fail fast, not act as the wrong person. On Windows they are user
   env vars and only reach NEW terminals. Do not provision `CLAUDE_CODE_OAUTH_TOKEN` or
   `GITHUB_TOKEN` on a station (the rollback-lane `.env` is the one documented exception).
5. **Per-account logins — a human must do these; nothing here is copyable**: `gh auth login`,
   the global git identity + GCM credential, and Claude auth. Details in the access checklist
   below.
6. **Off-host log API access**: generate an SSH key, install the public half on the VM
   (`az vm run-command` works without needing SSH first), seed `known_hosts` from the host's
   real keys rather than `ssh-keyscan` (no trust-on-first-use), and confirm the NSG SSH rule
   covers the box's public IP — measure it with a real connection, don't assume. The Azure
   resource names those commands need are `controlPlane.azure` in `configs/environments.json`
   (machine-readable, never restated); `station-bootstrap` prints the commands filled in, and
   measures the NSG rule and `ssh-keyscan` instead of asserting either. `LOG_API_URL` is
   **derived** from this station's own `logApiTunnel.localPort` — never copied from another box.
7. **Apply the per-machine harness config**: `~/.claude/settings.json` must carry the keys
   declared in `configs/harness-settings.json` (today: `fallbackModel`). It travels in
   neither the clone nor the DB — a human sets it by hand, and `env-doctor` compares.
8. **Register `Claude-WorkspacePull`** — run `setup-scripts\windows\register-pull-task.cmd`
   (the `.cmd` launcher, never the bare `.ps1` — preflights, self-elevates, registers,
   test-fires, reports `LastTaskResult`; also the repair path if the task goes missing). Needs
   one elevated prompt — S4U registration requires admin, and the S4U logon type is not
   optional (an Interactive one flashes a console window every 15 min). Recipe it encodes:
   the `windows-hosting` skill.
9. **Accept**: `env-doctor` exits 0 (it proves capability, not just connectivity — harness
   config, project-repo clones, tool versions, git on the machine PATH, pull-task
   registration), `agent-doctor` exits 0, `npm test` is green, a real
   `node cli/ws.js query --summary --days 7` comes back through the tunnel, **and the
   project-work smoke check passes** — each active project repo is a sibling clone whose
   `origin` is reachable, because a station can pass every plumbing gate and still be unable
   to do project work (2026-07-28). `station-bootstrap` runs this whole gate as its step 9.
10. **Record the outcome** in `.claude/environments/environments_setup.md` — summary block,
    a per-environment section, and a dated history line — then one `ws log` call and push.
    The station must also appear healthy in `ws station list` after its first `ws pull` tick;
    from then on it reports its own observed state every 15 min.

## Retiring an environment

Delete its entry from `configs/environments.json` and push; the box can no longer identify
itself and `env-doctor` fails there by design. Then unregister its scheduled task, revoke its
SSH key on the VM, and drop its NSG source entry if it had a dedicated one. **If it was the
`scheduleOwner`, move that first** — flip it to a surviving environment and confirm the new
owner armed before retiring the old one. Record it in the environments doc's history.

## Access checklist

Capability-level: what access the setup requires and how to obtain it. Rows state the
**requirement and its scope** — control-plane capabilities exist once and can be `✅ done
(date)`; per-station requirements are never marked complete here, because "done" is not a
fact about the system, it is a fact about one box (recording `fallbackModel` as a flat
capability is exactly how a new station shipped without it). **Per-station truth is
machine-derived** — `env-doctor` on the box, `ws station list|get` centrally — and the
per-station narrative (which box, since when, quirks) lives in
`.claude/environments/environments_setup.md`. Don't record per-box dates here.

| What | Status | Details |
|---|---|---|
| GitHub CLI (`gh`) authenticated | required on every interactive station | `winget install --id GitHub.cli`, then `gh auth login --web` as `hectorolan` (https protocol). **Intended scopes: gist, read:org, repo — deliberately NO `workflow`** (a token that can rewrite gh-workflows is an escalation; the cost is that `gh pr merge` fails on PRs touching `.github/workflows/*` — apply those directly on main via `node cli/ws.js sync`, the git credential can push them). **Caveat:** GitHub OAuth grants are cumulative per ACCOUNT — once anything grants the `workflow` OAuth scope to the GitHub CLI app, every later `gh auth login` on any machine inherits it, and `gh auth refresh` cannot drop a scope. Resetting means revoking GitHub CLI at github.com/settings/applications and re-logging in on **every** box. Verify with `gh auth status`; per-station scope reality → `env-doctor` / `ws station get <env>`. |
| Git identity configured | required on every interactive station | `user.name = hectorolan`, `user.email = olanhector@gmail.com` (global config). Git credential: `git config --global credential.helper "!gh auth git-credential"` — git rides the gh keyring login above, so https git works in non-interactive agent sessions (GCM alone hangs on a credential prompt there — hit live 2026-08-17 on windows-pc; helper unset = every plain fetch/push dies with "terminal prompts disabled"). Verification: `git ls-remote` on a private repo from a non-interactive shell. |
| Hosting platform CLI (e.g. Vercel for Next.js) | ❌ parked | Not owed anywhere today (CEO 2026-07-26). Revives only with a distributable product — trigger and steps live in `ws plan get ai-ops-product-definition`. When triggered: pick platform with the CEO, `vercel login` (or equivalent), record platform + projects here. |
| Staging environment exists | ✅ live (hub-staging; VM pass re-verified 2026-08-25) | `hub-staging` runs as its own compose project at `~/agent/hub-staging` on the VM — host-local :8081, no TLS, no login — deployed by the hub CD gh-workflow via `deploy.sh hub-staging`, not by the host cron (SYSTEM.md "Architecture at a glance"; feature `service-hub-staging` in `configs/features.json`). Future repos record their staging URL(s) here. |
| Actions may open PRs (workspace repo) | ✅ done (verified ON 2026-08-15) | Settings > Actions > General > Workflow permissions > **"Allow GitHub Actions to create and approve pull requests" = ON** (`gh api repos/hectorolan/workspace/actions/permissions/workflow` reports it as `can_approve_pull_request_reviews`). Required for the skills upstream sync's PR path: without it `.github/workflows/skills-upstream-sync.yml` scans fine but `gh pr create` is refused. *Default workflow permissions* stay on **read** — that gh-workflow declares the `contents`/`pull-requests` write it needs in its own `permissions:` block. |
| CI (GitHub Actions) on repos | ✅ done (2026-07-17, PR #3 merged) | hub: Node 22, `npm ci` + `npm test` on every PR and push to main; gates the CD pipeline (verified: deploys of a848179 and 7a614a3 waited for green checks). Template for future repos. Tests run in CI, agents only read results (`gh run list`). |
| CD pipeline (merge → auto-deploy) | ✅ done (2026-07-17) | `setup-scripts/deploy/deploy.sh <app>` + VM host cron (*/5 min). Pull-based, gated on green check runs, health-checked, auto-rollback, logs via ws. Verified live: deployed ho-nexus f156f54 (the merged PR #2 that had never reached the VM) on first run, healthz 200. |
| Weekly portfolio report | ✅ done (2026-07-17) | Folded into the Wednesday daily digest (daily-digest skill section 1); no separate job in the schedule (`configs/jobs/jobs.json`). |
| Model fallback chain (Fable availability→Opus) | required on every interactive station | `fallbackModel` in `~/.claude/settings.json` — the value is declared once in `configs/harness-settings.json`, never copied here. Covers overloaded/unavailable/rate-limited Fable requests. Content-flagged fallback (safety classifier) is automatic on the Anthropic API by default — no config needed. **This file is per-machine user config, NOT the repo's `.claude/settings.json`** — it travels in neither the clone nor the DB, so a human sets it on each station or the implementer/coo run on Fable with no fallback. **Desired state is declared in `configs/harness-settings.json`** (the only home this config class can have: the harness reads the user file at startup, before any workspace code runs) and `node cli/util-tools/env-doctor.js` compares the two and FAILs on drift — a human still applies the change. Per-station status → `ws station`. |
| Email delivery (Gmail app password) | required on every station + the control plane | `GMAIL_APP_PASSWORD` user env var (VM: `.env`) + `ws email` (the one sender on every platform); verified with a real test send. See email-delivery skill. Rotated + verified 2026-07-16 at the Azure cutover (the 2026-07-10→11 settings.local.json exposure is closed). A control-plane secret shared by every station — copy it env-var to env-var without ever rendering the value. |
| Scheduled agent tasks (Task Scheduler) | **removed 2026-07-17** (disabled at cutover 2026-07-16) | `Claude-DailyDigest` + `Claude-WeeklyPortfolio` unregistered and their runner scripts deleted from the repo (git history keeps them); the container schedule (`configs/jobs/jobs.json`, gated by `scheduleOwner`) is the only agent-job schedule. Rollback = the owner flip in the windows-hosting skill. Each PC keeps only `Claude-WorkspacePull` (pure git, S4U logon, recipe in the windows-hosting skill); registration is checked per station by `env-doctor` and visible via `ws station`. |
| Workspace repo on GitHub | ✅ done (2026-07-11) | `github.com/hectorolan/workspace` (private), cloned at `sources\workspace` on every environment (2026-07-12 relocation). `sources\.claude` is a junction/symlink into `workspace\.claude`; sessions start from `sources`. Sync rules in CLAUDE.md ("GitHub sync"); secrets excluded via `.gitignore`. |

Statuses: ❌ not done · ⏳ in progress · ✅ done (date) — control-plane one-time capabilities
only. Per-station rows carry a scope ("required on every interactive station") instead of a
date; their truth is `env-doctor` / `ws station`, never this file.

## Container runtime (Docker → Azure VM)

The workspace repo is the container definition (see `docs/container-runtime.md`). **Live on the
Azure VM since 2026-07-16**; local Docker Desktop is the test bed and rollback host.
**Rebuilding the live host from scratch is `docs/live-host-rebuild.md`** — the DR runbook, and
the one doc that gives each control-plane credential step-level obtain/verify/rotate detail
(the rows below stay capability-level on purpose). Adding or repairing a *station* is the other
case entirely: `station-bootstrap`, above.

| What | Status | Details |
|---|---|---|
| Docker Desktop on the PCs | required on every interactive station (rollback lane) | Installed by the CEO on each interactive box; presence/version checked by `env-doctor`, per-station versions → environments doc |
| Image builds + container smoke test | ✅ done (2026-07-12) | dev-override run: entrypoint, crontab valid, claude/gh/git/python3 present, healthcheck OK |
| `.env` with real secrets for a live run | required per rollback-lane station | `CLAUDE_CODE_OAUTH_TOKEN` via `claude setup-token`, `GITHUB_TOKEN` = gh CLI token, `GMAIL_APP_PASSWORD` = user env var. **Documented accepted exception to station disposability:** this puts control-plane secrets on a station. It passes the disposability test (nothing is *lost* if the box dies) but widens credential blast radius — deliberate and reviewed, so an auditor can tell it apart from drift; outside this lane, stations never hold `CLAUDE_CODE_OAUTH_TOKEN`/`GITHUB_TOKEN` |
| One real job run inside the container | ✅ done (2026-07-12) | Job runner verified end-to-end inside the container with `JOB_TAG=" [container test]"`: claude auth OK, pull OK, skip-compose OK, email delivered, commit pushed from inside the container. Today's runner is `ws run-job <job>` |
| Azure CLI installed | ✅ done (2026-07-15) | az 2.88.0, installed by Hector |
| Azure CLI logged in (`az login`) | ✅ done (2026-07-15) | Logged in as **olavelek@gmail.com** (not olanhector@) — subscription "Azure subscription 1", tenant olavelekgmail.onmicrosoft.com |
| `GMAIL_APP_PASSWORD` rotated | ✅ done (2026-07-16) | New app password in `.env` + Windows user env var, verified with real send. **Confirm the OLD entry is deleted** at myaccount.google.com → Security → App passwords — rotation is complete only when the leaked value is dead |
| Claude OAuth token for container | ✅ done (2026-07-16) | Original token was invalidated by a `/login` on the PC (container got 401); Hector regenerated via `claude setup-token`, new value in `.env`, verified inside the container |
| Email inbox for the orchestrator | ✅ **live** (2026-07-16) | `ws run-inbox` (`cli/util/inbox.js` + `runinbox.js`), every 15 min via `ws scheduler`; verified END TO END: real `Agent:` email captured → orchestrator session → central log + push → threaded reply delivered |
| Azure VM provisioned + compose up | ✅ **live** (2026-07-16) | VM `agent-worker` (B2ats_v2, Ubuntu 24.04) at **20.57.149.148** in `rg-agent-workspace`/westus2, subscription "Azure subscription 1" (olavelek@gmail.com); SSH keys `~/.ssh/id_rsa`, NSG locked to the PC's IP (update rule if PC IP changes). Container running 24/7, healthcheck OK |
| **Cutover: PC → Azure** | ✅ done (2026-07-16) | Azure is the live host — the PC no longer needs to stay on. (PC tasks were disabled at cutover, then fully removed 2026-07-17; rollback is now the local-container path.) |

## Central logging (log API + backups)

The audit trail moved from per-repo `ops/log.md` files to one SQLite table behind the log
API (`workspace/server/`, see its README). Agents log with one `node cli/ws.js log` call and read
status with one `node cli/ws.js query --summary` call; job runners log and push on the AI's
behalf, and both email senders capture every sent mail as kind `email-out`.

| What | Status | Details |
|---|---|---|
| Log API service + clients in the repo (now `server/` + `ws`) | ✅ done (2026-07-17) | Express + node:sqlite server; the one node client `ws` (`cli/ws.js`, offline md fallback) plus dump/restore/import (`server/`) and the daily backup (`cli/util/backup.js`); tested end to end on the PC (write→re-read, summary, import of 59 historical lines, dump→restore roundtrip, offline fallback) |
| `workspace-backups` repo (private) | ✅ done (2026-07-17) | `github.com/hectorolan/workspace-backups` — daily SQL text dump `logs.sql`, git history = retention; restore per `server/README.md` |
| Log API live on VM `agent-worker` | ✅ **live** (2026-07-17) | Container rebuilt (the ws scheduler supervises the API — SYSTEM.md "Log-API supervision"), `/health` OK, `LOG_API_KEY` in VM `.env` (generated on the VM, required by all callers). One-time imports done: 60 ops/log.md lines + 21 documents (digests, reports, inbox conversation) via `import-messages.js`. First `backup.sh` run verified: `logs.sql` pushed to workspace-backups |
| VM self-seeding from backup (restore-on-boot) | ✅ **active** (2026-07-17 — image rebuilt) | entrypoint restores an empty/missing `logs.db` from the `workspace-backups` repo automatically (`restore.js`; no-op on normal restarts). `import-seen.js` run once same day (`/seen` endpoint active). The rebuild also loaded the current crontab (pull-workspace job live, weekly-portfolio trigger gone). A Google Drive second copy was attempted 2026-07-17 and **dropped** (OAuth redirect_uri_mismatch friction, not worth the tokens — Hector's call); git remains the sole backup destination |
| Data-dir rolling window + inbox_seen | ✅ code done (2026-07-17, data-dir move 2026-07-24) | Full digest/report/inbox history lives in the DB; `cli/util/prune.js` rotates the per-machine data dir (`WS_DATA_DIR`: `job-out/`, `jobs/`, `inbox-tmp/`) at 30 DAYS — pure script, no git, nothing pushed. Seen-mail ledger in DB (`inbox_seen`, `/seen` endpoints; `<data>/inbox-tmp/processed.log` = offline fallback); the one-time `import-seen.js` migration ran 2026-07-17 (script removed 2026-07-19, git history keeps it) |
| Email conversations (threading + `/conversation` endpoints) | ✅ **live end to end** (2026-07-17) | `conversation` table + `message.conversation_id` created on boot (idempotent); inbox rows thread automatically (chain → subject → create, see `server/conversations.js`); `ws run-inbox` sets an AI title (one haiku call) on NEW conversations only. Backfill run once: 16 messages → 6 conversations. Tests: `node --test "server/test/*.test.js"` (plan `ws plan get test-plan-email-conversations`). ho-nexus Conversations page deployed (PR #4 → 7a614a3, CD): `LOG_API_URL=http://host.docker.internal:8790` + `LOG_API_KEY` in `~/agent/hub/repo/.env`, `extra_hosts: host.docker.internal:host-gateway` on the app service in `docker-compose.prod.yml`; app→API connectivity verified from inside the app container |
| Off-host environments reach the API | ✅ done (2026-07-17; **encrypted transport 2026-07-25**) | Each off-host box gets its own SSH key, its own `logApiTunnel` block, and its own entry in the NSG SSH rule — per-box keys, fingerprints and setup notes live in the environments doc. Every such environment talks to the API over an **SSH tunnel** (audit WS-M5 — no cleartext key on the public internet): `LOG_API_URL=http://127.0.0.1:8790` + `LOG_API_KEY` as PC **user env vars** (new terminals pick them up; the key value lives only in env/VM `.env`), forwarded to the VM's loopback. Mechanics + self-healing: `server/README.md` ("PC (off-host) access"). The superseded cleartext NSG rule `allow-log-api` (tcp/8790) was **deleted 2026-07-25** — port 8790 is no longer reachable from the internet (verified: direct curl times out, tunnel health OK), so only `default-allow-ssh`/`allow-http`/`allow-https` remain. Verified live 2026-07-25: query/summary through the tunnel, self-heal after ssh kill, re-establish from the `Claude-WorkspacePull` tick |

## HO-Nexus (operations hub web app) — live

The CEO's central operations web app (repo `hub`, sibling under `sources\`, full branch→PR flow) —
the single pane for operations. Its nav and feature inventory live in the hub repo's own docs —
never restated here; the page-comment control-channel contract is in `server/README.md`.
Access: Google login (OAuth), restricted to olanhector@gmail.com. Hosted as
a separate container on the Azure VM.

| What | Status | Details |
|---|---|---|
| Public URL (DNS label on VM IP) | ✅ done (2026-07-16) | `https://ho-nexus.westus2.cloudapp.azure.com` — free DNS label on `agent-workerPublicIP` (static). A custom domain can be added later as an extra OAuth redirect URI. |
| Google OAuth client (Cloud Console) | ✅ done (2026-07-16) | Project `ho-nexus`, external consent screen in Testing mode (only test user: olanhector@gmail.com), web client `ho-nexus-web`. Redirect URIs: `https://ho-nexus.westus2.cloudapp.azure.com/auth/callback`, `http://localhost:8080/auth/callback`. Credentials live in hub's own env files on the VM (`~/agent/hub/repo/.env`, staging's `.env`) as `GOOGLE_OAUTH_CLIENT_ID`/`GOOGLE_OAUTH_CLIENT_SECRET`, declared in `hub/.env.example` — never in the workspace `.env` (verified present 2026-08-01, values never in chat/repo). Note: Testing mode re-prompts consent ~every 7 days; publish the app later if that annoys. |
| NSG ports 80/443 open to Internet | ✅ done (2026-07-16) | `agent-workerNSG` rules `allow-http` (priority 1010, tcp/80) and `allow-https` (priority 1011, tcp/443), source `Internet`. SSH rule (`default-allow-ssh`, restricted to the PC's IP) untouched. Authorized explicitly by Hector for this deploy. |
| TLS reverse proxy (Caddy) on the VM | ✅ done (2026-07-16) | `caddy:2-alpine` container (project `hub`, compose `~/agent/hub/docker-compose.prod.yml`), `Caddyfile` reverse-proxies `ho-nexus.westus2.cloudapp.azure.com` to `app:8080` on the internal compose network. Automatic Let's Encrypt cert obtained on first boot (HTTP-01 via :80); verified via real HTTPS request from the PC (schannel TLS handshake succeeded, no `-k` needed). Certs persisted in `~/agent/hub/caddy_data` (volume, survives container recreation). |
| Repo `hub` (created as `ho-nexus`, renamed 2026-08-16) + app implemented | ✅ **deployed** (2026-07-16) | PR #1 merged by Hector into `main`. Deployed to production: VM cloned `main` at `~/agent/hub/repo` (via `GITHUB_TOKEN` from the agent's `.env`, CRLF-stripped, then remote URL scrubbed back to plain `https://github.com/hectorolan/hub.git` — no token left on disk). Production `.env` (`~/agent/hub/repo/.env`, mode 600, not committed) has real `GOOGLE_OAUTH_CLIENT_ID`/`SECRET`, `BASE_URL=https://ho-nexus.westus2.cloudapp.azure.com`, a freshly generated `SESSION_SECRET`, `AUTH_BYPASS=false`. Live at **https://ho-nexus.westus2.cloudapp.azure.com** — `/healthz` returns 200, `/` redirects 302 to `accounts.google.com` with the correct `redirect_uri`. Existing agent container (`workspace-agent-1`) confirmed still healthy afterward — separate compose project/network, no port collision. Test plan `ws plan get hn-test-plan-2026-07-16-digest-viewer`; `AUTH_BYPASS` confirmed unset/false in production. **Digests source (updated 2026-07-24):** the hub Digests page reads the `daily-digest` message kind from the log API/DB server-side (PR #11) — no `DIGESTS_DIR`, no digest file or volume mount. Source of truth is the DB (churn-test invariant in CLAUDE.md); see hub `CLAUDE.md` ("Digests data"). The earlier `DIGESTS_DIR`/`job-out` file-mount scheme was retired with the file-based reader (dead wiring removed in hub PR #14). |
| Custom pages root (live host) | ❌ awaiting the CEO | The hub's custom-pages feature (hub PRs #56–#58; `HUB_PAGES_DIR` in hub `.env.example`, unset = off) is OFF in production until the live host is wired — a production compose change + app-container recreate, so a CEO/devops action, never agent initiative. The step, in full: (1) `ssh hector@20.57.149.148 "mkdir -p ~/agent/hub/pages"`; (2) in `~/agent/hub/docker-compose.prod.yml`, service `app`, add `HUB_PAGES_DIR: /data/pages` under `environment:` and `- /home/hector/agent/hub/pages:/data/pages:ro` under `volumes:`; (3) `ssh hector@20.57.149.148 "cd ~/agent/hub && docker compose up -d app"` (recreates app only; caddy untouched). When done: flip this row to ✅ with the date — the **host-side path `~/agent/hub/pages` recorded here is the one place agents read it from** (the hub-page-authoring skill points at this row; the bind mount makes new page folders appear live, no further restarts). Pages waiting on this wiring are DB docs `ws plan list --kind doc --status archived` named `hub-page-<slug>`. |


## Agent protocol for missing access

If a task needs access marked ❌:
1. Don't fail silently and don't fake it. Tell the CEO exactly what's missing.
2. Offer to run the setup together, step by step (e.g. "run `gh auth login`, pick GitHub.com, pick browser login, then press enter — tell me when done").
3. When it works (verify with a real command, e.g. `gh auth status`), record it: a control-plane row flips to ✅ with today's date here; a per-station requirement keeps its scoped row unchanged — the outcome goes in the environments doc and is proven by `env-doctor` / `ws station`. Either way, append to the log below.

## Setup log

Access/capability milestones. **Environment-level changes — a box added, removed, migrated,
or cut over — go in `.claude/environments/environments_setup.md` ("Change history"), not
here.** Lines below predating 2026-07-28 are kept verbatim as the historical record.

<!-- agents append lines here: 2026-07-10 | gh auth | done by implementer with Hector -->
2026-07-10 | model fallback chain | done by Claude — set fallbackModel: ["opus"] in ~/.claude/settings.json; also removed two orphaned agent-file copies from ~/.claude/skills/ (implementer-agent/, orchestrator-agent/) that had no SKILL.md and weren't registering as skills
2026-07-10 | gh auth | done — installed GitHub CLI via winget, ran `gh auth login --web`, Hector completed the device-code authorization; logged in as hectorolan
2026-07-10 | git identity | done by Hector — set global user.name=hectorolan, user.email=olanhector@gmail.com; verified via `git config --global user.name/user.email`
2026-07-10 | email delivery | done — Hector chose Gmail app password; stored as user env var GMAIL_APP_PASSWORD (never in files); scripts/send-email.ps1 created; verified with test send to olanhector@gmail.com
2026-07-10 | scheduled tasks | done — Claude-DailyDigest (daily 7am) + Claude-WeeklyPortfolio (Wed 9am) registered with StartWhenAvailable + WakeToRun; runner scripts in scripts/, output to logs/
2026-07-11 | workspace repo | done — git init at workspace root, pushed to private github.com/hectorolan/workspace; .gitignore excludes settings.local.json/.secrets/.env; .gitattributes pins LF for Android scripts, CRLF for ps1; sync rules added to CLAUDE.md ("GitHub sync" section)
2026-07-12 | config junction | done — sources\.claude replaced with a junction into sources\workspace\.claude; sessions now start from sources and see all project repos; bootstrap step added to CLAUDE.md rule 5
2026-07-12 | container runtime | done — Dockerfile + compose + jobs/crontab + scripts/container/ added (PR feat/container-runtime); image built and smoke-tested on Docker Desktop; live-run secrets and Azure VM still pending (see Container runtime section)
2026-07-12 | container live test | done — .env populated from this PC's credentials (claude setup-token by Hector, gh CLI token, GMAIL_APP_PASSWORD env var); real daily-digest job ran in the container: auth + email + git push all verified
2026-07-15 | azure resume + email inbox | done by Claude — Hector installed az CLI 2.88.0 (login pending); built the orchestrator email inbox (check-inbox.py/run-inbox.sh, 15-min cron, X-Hector-Agent header on outgoing mail, IMAP verified live); wrote setup-scripts/azure/provision.ps1 + vm-setup.sh + cutover.ps1. Remaining before 24/7 Azure: az login, rotate GMAIL_APP_PASSWORD, run provision.ps1, run cutover.ps1
2026-07-15 | azure VM staged | done by Claude (overnight, Hector asleep) — az login by Hector (olavelek@gmail.com subscription); VM agent-worker created at 20.57.149.148; vm-setup.sh ran clean (Docker 29.6.1, 2G swap, repo cloned, image built, entrypoint + supercronic verified); container STOPPED pending Gmail rotation (its .env has the password blank — exposed value never left the PC); SSH narrowed to PC IP; one-time Claude-ChangeOverview task registered for 07:30 to email Hector the briefing + next steps
2026-07-16 | ho-nexus DNS label | done by Claude — az network public-ip update set dns-name ho-nexus on agent-workerPublicIP; https://ho-nexus.westus2.cloudapp.azure.com reserved as the app URL; Google OAuth client walkthrough handed to Hector
2026-07-16 | CUTOVER COMPLETE | done by Claude with Hector — Gmail app password rotated (via notepad, never in chat; test send OK); container Claude token 401'd (PC /login had revoked it), Hector regenerated via claude setup-token; .env pushed to VM, container recreated; inbox verified end to end (real email captured → orchestrator handled → reply delivered + pushed); PC tasks Claude-DailyDigest/WeeklyPortfolio disabled. Azure is now the live host
2026-07-16 | skills sync | done by Claude — all 4 skills moved from PC-local ~/.claude/skills into workspace/.claude/skills (repo-tracked); user-level copies deleted; verified live inside the VM container after pull: skills + agents all visible at ~/sources/.claude
2026-07-16 | ho-nexus production deploy | done by Claude, authorized by Hector — opened NSG ports 80/443 on agent-workerNSG (Internet, SSH untouched); cloned ho-nexus main to ~/agent/ho-nexus/repo on the VM; stood up ~/agent/ho-nexus/docker-compose.prod.yml (app + caddy:2-alpine, project name ho-nexus, own network, ports 80/443 on caddy only); Caddy obtained a real Let's Encrypt cert for ho-nexus.westus2.cloudapp.azure.com on first boot; production .env (mode 600, gitignored, not committed) has real OAuth creds + fresh SESSION_SECRET + AUTH_BYPASS=false; verified end to end from the PC: /healthz 200, / redirects 302 to accounts.google.com with the correct redirect_uri, valid TLS (no -k needed); existing workspace-agent-1 container confirmed still healthy, unaffected (separate compose project/network)
2026-07-17 | workspace auto-pull | done by Claude — scripts/pull-workspace.sh (container crontab :07/15min + Termux crontab) and pull-workspace.ps1 (PC task Claude-WorkspacePull, every 15 min, registered + verified LastTaskResult 0); pure git freshness net so agents/skills/docs stay current in every environment; android crontab.txt paths fixed to the workspace-subfolder layout and its weekly-portfolio lines removed
2026-07-17 | environment scope | done by Claude, decided by Hector — supported environments narrowed to Windows PC + Docker container; scripts/android/ + docs/android-migration-plan.md removed (git history keeps them); all doc references scrubbed
2026-07-17 | email conversations | done by Claude (implementer) — conversation table + threading in the log API (chain → subject → create), /conversation endpoints, logapi conv-title, AI title in run-inbox.sh (one haiku call on new conversations), check-inbox.py captures In-Reply-To/References, api/backfill-conversations.js one-time grouping, api test suite (18 cases). Activates at the next VM container restart; then run backfill once in the container
2026-07-17 | conversations activation | done by Claude, gated by Hector (PR #4 merged) — VM container rebuilt (restore-on-boot + new crontab + conversation endpoints live), import-seen + backfill run (16 msgs → 6 conversations), ho-nexus 7a614a3 deployed via deploy.sh with LOG_API env + extra_hosts in prod config; verified: /conversation from PC and from inside the app container, supercronic fresh crontab read
2026-07-17 | PC job lane removed | done by Claude, decided by Hector — Claude-DailyDigest/WeeklyPortfolio unregistered from Task Scheduler; run-daily-digest.ps1, run-weekly-portfolio.ps1, run-change-overview.ps1, azure/cutover.ps1 deleted from the repo (git history keeps them); rollback path is now the container on local Docker Desktop; windows-hosting skill rewritten; only Claude-WorkspacePull remains on the PC
2026-07-19 | PC task on S4U | done by Claude, UAC approved by Hector — Claude-WorkspacePull switched to S4U logon with plain `node.exe cli\ws.js pull` action; verified in the S4U session (test-fire captured `ws pull: up-to-date` = private-repo git auth works there); vbs/ps1 launchers deleted; recipe documented in the windows-hosting skill (template for any future PC job lane)
2026-07-19 | ws scheduler live | done by Claude, rebuild run by Hector — Node restructure phase 2a deployed on the VM: container rebuilt, `ws scheduler` (configs/jobs/jobs.json, croner) is PID 1 and the one clock; supercronic totally removed (Hector: one path, no fallback; rollback = git revert + rebuild); all 4 jobs armed on America/Los_Angeles, boot catch-up no-op verified, first workspace-pull tick exit 0, healthcheck (pgrep ws.js scheduler) healthy, log API intact (217 entries). Acceptance: 2026-07-20 07:00 digest arrives once
2026-07-28 | new environment windows-pc-2 | done by Claude with Hector — third environment added; full record (what changed, findings, open items) in `.claude/environments/environments_setup.md` "Change history"
2026-08-16 | project repo renamed hub | done by Claude (implementer), authorized by the CEO — GitHub repo hectorolan/ho-nexus renamed hectorolan/hub (old URLs redirect, deploy cron and station remotes unaffected), local clones renamed sources/hub, activeProjectRepos now ["hub"], reference sweeps: hub PR #45 + this workspace sync. Kept: DNS label ho-nexus.westus2, Google Cloud project/redirect URIs, VM-local dirs/cron/runner label (devops VM pass pending). Visibility flip = the CEO's step 5, not done.
2026-08-25 | hub rename: VM pass verified + doc sweep | done by Claude (devops) — live VM re-verified read-only: `~/agent/hub` + `~/agent/hub-staging`, cron `deploy.sh hub`, compose projects `hub`/`hub-staging`, both clones on `hectorolan/hub.git`; no self-hosted runner is registered on the repo (hub cd-staging.yml already asks for label `hub-vm`, and the deploy job is gated off by unset `CD_STAGING_ENABLED`), so nothing on the host still carries the old name. Current-truth docs swept the same day (live-host-rebuild.md, architecture.md, setup-scripts/README.md, server/README.md, .env.example, docker-compose.yml, env-doctor.js, the VM-path rows above). Remaining `ho-nexus` in the repo is deliberate: the DNS label/URL, the Google Cloud project + `ho-nexus-web` client + redirect URIs, `hubTitle` in configs/environments.json (the CEO's page title), dated provenance lines and test fixtures.
