# Rebuilding the live host (DR runbook)

The live host is the **control plane**, and there is exactly one of it: the Azure VM
`agent-worker`, the workspace container it runs, the log API and the SQLite DB behind it,
hub, and the deploy pipeline. If it is lost, the audit trail, the plans, the digests and
the conversation history go with it - and the rebuild happens with every DB-hosted document
unreachable. That is why this is a repo file: it must be readable from a fresh clone with the
API down (CLAUDE.md churn test, bootstrap/offline override).

**Scope: the live host only.** Adding or repairing a *station* (an interactive box the CEO works
from) is the cheap, automated case and is not covered here - run
`node cli/util-tools/station-bootstrap.js` and read `.claude/SETUP.md` "New environment
bootstrap". Only section 8 below touches stations, and only to say what a rebuilt host forces
them to re-point.

**How this doc relates to the other three.** `.claude/SETUP.md` owns *what access the system
requires and how to obtain a capability*; `.claude/environments/environments_setup.md` owns
*what exists right now and in what state*; `configs/environments.json` and `.env.example` own
the *values and the variable list*. This file owns only the **order of a rebuild and the proof
at each step**. Where a fact lives in one of those, this file points at it.

**Rule for the whole procedure (plan decision D5): verify and instruct.** A human performs every
credential action. Nothing here tells you to write a script that handles a secret value, and no
command below prints one. The 2026-07-28 `GITHUB_TOKEN` leak came from a generated helper
handling a token.

---

## 0. What is lost, and what is not

| Thing | Recoverable from | Effort |
|---|---|---|
| The VM, Docker, the container image | `setup-scripts/azure/` + the repo | minutes, scripted |
| Agents, skills, configs, jobs, code | the workspace repo clone | free, it is the clone |
| **The DB: audit log, plans, digests, conversations, seen-mail ledger** | **the `workspace-backups` repo, up to the last 03:30 dump** | **section 6 - the only irreplaceable thing here** |
| Secrets | nowhere. Every one is re-created or re-issued (section 2) | the long pole |
| hub prod compose + Caddyfile | nowhere - they live only on the VM. Reconstruct per section 7 | see backlog item 8 |
| Let's Encrypt certificate | re-issued automatically once DNS + port 80 are right | minutes |

Everything except row 3 is rebuildable. **Treat section 6 as the gate: do not let the system run
a full day before you have proved the DB restored,** because `ws backup` will dump whatever is
in the DB over `logs.sql` at 03:30 (see the warning in that section).

---

## 1. Order of operations

```
1  Azure: subscription, resource group, VM, disk        section 3
2  NSG: ssh + http + https                              section 3
3  DNS label on the new public IP                       section 3
4  Host packages: docker, node, python3, cron           section 4
5  .env: every credential in section 2                  section 2
6  Container up; VERIFY THE DB RESTORED                 sections 5 + 6
7  hub: prod compose, Caddy, .env, deploy cron          section 7
8  Re-point the stations                                section 8
9  Acceptance                                           section 9
```

`setup-scripts/azure/provision.ps1` + `vm-setup.sh` automate parts of 1, 2, 4 and 6. They do
**not** cover 3, 5, 7 or 8, and their known gaps are listed in section 10. Run them, then work
this list; do not assume the scripts finished the job.

---

## 2. Credentials - purpose, obtain, verify, rotate

`.env.example` is the authoritative list of variables and their formats; it is not restated here.
This section covers only the ones that must be **created or re-issued** for a rebuilt host, in
the order you will want them. On the VM they all live in one file, `~/agent/workspace/.env`,
mode 600, never committed.

**Value discipline, every row below:** type or paste the value directly into the VM's `.env`
over SSH (or into an editor on the VM). Never echo it, never put it in a chat, a commit, a
script, an agent prompt, or a shell command line that another process can read from `ps`.

### 2.1 Azure subscription access

- **For:** creating and administering every Azure resource in section 3.
- **Obtain:** it is an existing Microsoft/Azure account, not a secret you generate. Note the
  identity is **not** the GitHub identity - see the "Azure CLI logged in" row in
  `.claude/SETUP.md` for which account owns the subscription.
