#!/usr/bin/env bash
# deploy.sh <target> [--force] — THE deploy pipeline. One deterministic script runs
# everything:
#   fetch main → CI gate (GitHub check runs) → fast-forward → compose build →
#   health check → rollback on failure → audit log via `node cli/ws.js log`
#   (the one client; the VM host runs Node like every other environment).
#
# Nobody re-thinks deploy steps in an agent session: the devops agent, the VM cron,
# the GitHub Actions CD workflow, and Hector all invoke THIS script. Cron makes it
# continuous deployment (every 5 min on the VM host; exits silently when there is
# nothing to do):
#   */5 * * * * $HOME/agent/workspace/setup-scripts/deploy/deploy.sh hub >> $HOME/agent/deploy.log 2>&1
#
# Targets are prod/staging pairs of the same repo (see the case block). The
# hub repo's .github/workflows/cd-staging.yml runs `deploy.sh hub-staging`
# on a self-hosted runner ON this VM after every push to main — so staging and the
# production cron exercise one identical pipeline, and the workflow adds only the
# trigger, not a second implementation.
#
# --force deploys origin/main even when the clone is already there (first install,
# re-verify, diagnose) — the only way to rebuild without a new commit.
#
# The human production gate is Hector's PR merge (CLAUDE.md); everything after the
# merge is mechanical. Pull-based on purpose: no SSH keys in GitHub, no inbound NSG
# holes — the VM reaches out (the CD runner is likewise outbound-only), GitHub stays
# the source of truth.
#
# Runs on the VM host (needs host docker + node). Self-updates: pulls the workspace
# host clone first, so the next run always executes the latest pipeline + client.
# State in ~/agent/deploy.state stops repeat-logging of the same blocked commit.
set -u

APP="${1:?usage: deploy.sh <app> [--force]   (e.g. deploy.sh hub)}"
shift
FORCE=false
CI_VERIFIED=false
for a in "$@"; do
  case "$a" in
    --force) FORCE=true ;;   # deploy origin/main even when the clone already points at it
    # The caller has ALREADY established that CI is green for this commit — used by
    # the CD workflow, which only starts after the CI workflow concluded success.
    # Without it that workflow would poll the commit's check runs and find its OWN
    # run still in progress, i.e. wait for itself forever.
    --ci-verified) CI_VERIFIED=true ;;
    *) echo "deploy.sh: unknown option '$a'" >&2; exit 2 ;;
  esac
done

AGENT_DIR="$HOME/agent"
WS="$AGENT_DIR/workspace"                 # workspace host clone (this script lives in it)
ENV_FILE="$WS/.env"
logapi() { node "$WS/cli/ws.js" "$@"; }
STATE="$AGENT_DIR/deploy.state"

# --- per-app wiring (extend this case when the next app ships) --------------------
# TARGET names the deploy target (prod/staging); REPO is the GitHub repo it tracks —
# a staging target of the same repo reads the same commits and the same CI checks.
case "$APP" in
  hub)
    REPO="hub"
    REPO_DIR="$AGENT_DIR/hub/repo"
    COMPOSE="$AGENT_DIR/hub/docker-compose.prod.yml"
    APP_SERVICE="app"
    HEALTH_CMD=(docker exec hub-app-1 node -e "fetch('http://localhost:8080/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))")
    ;;
  hub-staging)
    # Staging twin of the above: same repo, same image build, its own compose
    # project + clone + host port (8081, not proxied by Caddy, no TLS name). It
    # runs the SAME pipeline so the CD workflow proves build/health/rollback
    # without touching production. Bootstrap: setup-staging.sh.
    REPO="hub"
    REPO_DIR="$AGENT_DIR/hub-staging/repo"
    COMPOSE="$AGENT_DIR/hub-staging/docker-compose.staging.yml"
    APP_SERVICE="app"
    HEALTH_CMD=(docker exec hub-staging-app-1 node -e "fetch('http://localhost:8080/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))")
    ;;
  *) echo "deploy.sh: unknown app '$APP'" >&2; exit 2 ;;
esac

ts() { date '+%F %T'; }
note() { echo "[$(ts)] $APP: $*"; }

