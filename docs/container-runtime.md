# Container runtime — the workspace as a Docker image

The workspace repo is the single source of truth AND the container definition.
**Live host: the Azure VM
`agent-worker` since 2026-07-16** — Docker Desktop on the PC is the local test path and
the rollback host (never both at once).

## How it works

```
Dockerfile                       runtime only: node, git, gh, claude CLI (base major: SYSTEM.md Components)
setup-scripts/container/entrypoint.sh  baked into the image; clones/pulls the workspace at start
cli/util/agent.js               THE provider seam (the only module that knows which AI CLI runs)
cli/util/runjob.js               job runner: network wait, compose, email, audit; output → data dir + DB (no push; retries: scheduler)
cli/util/smtp.js                 Gmail SMTP delivery (GMAIL_APP_PASSWORD env var)
configs/jobs/jobs.json                   schedules, run by `ws scheduler` (the one clock)
docker-compose.yml               production-shaped run (volume + clone from GitHub)
docker-compose.dev.yml           dev override (bind-mount working copy, no jobs, dummy tokens)
.env.example                     documents every secret/config env var
cli/util/inbox.js                capture of the CEO's requests: email over IMAP + hub page comments (see "Email inbox")
cli/util/runinbox.js             inbox loop: capture → orchestrator session → emailed reply
setup-scripts/azure/provision.ps1      creates the Azure VM and deploys (run by the CEO after az login)
setup-scripts/azure/vm-setup.sh        on-VM setup: Docker, swap, clone, compose up (run by provision.ps1)
```

**Key design choice — the image contains no workspace content.** The entrypoint clones
`hectorolan/workspace` into a volume on first start and `git pull --rebase`s on every restart.
That makes GitHub the source of truth (CLAUDE.md sync rules) and gives hot reload for
free: after a PR merges, a container restart — or the pull at the start of every
scheduled job — picks up new agents/skills/jobs with no image rebuild. In-container layout
mirrors this machine: `~/sources/workspace` + `~/sources/.claude → workspace/.claude` symlink,
sessions start from `~/sources`.

## Local testing (Docker Desktop)

```powershell
cd sources\workspace

# 1. Smoke test against the local working copy — no secrets, no GitHub, no job runs:
docker compose -f docker-compose.yml -f docker-compose.dev.yml up --build
#    Expect: entrypoint logs → "starting ws scheduler" → one "[scheduler] armed <job>" line per job. Ctrl-C to stop.

# 2. Interactive shell inside the container:
docker compose -f docker-compose.yml -f docker-compose.dev.yml run --rm agent bash

# 3. Production-shaped run (real clone, scheduler live — will fire real jobs on schedule!):
copy .env.example .env    # then fill in real values
docker compose up -d --build
docker compose logs -f
```

A single real job can be tested inside the shell (2) with real env vars set:
`node cli/ws.js run-job daily-digest` (set `JOB_TAG=" [container test]"`
to mark the email).

## Email inbox — talking to the orchestrator without a CLI (added 2026-07-15)

The agent's address is **`olanhector+agent@gmail.com`** (a Gmail +alias of the owner account —
same inbox; env vars `OWNER_EMAIL`/`AGENT_EMAIL` are REQUIRED — no code defaults since
2026-07-20 — with `MAIL_ACCOUNT` an optional derivation, all documented in .env.example). Outgoing agent mail sets `Reply-To:` to the alias — Gmail rewrites a
non-registered `From:` back to the login address (verified 2026-07-16), but never touches
Reply-To, so hitting reply on any agent email targets the alias regardless of what the From
line shows. The CEO replies to any agent email or composes a new mail **to** the alias, any
subject. (Optional cosmetic upgrade: registering the alias under Gmail Settings → Accounts →
"Send mail as" would make the From actually display as the alias.)
Every 15 minutes `ws run-inbox` (configs/jobs/jobs.json):