- **Verify:** `az account show` prints the expected subscription name and id.
- **Rotate:** account-level; nothing in this repo holds an Azure credential.

### 2.2 `GITHUB_TOKEN`

- **For:** cloning/pulling the private workspace repo, `gh` inside the container, PR flow, the
  deploy pipeline's check-run reads - **and cloning `workspace-backups`, which is what makes the
  DB restore work.** If this token cannot read `workspace-backups`, section 6 fails silently.
- **Obtain:** github.com > Settings > Developer settings > Personal access tokens. Classic with
  `repo` scope, or fine-grained with contents + pull-requests read/write on `workspace`,
  `workspace-backups` and every active project repo (`activeProjectRepos` in
  `configs/environments.json`).
- **Verify (value-blind, after the container is up):**
  `docker exec workspace-agent-1 gh auth status` and
  `docker exec workspace-agent-1 gh repo view hectorolan/workspace-backups`. Neither prints the
  token. Do this **before** trusting section 6.
- **Rotate:** issue the new token, replace it in the VM `.env`, then
  `sudo docker compose up -d --force-recreate` in `~/agent/workspace`, then revoke the old one.
  The container cannot push between the revoke and the recreate, so do them in that order. A
  rotation decision that is currently pending lives in the DB `backlog` plan (`ws plan get
  backlog`, the awaiting-the-CEO section).

### 2.3 `CLAUDE_CODE_OAUTH_TOKEN`

- **For:** every headless agent session the container runs (digest, inbox).
- **Obtain:** on any machine already logged in to Claude Code, run `claude setup-token` and copy
  the long-lived token it prints.
- **Verify:** after the container is up, watch the next scheduled job, or run one deliberately
  inside the container. A bad token shows as a 401 in the job's run log under
  `<WS_DATA_DIR>/jobs/<job>/`.
- **Rotate:** re-run `claude setup-token`, replace in `.env`, recreate the container.
- **Trap, seen live on cutover night:** a `/login` on ANY machine can invalidate this token. If
  container jobs start 401-ing for no other reason, that is the cause - regenerate.

### 2.4 `LOG_API_KEY`

- **For:** the only authentication on the log API. `docker-compose.yml` binds the API to
  `0.0.0.0` (so the hub container and the VM-local tunnel endpoint can reach it), and
  `server/server.js` **refuses to start keyless on a non-loopback bind**. Every route is guarded,
  including `/health`.
- **Obtain:** generate a fresh random string **on the VM**, e.g. `openssl rand -hex 32`, and put
  it straight into `.env`. It is a shared secret with no issuer - a rebuilt host may use a new
  value as long as every station is updated with it (section 8).
- **Verify:** `docker exec workspace-agent-1 node /home/node/sources/workspace/cli/ws.js health`
  returns ok with an entry count. It reads the key from the container's own env and prints no
  secret. **If you skip this check you can end up with a container that passes its healthcheck
  and has no log API at all** - the scheduler runs, jobs run, and every audit line quietly lands
  in `<WS_DATA_DIR>/fallback/log.md` instead of the DB.
- **Rotate:** new value in the VM `.env`, `docker compose up -d --force-recreate`, then update
  the `LOG_API_KEY` user env var on every station (new terminals only - section 8).

### 2.5 `GMAIL_APP_PASSWORD`

- **For:** both directions of the mail channel - SMTP delivery of the digest and every agent
  reply (`cli/util/smtp.js`), and IMAP capture of the CEO's requests (`cli/util/inbox.js`). One
  app password covers both; there are no separate IMAP credentials.
- **Obtain:** myaccount.google.com > Security > 2-Step Verification > App passwords, on the
  account named by `MAIL_ACCOUNT` (defaults to `OWNER_EMAIL`). Google shows the value once.
- **Verify:** send a real mail -
  `node cli/ws.js email --subject "DR check" --body-path <file>` - and confirm it arrives. Exit
  code 2 means no password or no identity.
