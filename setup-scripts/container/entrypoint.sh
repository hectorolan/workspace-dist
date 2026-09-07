#!/usr/bin/env bash
# entrypoint.sh — container bootstrap. Baked into the image; everything else comes
# from the workspace repo it clones. Order: check env → git/gh identity → clone or
# pull the workspace (volume-persisted) → catch-up missed jobs → run the scheduler.
set -euo pipefail

SOURCES="$HOME/sources"
WORKSPACE="$SOURCES/workspace"

log() { echo "[entrypoint $(date '+%F %T')] $*"; }

# --- required environment (identity has NO code defaults, 2026-07-20) -----------
missing=()
[ -z "${CLAUDE_CODE_OAUTH_TOKEN:-}${ANTHROPIC_API_KEY:-}" ] && missing+=("CLAUDE_CODE_OAUTH_TOKEN or ANTHROPIC_API_KEY")
[ -z "${GITHUB_TOKEN:-}" ] && missing+=("GITHUB_TOKEN")
[ -z "${WORKSPACE_REPO_URL:-}" ] && missing+=("WORKSPACE_REPO_URL")
[ -z "${GIT_USER_NAME:-}" ] && missing+=("GIT_USER_NAME")
[ -z "${GIT_USER_EMAIL:-}" ] && missing+=("GIT_USER_EMAIL")
[ -z "${OWNER_EMAIL:-}" ] && missing+=("OWNER_EMAIL")
[ -z "${AGENT_EMAIL:-}" ] && missing+=("AGENT_EMAIL")
if [ "${#missing[@]}" -gt 0 ]; then
  log "FATAL: missing required env: ${missing[*]} (see .env.example)"
  exit 1
fi
[ -z "${GMAIL_APP_PASSWORD:-}" ] && log "WARN: GMAIL_APP_PASSWORD not set — report email delivery will fail"
REPO_URL="$WORKSPACE_REPO_URL"

# --- git / gh identity ----------------------------------------------------------
git config --global user.name  "$GIT_USER_NAME"
git config --global user.email "$GIT_USER_EMAIL"
git config --global --add safe.directory '*'   # dev bind mounts arrive with foreign ownership
gh auth setup-git 2>/dev/null || log "WARN: gh auth setup-git failed — git push over https may not work"

# --- workspace checkout (lives in a volume so state survives restarts) ----------
mkdir -p "$SOURCES"
if [ ! -e "$WORKSPACE" ]; then
  log "cloning $REPO_URL -> $WORKSPACE"
  git clone "$REPO_URL" "$WORKSPACE"
elif [ "${SKIP_GIT_SYNC:-0}" != "1" ] && [ -d "$WORKSPACE/.git" ]; then
  log "pulling latest workspace (GitHub is the source of truth)"
  git -C "$WORKSPACE" pull --rebase --autostash || log "WARN: git pull failed — continuing on current checkout"
fi

# Sessions start from sources/ with .claude linked into the workspace repo (CLAUDE.md rule 5)
[ -e "$SOURCES/.claude" ] || ln -s workspace/.claude "$SOURCES/.claude"

# --- node runtime deps (npm workspaces root) -------------------------------------
# `ws ensure-deps` (zero-dependency) installs when the lockfile changed since the
# last successful install — covers fresh volumes AND lockfile changes that arrived
# via pull while the container was down (bit us 2026-07-19: imapflow arrived via
# pull, the inbox tick failed). `ws pull` runs the same check after every live
# pull, so the running system self-heals within one pull cycle too.
# One path, no fallback (Hector 2026-07-19): a failed install is FATAL — the
# container exits, the restart policy retries the boot, and a real breakage stays
# loudly visible for investigation.
node "$WORKSPACE/cli/ws.js" ensure-deps \
  || { log "FATAL: dependency install failed — scheduler cannot start; investigate (rollback = git revert + rebuild)"; exit 1; }

# Model fallback chain (CLAUDE.md "Model routing") — user-level setting, created once
mkdir -p "$HOME/.claude"
[ -f "$HOME/.claude/settings.json" ] || echo '{"fallbackModel": ["opus"]}' > "$HOME/.claude/settings.json"

# --- DB seed: a fresh volume restores itself from the latest backup -------------
# Runs BEFORE the log API starts (nothing must hold the DB open). Source: the
# workspace-backups repo (GitHub). restore.js refuses to touch a non-empty DB,
# so this is a no-op on every normal restart. Non-fatal: a brand-new setup with
# no backups yet simply starts empty.
DB_PATH="${LOG_DB_PATH:-$SOURCES/data/logs.db}"
NODE_SQLITE_FLAGS=""
node -e "require('node:sqlite')" >/dev/null 2>&1 || NODE_SQLITE_FLAGS="--experimental-sqlite"
db_has_rows() {
  node $NODE_SQLITE_FLAGS -e '
    const { DatabaseSync } = require("node:sqlite");
    try {
      const db = new DatabaseSync(process.argv[1], { readOnly: true });
      process.exit(db.prepare("SELECT COUNT(*) AS n FROM log").get().n > 0 ? 0 : 1);
    } catch { process.exit(1); }' "$DB_PATH" 2>/dev/null
}
if [ "${SKIP_DB_RESTORE:-0}" != "1" ] && ! db_has_rows; then
  log "logging DB empty or missing — restoring from latest backup"
  # Backup repo: env override, else the instance config (no code default).
  BACKUP_URL="${BACKUP_REPO_URL:-$(node -e "try{console.log(require('$WORKSPACE/configs/environments.json').backupRepoUrl||'')}catch{console.log('')}")}"
  SEED=$(mktemp)
  if [ -n "$BACKUP_URL" ] && git clone --depth 1 "$BACKUP_URL" /tmp/db-seed 2>/dev/null \
     && cp /tmp/db-seed/logs.sql "$SEED"; then
    log "restore source: GitHub workspace-backups"
  else
    rm -f "$SEED"; SEED=""
    log "WARN: backup repo unreachable — starting with an empty DB"
  fi
  if [ -n "$SEED" ]; then
    node $NODE_SQLITE_FLAGS "$WORKSPACE/server/restore.js" "$SEED" "$DB_PATH" \
      || log "WARN: restore.js failed — starting with an empty DB"
    rm -f "$SEED"
  fi
  rm -rf /tmp/db-seed
fi

# --- central logging API (server/server.js) — all agents log via one HTTP call ---
# NOT started here anymore: the ws scheduler supervises it as a managed child
# (cli/util/scheduler.js superviseLogApi — probe/adopt, restart on crash with capped
# backoff, killed on shutdown; SKIP_LOG_API=1 disables). Images baked before this
# change still background server/start.sh at this point; the scheduler adopts that
# copy instead of fighting it, so both entrypoint generations behave correctly.

# --- scheduler (PID stays in foreground; container lives as long as it does) ----
# Phase 2 (2026-07-19): the ws scheduler (jobs/jobs.json) is THE clock — one path,
# total supercronic deprecation (Hector). It owns boot catch-up (SKIP_CATCHUP=1 to
# suppress). If it fails: investigate and fix; rollback = git revert + rebuild.
log "starting ws scheduler with $WORKSPACE/configs/jobs/jobs.json"
exec node "$WORKSPACE/cli/ws.js" scheduler