[ -f "$ENV_FILE" ] || { note "no $ENV_FILE — cannot run"; exit 1; }
GT=$(grep '^GITHUB_TOKEN=' "$ENV_FILE" | cut -d= -f2 | tr -d '\r\n"')
[ -n "$GT" ] || { note "GITHUB_TOKEN missing in .env"; exit 1; }
AUTH=$(printf 'x-access-token:%s' "$GT" | base64 -w0)
gitauth() { git -c http.extraHeader="Authorization: Basic $AUTH" "$@"; }

# logapi needs these on the host (API port is published on localhost)
export LOG_API_URL="${LOG_API_URL:-http://127.0.0.1:8790}"
export LOG_API_KEY="${LOG_API_KEY:-$(grep '^LOG_API_KEY=' "$ENV_FILE" | cut -d= -f2 | tr -d '\r\n"')}"

# --- self-update the pipeline itself (non-fatal; takes effect next run) -----------
gitauth -C "$WS" pull --rebase --autostash >/dev/null 2>&1 || note "workspace self-update failed (non-fatal)"

# --- is there anything to deploy? -------------------------------------------------
[ -d "$REPO_DIR/.git" ] || { note "$REPO_DIR missing — app not installed"; exit 1; }
gitauth -C "$REPO_DIR" fetch origin main >/dev/null 2>&1 || { note "fetch failed"; exit 1; }
CUR=$(git -C "$REPO_DIR" rev-parse HEAD)
NEW=$(git -C "$REPO_DIR" rev-parse origin/main)
SHORT=$(git -C "$REPO_DIR" rev-parse --short "$NEW")
if [ "$CUR" = "$NEW" ]; then
  # Nothing new. That silence is what makes a 5-minute cron cheap — unless a
  # human/pipeline asked for this run explicitly (first install, re-verify,
  # diagnose), in which case rebuild and re-health-check the current commit.
  $FORCE || exit 0
  note "forced redeploy of $SHORT (already checked out)"
else
  note "main moved $(git -C "$REPO_DIR" rev-parse --short "$CUR") -> $SHORT"
fi

state_get() { grep "^${APP}_$1=" "$STATE" 2>/dev/null | cut -d= -f2; }
state_set() { grep -v "^${APP}_$1=" "$STATE" 2>/dev/null > "$STATE.tmp" || true; echo "${APP}_$1=$2" >> "$STATE.tmp"; mv "$STATE.tmp" "$STATE"; }

# --- CI gate: every check run on the new commit must have succeeded ---------------
# A run counts as completed once it has a non-null `conclusion`, whatever `status`
# says: GitHub only writes `conclusion` when a run actually finished, and it
# sometimes never flips `status` to "completed" (hub c4c93a0, 2026-08-28 —
# "case-id uniqueness" sat in_progress/success forever and stalled this gate for
# 40+ min). Failure conclusions still gate; only genuinely conclusion-less runs
# mean pending, and their names ride the verdict line for the stall log below.
PENDING_CHECKS=""
if $CI_VERIFIED; then
  VERDICT=caller-verified
else
CHECKS=$(curl -fsS -m 20 -H "Authorization: Bearer $GT" -H "Accept: application/vnd.github+json" \
  "https://api.github.com/repos/hectorolan/$REPO/commits/$NEW/check-runs" 2>/dev/null) || CHECKS=""