- **Rotate:** create the new app password, update the VM `.env` and each station's
  `GMAIL_APP_PASSWORD` user env var, recreate the container, then **delete the old entry** in
  the Google console. Rotation is complete only when the old value is dead.

### 2.6 `GOOGLE_OAUTH_CLIENT_ID` / `GOOGLE_OAUTH_CLIENT_SECRET`

- **For:** hub login (Google OAuth, restricted to the owner).
- **Obtain:** they already exist - the client is in the Google Cloud Console project described
  in the HO-Nexus table of `.claude/SETUP.md`. A rebuild does **not** need a new client, because
  the redirect URI is bound to the DNS *name*, not to the IP. Re-claim the same DNS label
  (section 3) and the existing client keeps working. Only if you change the hostname do you add
  a redirect URI to the client - and then the secret is unchanged anyway.
- **Verify:** load the site; it should 302 to `accounts.google.com` with the correct
  `redirect_uri`.
- **Rotate:** create a new client secret in the Cloud Console, update the hub production
  `.env`, redeploy, delete the old secret.

### 2.7 `SESSION_SECRET` (hub)

- **For:** signing hub session cookies. It lives in the hub production `.env`, not the
  workspace one.
- **Obtain:** generate a fresh random string on the VM. A rebuild should mint a NEW one; the only
  consequence is that existing sessions are invalidated, which is what you want anyway.
- **Verify:** log in to hub and reload - the session survives.
- **Rotate:** replace and redeploy; everyone is logged out once.

### 2.8 SSH keys and `known_hosts`

- **For:** operator access to the VM, and the SSH tunnel each station uses to reach the log API.
- **Obtain:** `provision.ps1 --generate-ssh-keys` installs the provisioning PC's key on the new
  VM. **Every other station's public key must be installed separately** with
  `az vm run-command invoke` (resource names: `controlPlane.azure` in
  `configs/environments.json`), because a station cannot SSH in to install its own key.
- **Verify:** a real `ssh` connection from each station. Do not infer NSG coverage - a successful
  connection proves it.
- **Trust:** seed each station's `known_hosts` from the VM's real host keys read over the Azure
  control plane (`az vm run-command invoke ... "cat /etc/ssh/ssh_host_*_key.pub"`), then
  fingerprint-match. Do not accept on first use. This is policy, not a workaround for any tool
  limitation.
- **Rotate:** append the new public key with `az vm run-command`, verify, then remove the old one
  from `~/.ssh/authorized_keys` on the VM.

### 2.9 Identity variables (not secrets, still required)

`OWNER_EMAIL`, `AGENT_EMAIL`, `MAIL_ACCOUNT` (optional), `GIT_USER_NAME`, `GIT_USER_EMAIL`,
`WORKSPACE_REPO_URL`, `WS_ENV`, `TZ`.

- **For:** who the agent is and who it answers to. There are **no code defaults** since
  2026-07-20 - `entrypoint.sh` exits fatally if any of the required ones are missing, so a
  misconfigured host fails fast instead of acting as the wrong person.
- **Obtain:** copy the documented values straight from `.env.example`; that file is the contract.
  `WS_ENV=azure-vm` is what makes the scheduler arm at all (it must match `scheduleOwner` in
  `configs/environments.json`).
- **Verify:** the container boots past its env check; the first digest arrives from the expected
  address; `git log` on a pushed commit shows the owner as author.
- **Rotate:** n/a - these are configuration, changed deliberately.

---

## 3. Azure: subscription, VM, NSG, DNS, disk

Machine-readable resource names live in `configs/environments.json` under `controlPlane.azure`
(resource group, VM name, NSG name, SSH rule name). Read them from there; do not retype them
from prose.

1. **`az login`**, confirm the subscription with `az account show`.
2. **Run the provisioning script** from a station:
   `cd sources\workspace; .\setup-scripts\azure\provision.ps1`. It creates the resource group and
   the VM (Ubuntu 24.04, `Standard_B2ats_v2`, 30 GB StandardSSD - about $16/month all-in), creates
   the NSG with the SSH rule, narrows that rule to the calling PC's public IP, then copies `.env`
   and `vm-setup.sh` to the VM and runs the host setup. Parameters default to the live values, so
   a rebuild is a plain re-run.