1. `cli/util/inbox.js` polls Gmail over IMAP — the server-side search is already narrowed to
   `FROM owner TO agent-alias`, so non-agent mail is never downloaded — and captures
   messages **from `OWNER_EMAIL`**, **addressed to `AGENT_EMAIL`**, **without** the
   `X-Workspace-Agent` header (all agent-sent mail carries it, so agent output is never
   re-captured), and not yet in `<WS_DATA_DIR>/inbox-tmp/processed.log`. Each becomes `<data>/inbox-tmp/<timestamp>-<n>.md`.
2. Each captured request runs one headless orchestrator session (`cli/util/agent.js`,
   tools incl. Bash+Task via `INBOX_ALLOWED_TOOLS`) that handles the request —
   status sweep, dispatch, audit-log updates — and writes `<data>/inbox-tmp/replies/<name>-reply.md`.
3. The reply is emailed back threaded onto the CEO's message (`--in-reply-to`); the
   request/reply are stored as DB messages. Working files stay in the data dir —
   nothing is pushed.
4. After the email poll, the same loop polls the message table for hub
   `page-comment` messages (`cli/util/inbox.js` `checkPageComments`) and handles
   each the same way — orchestrator session (page context trust-fenced as
   untrusted), reply by email, ref recorded in `/seen`. Contract + trust
   boundary: `server/README.md` / `ws plan get page-comments-design`.

Long prompts are fine — the whole email body above the quoted history is the request.
**Security:** email bodies become agent prompts. Gates: from-owner + to-agent-alias +
marker header + processed-ID ledger; the orchestrator's standing rules (never merge/deploy,
human review gate) bound the blast radius. Failures email back an error notice instead of
vanishing. This loop runs only in the container (running it elsewhere too would
double-handle requests). **Moving the agent to its own account later:** create the account,
generate its app password, set `AGENT_EMAIL` + `MAIL_ACCOUNT` + `GMAIL_APP_PASSWORD` in
`.env` — no code change.

## What each secret is for (see .env.example for formats)

| Env var | Used by | Purpose |
|---|---|---|
| `CLAUDE_CODE_OAUTH_TOKEN` (or `ANTHROPIC_API_KEY`) | claude CLI | headless agent sessions |
| `GITHUB_TOKEN` | gh + git (via `gh auth setup-git`) | clone/pull/push, PR workflow |
| `GMAIL_APP_PASSWORD` | cli/util/smtp.js + inbox.js | report delivery (**rotated value only** — SETUP.md) |

## Azure deployment (LIVE since 2026-07-16 — VM at 20.57.149.148, cutover complete)

Production host: VM `agent-worker`, container running 24/7. **Rebuilding it from scratch is
`docs/live-host-rebuild.md`** (the DR runbook: credentials, Azure, container, DB restore,
hub, re-pointing the stations); the two provisioning scripts it leans on are documented in
`setup-scripts/azure/README.md`, and the boot path in `setup-scripts/container/README.md`. This
section keeps only the runtime ops notes:

- `.env` lives at `~/agent/workspace/.env` on the VM (chmod 600); to update secrets:
  `scp .env hector@20.57.149.148:~/agent/workspace/.env`, then `ssh` in and
  `sudo docker compose up -d --force-recreate`.
- The container's Claude auth is the long-lived `CLAUDE_CODE_OAUTH_TOKEN` — **a `/login`
  on any machine can revoke it** (caused a 401 on cutover night); if container jobs 401,
  regenerate with `claude setup-token` and redeploy `.env`.
- SSH is NSG-locked to the interactive boxes' public IPs — update the rule when one changes or
  a new environment is added (procedure: `.claude/SETUP.md` "New environment bootstrap").

**One live host only (or reports double-send):** the container is the sole job runner;
job-host identity is config (`configs/environments.json` `scheduleOwner` + `WS_ENV`).
Rollback procedure: windows-hosting skill. Secrets live in the VM `.env` (chmod 600);
the Key Vault trigger is recorded in SYSTEM.md "Roadmap / deferred".
