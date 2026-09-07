# container/ — the boot path of the 24/7 runtime

One script: `entrypoint.sh`. It is **baked into the Docker image**
(`Dockerfile: COPY setup-scripts/container/entrypoint.sh /usr/local/bin/agent-entrypoint`)
because it must exist before the repo is cloned — everything else it runs comes
from the cloned workspace. Changing it therefore requires an image rebuild
(`sudo docker compose up -d --build` in `~/agent/workspace` on the VM);
changing anything it *calls* (cli/, server/, configs/) only needs a git pull.

## Boot order (every container start)

1. **Env check (fatal)** — required: `CLAUDE_CODE_OAUTH_TOKEN`/`ANTHROPIC_API_KEY`,
   `GITHUB_TOKEN`, `WORKSPACE_REPO_URL`, `GIT_USER_NAME`, `GIT_USER_EMAIL`,
   `OWNER_EMAIL`, `AGENT_EMAIL` (identity has no code defaults since 2026-07-20);
   missing `GMAIL_APP_PASSWORD` is a loud WARN (email delivery would fail).
2. **Git/gh identity** — commits author as `GIT_USER_NAME`/`GIT_USER_EMAIL` (the
   owner; CLAUDE.md: no AI attribution); `gh auth setup-git` wires push auth
   from `GITHUB_TOKEN`.
3. **Workspace checkout** — clone on first boot, `git pull --rebase` on every
   restart. The clone lives in the `sources` **volume**, so state (and the
   Claude CLI auth under `~/.claude`) survives restarts; GitHub stays the
   source of truth. Also links `sources/.claude → workspace/.claude`.
4. **Dependencies** — `ws ensure-deps` installs npm deps only when the
   lockfile changed since the last successful install. A failed install is
   **FATAL by design** (one path, no fallback): the container exits, Docker's
   `restart: unless-stopped` retries, and real breakage stays visible.
5. **DB seed** — if `~/sources/data/logs.db` is empty/missing (fresh volume),
   restore it from the backup repo (`backupRepoUrl` in `configs/environments.json`,
   `BACKUP_REPO_URL` env overrides). `restore.js` refuses a non-empty DB, so
   this is a no-op on normal restarts.
6. **Log API** — supervised by the scheduler (next step), not started here: probe/adopt + crash restart (SYSTEM.md "Log-API supervision"), output to `<WS_DATA_DIR>/api/`. Images baked before 2026-07-30 still background `server/start.sh` at this point; the scheduler adopts that copy.
7. **Scheduler** — `exec node cli/ws.js scheduler`: the one clock
   (`configs/jobs/jobs.json`), foreground; the container lives exactly as long
   as it does. It runs boot catch-up (`catchUpArgs`) for missed job slots and
   refuses to arm unless this environment is the `scheduleOwner`
   (`configs/environments.json` + `WS_ENV`).

## Escape hatches (env flags, all default off)

| Flag | Effect |
|---|---|
| `SKIP_GIT_SYNC=1` | don't pull on boot (dev bind mounts) |
| `SKIP_DB_RESTORE=1` | never seed the DB |
| `SKIP_LOG_API=1` | don't start the API |
| `SKIP_CATCHUP=1` | scheduler arms but skips boot catch-up |

`docker-compose.dev.yml` uses these for local dev (bind mount, no jobs fired).

## Operational notes

- **Restart = self-update** for everything except the image: the boot pull
  brings the volume clone to origin/main before anything runs.
- Jobs always run current code even *without* a restart — the scheduler spawns
  each job as a fresh process after the 15-min `ws pull`. The two long-lived
  processes (log API, scheduler) restart themselves when a pull touches their
  code (SYSTEM.md "Self-restart on relevant pulls").
- Health check (compose) = "is the ws scheduler process alive".