3. **Open the web ports by hand** - the script does not. On the NSG named by
   `controlPlane.azure.nsgName`, add `allow-http` (priority 1010, tcp/80, source Internet) and
   `allow-https` (priority 1011, tcp/443, source Internet). Both are required: 443 serves the app
   and **80 is how Caddy completes the Let's Encrypt HTTP-01 challenge**. Nothing must open 8790
   - off-host access to the log API is the SSH tunnel only.
4. **Re-claim the DNS label** on the new public IP resource:
   `az network public-ip update -g <resourceGroup> --name <vmName>PublicIP --dns-name ho-nexus`.
   This is what keeps `https://ho-nexus.westus2.cloudapp.azure.com` - and therefore the
   registered Google OAuth redirect URI and the certificate name - valid without touching the
   OAuth client.
5. **Add every station's SSH source** to the SSH rule, and verify with a real connection from
   each. Stations behind one NAT share an egress IP; that is a measured coincidence, not a rule.

**The public IP will be new.** Note it: section 8 depends on it.

---

## 4. VM host packages

The container carries its own runtime (node, git, gh, claude CLI - see the Dockerfile). These are
**host** requirements, outside the container, and a station needs none of them:

| Package | Required by | Failure if missing |
|---|---|---|
| docker + compose plugin | everything | obvious, loud |
| **`python3`** | `setup-scripts/deploy/deploy.sh` - it parses the GitHub check-run JSON to compute the CI verdict | **silent and permanent**: the verdict comes back empty, the script prints "could not read CI status - waiting" and exits 0 on every 5-minute tick forever. No failed line, no email, no deploys. |
| **node** | `deploy.sh` writes every audit line with `node cli/ws.js log` | deploys still run, but every deploy audit line is lost |
| cron | the 5-minute deploy tick | no continuous deployment |
| 2 GB swap | the VM has 1 GiB RAM; compose builds and agent runs need headroom | builds and jobs get OOM-killed |

`vm-setup.sh` installs docker, swap and python3. **Node on the host is not installed by any
script** - install it after `vm-setup.sh` and before relying on deploy audit lines. Verify all
four with `docker --version`, `node --version`, `python3 --version`, `crontab -l`.

---

## 5. The container

`vm-setup.sh` clones the workspace to **`~/agent/workspace`** and runs
`sudo docker compose up -d --build` there. Keep that exact path: the compose project name is
derived from the directory, which makes the volume `workspace_sources`, which hub mounts as
an external volume. A different directory silently breaks hub.

What happens on every boot from then on is owned by `setup-scripts/container/README.md` (env
check, git/gh identity, clone or pull, `ws ensure-deps`, DB seed, log API, scheduler) and is not
restated here. Three things matter for a rebuild:

- **The image contains no workspace content.** The repo is cloned into the volume at runtime, so
  a merged change ships with a pull, not a rebuild. Only `Dockerfile` and `entrypoint.sh` changes
  need `docker compose up -d --build`.
- **`scheduleOwner` decides whether jobs fire at all.** The scheduler re-reads
  `configs/environments.json` before every fire and refuses to arm unless `WS_ENV` matches. A
  rebuilt VM keeps `WS_ENV=azure-vm`, so it re-arms by itself - and no second host can start
  firing jobs by accident.
- **The healthcheck only proves the scheduler is alive.** It says nothing about the log API or
  the DB. Sections 2.4 and 6 are the checks that matter.

Expected boot evidence: `sudo docker compose logs --tail 50` shows the entrypoint sequence,
`starting ws scheduler`, and one `[scheduler] armed <job>` line per entry in
`configs/jobs/jobs.json`.

---

## 6. Restore the DB - the step that matters most

Everything else on this page is rebuildable. History is not.