GATE_OUT=$(printf '%s' "$CHECKS" | python3 -c '
import json, sys
try:
    d = json.load(sys.stdin)
except Exception:
    print("api-error"); raise SystemExit
runs = d.get("check_runs", [])
if not runs:
    print("none"); raise SystemExit
open_runs = [r for r in runs if r.get("conclusion") is None]
if open_runs:
    print("pending " + ",".join(sorted((r.get("name") or "unnamed") for r in open_runs)))
    raise SystemExit
bad = [r for r in runs if r.get("conclusion") not in ("success", "skipped", "neutral")]
print("failed" if bad else "green")
')
read -r VERDICT PENDING_CHECKS <<EOF
$GATE_OUT
EOF
fi

case "$VERDICT" in
  green) note "CI green for $SHORT" ;;
  caller-verified) note "CI verified by caller for $SHORT (--ci-verified)" ;;
  none)
    # Pre-CI era or checks not created yet: wait 15 min after the commit, then
    # deploy with an explicit note. Once the CI workflow exists, every commit on
    # main gets checks and this branch stops firing.
    AGE=$(( $(date +%s) - $(git -C "$REPO_DIR" show -s --format=%ct "$NEW") ))
    [ "$AGE" -lt 900 ] && { note "no checks yet (commit ${AGE}s old) — waiting"; exit 0; }
    note "no CI checks on $SHORT after 15 min — deploying (pre-CI commit)"
    ;;
  pending)
    # Never a silent stall: if the SAME commit is still conclusion-less 30 min
    # after it landed, surface ONE blocked line (deduped via deploy.state, the
    # `failed` branch's pattern) naming the stuck check(s) — then KEEP waiting.
    # A stall never auto-deploys; a human `--ci-verified` stays the only override.
    AGE=$(( $(date +%s) - $(git -C "$REPO_DIR" show -s --format=%ct "$NEW") ))
    if [ "$AGE" -ge 1800 ] && [ "$(state_get last_stalled)" != "$NEW" ]; then
      logapi log -r "$REPO" -a runner deploy blocked "[$APP] auto-deploy stalled: CI pending on $SHORT for $((AGE / 60)) min (stuck: ${PENDING_CHECKS:-unknown}) — still waiting; verify the checks, then rerun them or deploy.sh $APP --ci-verified"
      state_set last_stalled "$NEW"
    fi
    note "CI still running for $SHORT — waiting"; exit 0 ;;
  failed)
    [ "$(state_get last_blocked)" = "$NEW" ] && exit 0   # already logged this one
    logapi log -r "$REPO" -a runner deploy blocked "[$APP] auto-deploy blocked: CI failed on $SHORT (merge landed but checks are red)"
    state_set last_blocked "$NEW"
    exit 0
    ;;
  *) note "could not read CI status — waiting"; exit 0 ;;
esac

# --- deploy -----------------------------------------------------------------------
if ! git -C "$REPO_DIR" merge --ff-only "$NEW" >/dev/null 2>&1; then
  logapi log -r "$REPO" -a runner deploy failed "[$APP] deploy.sh: deploy clone cannot fast-forward to $SHORT (diverged — needs manual fix)"
  exit 1
fi
if ! docker compose -f "$COMPOSE" up -d --build "$APP_SERVICE" >/dev/null 2>&1; then
  logapi log -r "$REPO" -a runner deploy failed "[$APP] deploy.sh: compose build/up failed for $SHORT (see $AGENT_DIR/deploy.log)"
  exit 1
fi
# Then bring up the REST of the project (prod: Caddy/TLS). Normally a no-op — the
# sibling services are already running under `restart: unless-stopped` and only the
# app is rebuilt on a deploy. It matters after a project-wide `down` (a host rename,
# a manual teardown): only the app would come back, and the health check below probes
# the app container DIRECTLY, so the run would log "live (health OK)" while the public
# proxy stayed dark. Observed 2026-08-16 during the ho-nexus -> hub VM rename.
docker compose -f "$COMPOSE" up -d >/dev/null 2>&1 || note "sibling services up failed — check the proxy"

# --- health check (up to 60s), rollback on failure --------------------------------
ok=false
for _ in $(seq 1 12); do
  sleep 5
  if "${HEALTH_CMD[@]}" >/dev/null 2>&1; then ok=true; break; fi
done

if $ok; then
  logapi log -r "$REPO" -a runner deploy done "[$APP] auto-deploy $SHORT live (CI $VERDICT, health OK)"
  state_set last_deployed "$NEW"
else
  note "health check failed — rolling back to $CUR"
  git -C "$REPO_DIR" reset --hard "$CUR" >/dev/null 2>&1
  docker compose -f "$COMPOSE" up -d --build "$APP_SERVICE" >/dev/null 2>&1
  logapi log -r "$REPO" -a runner deploy failed "[$APP] auto-deploy $SHORT failed health check — rolled back to $(git -C "$REPO_DIR" rev-parse --short HEAD)"
  exit 1
fi