**Normally it is automatic.** On a fresh volume `entrypoint.sh` sees an empty or missing
`logs.db`, clones the backup repo (`BACKUP_REPO_URL`, else `backupRepoUrl` in
`configs/environments.json`) and runs `server/restore.js` before the log API starts. `restore.js`
refuses to overwrite a non-empty DB, so this is a no-op on every ordinary restart.

**It can fail silently.** If the clone does not authenticate (see 2.2) the entrypoint logs
`WARN: backup repo unreachable - starting with an empty DB` and boots normally. The container is
then "healthy" with zero history.

**Verify before anything else proceeds:**

```
sudo docker compose logs | grep -i "restor\|backup repo"          # expect the restore line, not the WARN
docker exec workspace-agent-1 node /home/node/sources/workspace/cli/ws.js health
docker exec workspace-agent-1 node /home/node/sources/workspace/cli/ws.js query --summary --days 14
```

`health` reports the entry count and `query --summary` should show real recent history. An entry
count of 0 or a summary with nothing in it means the restore did not happen.

> **Deadline: 03:30.** The nightly `ws backup` job dumps whatever is in the DB over `logs.sql` in
> the backups repo and pushes. It has no non-empty guard. If the host is running with an empty DB
> when that job fires, the good dump stops being HEAD. It is still recoverable - git history is
> the retention - but you then have to `git checkout <previous-commit> -- logs.sql` in a clone of
> `workspace-backups` and restore from that. **If the DB came up empty, stop the container before
> 03:30.**

**Manual restore**, if the automatic path did not run:

```
git clone https://github.com/hectorolan/workspace-backups.git
node server/restore.js workspace-backups/logs.sql        # add --force only to replace a non-empty DB
```

Run it where the DB lives (inside the container, or with `LOG_DB_PATH` pointed at it), with the
log API stopped so nothing holds the file open. Recovery mechanics and the endpoint reference
live in `server/README.md`.

Two things ride in the DB that are easy to forget and matter operationally: the `inbox_seen`
ledger (a restored host will not re-process old mail or old page comments) and every plan
(`ws plan list` should come back populated - the backlog, this plan, the test plans).

---

## 7. hub and the deploy pipeline

hub runs as its own compose project beside the agent container. Its production compose file
and Caddyfile **live only on the VM** - they are in no repository (the hub repo's own
`docker-compose.yml` header says so). Rebuild them from these ingredients:

- `~/agent/hub/repo` - a clone of `hectorolan/hub` main. Its `.env` (mode 600, not
  committed) carries `GOOGLE_OAUTH_CLIENT_ID`/`SECRET`, a fresh `SESSION_SECRET`,
  `BASE_URL=https://ho-nexus.westus2.cloudapp.azure.com`, `LOG_API_URL` and `LOG_API_KEY`, and
  **`AUTH_BYPASS` set to false or absent - never true on this VM, staging included**.
- `~/agent/hub/docker-compose.prod.yml` - project `hub`, services `app` and
  `caddy:2-alpine`. The app service builds `./repo`, gets
  `extra_hosts: ["host.docker.internal:host-gateway"]` so it can reach the log API on the VM
  host, and mounts the external volume `workspace_sources` read-only at `/data/workspace-sources`
  with `WORKSPACE_CLAUDE_DIR=/data/workspace-sources/workspace/.claude` (that is what the
  Claude-tab pages (Core/Agents/Skills/Stations) read - never bind-mount a separate host clone, it goes stale
  silently). Caddy publishes 80 and 443.
- `Caddyfile` - reverse-proxy the DNS name to `app:8080` on the internal compose network. The
  Let's Encrypt certificate is obtained automatically on first boot over port 80; certs persist
  in `~/agent/hub/caddy_data`.

Then bring it up **through the pipeline, never by hand**:
`~/agent/workspace/setup-scripts/deploy/deploy.sh hub --force`. That one script is the whole
deploy path (fetch, CI gate, fast-forward, build, health check, rollback, audit line); its flags,
targets and the exact cron line are documented in `setup-scripts/deploy/README.md`.

**Install the cron line** from that README (the 5-minute production tick, user `hector`) - no
script does it, and without it nothing deploys.

Staging (`setup-scripts/deploy/setup-staging.sh hub`, then
`deploy.sh hub-staging --force`) and the self-hosted GitHub Actions runner it uses are
optional for recovery: the staging CD job is gated on the repo variable `CD_STAGING_ENABLED` and
production does not depend on either.

---

## 8. What every station must re-point afterwards

A rebuilt host means a **new public IP**. Stations are disposable and hold no unique state, so
this list is short and it is entirely about pointing them at the new host:

1. **`configs/environments.json`** - update `logApiTunnel.sshTarget` for every station entry, and
   push. This is the one that unblocks all the others; each station picks it up within one
   15-minute `ws pull`.
2. **Prose that restates the address** - `SYSTEM.md`, `.claude/environments/environments_setup.md`,
   `docs/container-runtime.md`, `.claude/SETUP.md`. Same session, same push.
3. **`known_hosts` on each station** - the rebuilt VM has NEW host keys. Re-seed them from the
   Azure control plane (2.8) and remove the stale entry. Every station's tunnel stays broken
   until this is done.
4. **The station's SSH public key** on the new VM - installed with `az vm run-command`, once per
   station (2.8).
5. **`LOG_API_KEY`** as a user env var on each station, **only if you minted a new one** (2.4).
   Windows user env vars reach new terminals only.
6. **NSG SSH source** must cover each station's public egress IP - proved by a real connection,
   not assumed.

**What must NOT be rebuilt or migrated:** anything else on a station. Its data dir
(`WS_DATA_DIR`: job outputs, run logs, inbox working files, tunnel logs) is derived state and is
meant to be thrown away; its clone comes back with `git clone`; its harness config is declared in
`configs/harness-settings.json`. Station-local state is disposable by design - if you find
yourself trying to recover something from a station, that is a defect to report, not a step.

Then run `node cli/util-tools/station-bootstrap.js` on each station: it re-measures all ten steps
and tells you what is still owed.

---

## 9. Acceptance

The rebuild is done when all of these pass:

1. `docker compose ps` shows the agent container healthy, and the logs show one
   `[scheduler] armed <job>` line per entry in `configs/jobs/jobs.json`.
2. `ws health` inside the container returns ok with a **non-zero entry count**, and
   `ws query --summary --days 14` shows real history (section 6).
3. `ws plan list` returns the plans - the backlog is there.
4. A real email send arrives (2.5), and a test `Agent:` mail to the agent alias produces a
   threaded reply within ~15 minutes (that exercises IMAP capture, the orchestrator session, the
   DB and the sender in one go).
5. `https://ho-nexus.westus2.cloudapp.azure.com` serves a valid certificate and redirects to
   Google login; `/healthz` returns 200.
6. `deploy.sh hub --force` completes with a `deploy done` audit line in the DB - which also
   proves node, python3 and the CI gate on the host.
7. Every station: `node cli/util-tools/env-doctor.js` exits 0, and a real `ws query` comes back
   through its tunnel.
8. `ws station list` shows every station reporting (no `STALE`, no `NEVER REPORTED`) after one
   pull cycle.
9. The next 03:30 `ws backup` pushes a `logs.sql` commit to `workspace-backups` whose size is in
   line with the previous one.

Then record the outcome: a dated line in `.claude/environments/environments_setup.md` "Change
history", and one `ws log` call.

---

## 10. Known gaps in the provisioning scripts

`setup-scripts/azure/provision.ps1` and `vm-setup.sh` were validated by read-through on
2026-07-28 (not executed). Nothing in them is broken by the v2 restructure - every path they
reference is current - but the live host has grown a control plane around them, and the parts of
it they do not cover are exactly sections 3 (web ports, DNS label), 4 (node on the host), 7
(hub, cron) and 8 (stations) above. Four of those gaps fail silently.

The full finding list, with severities and what was fixed versus recorded, is the artifact of
that validation; the outstanding items are tracked in the DB `backlog` plan (item 8), which is
also where "execute the drill" lives. Until the drill runs, treat this document as the
authoritative path and the scripts as an accelerator for parts of it.
