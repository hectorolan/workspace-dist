# deploy/ — pull-based continuous deployment for product apps

One script: `deploy.sh <target> [--force] [--ci-verified]`. THE deploy pipeline —
the VM cron, the CD gh-workflow (GitHub Actions), the devops agent, and the CEO all
invoke this same script; nobody re-implements its steps. It deploys **product
apps** (today: hub, prod + staging). The workspace *system* never uses it —
that updates via git pull (see `../container/README.md`).

Flags:

- `--force` — deploy `origin/main` even when the clone is already there (first
  install, re-verify, diagnose). The only way to rebuild without a new commit.
- `--ci-verified` — skip the check-run poll because the caller already
  established CI is green. Used **only** by the CD gh-workflow, which starts after
  the CI gh-workflow concluded success and would otherwise wait on its own run.

## The pipeline (one run)

```
self-update → anything new on main? → CI gate → fast-forward → compose build/up
            → health check (60 s) → audit log via ws — or rollback + failed line
```

1. **Self-update** — pulls the workspace host clone (`~/agent/workspace`,
   where this script lives) so the next run always executes the latest
   pipeline. Non-fatal.
2. **Change detection** — fetches the app repo's `origin/main`
   (`~/agent/<app>/repo`); exits silently when there's nothing new. That
   silence is what makes a 5-minute cron cheap.
3. **CI gate** — reads GitHub check-runs for the new commit. A run counts as
   completed once it has a **non-null `conclusion`**, whatever its `status`
   says: GitHub only writes `conclusion` when a run actually finished, and it
   sometimes never closes the record (hub `c4c93a0`, 2026-08-28 — a check sat
   `in_progress`/`success` forever and stalled the gate for 40+ min).
   - `green` → deploy. `pending` (genuinely conclusion-less runs only) → wait
     for the next tick — and if the SAME commit is still pending 30 min after
     it landed, ONE `deploy blocked` stall line (deduped via
     `~/agent/deploy.state`) names the stuck check(s) so the stall surfaces in
     `ws query` instead of only in the VM's deploy.log. The script keeps
     waiting; a human-authorized `--ci-verified` stays the only override.
   - `failed` (any failure conclusion, stuck record or not) → log ONE `deploy
     blocked` line (deduped) and wait for a fix — a red merge never ships.
   - `none` → pre-CI-era commit: wait 15 min, then deploy with an explicit note.

   The verdict snippet and the stall path are covered by
   `cli/test/deploy-gate.test.js`, which runs the real script in a sandbox.
4. **Deploy** — `git merge --ff-only` (a diverged deploy clone is a loud
   `failed`, never a force), then `docker compose -f docker-compose.prod.yml
   up -d --build` for the app service.
   The rest of the project is then brought up too (prod: Caddy) — a no-op in
   normal operation, and what restores the proxy after a project-wide `down`.
5. **Health check** — polls the app's `/healthz` up to 60 s. Success → `deploy
   done` audit line. Failure → **automatic rollback** to the previous commit,
   rebuild, `deploy failed` line.

The human production gate is the CEO's PR merge — everything after the merge is
mechanical. Pull-based on purpose: no deploy keys in GitHub, no inbound NSG
holes; the VM reaches out.

## The cron line (VM host, user hector)

```
*/5 * * * * $HOME/agent/workspace/setup-scripts/deploy/deploy.sh hub >> $HOME/agent/deploy.log 2>&1
```

`~/agent/deploy.log` is the raw run log; audit lines land in the central DB via
`node cli/ws.js log` (the host runs Node like every environment).

## Targets

A target is a repo + a compose project. `hub` is production (Caddy, TLS,
public); `hub-staging` is its twin — same repo, same image build, its own
clone and compose project, published host-locally on 8081. Staging exists to
prove that a commit builds, boots and stays healthy before production takes it;
it has no TLS name and therefore no registered OAuth redirect URI, so `/healthz`
(the pipeline's own probe) is what it answers. `AUTH_BYPASS` is never set on this
VM, staging included.

Bootstrap staging once with `setup-staging.sh <app>` — idempotent: clone, `.env`
copied from the production install minus `AUTH_BYPASS`, compose file. It builds
and starts nothing; `deploy.sh <app>-staging --force` does that through the
normal pipeline.

## GitHub Actions CD (staging)

`hub/.github/workflows/cd-staging.yml` runs after the CI gh-workflow concludes
success on `main`:

1. `verify-image` (GitHub-hosted) — builds the production Dockerfile and health
   checks the container, so a broken image is caught before the VM pulls it.
2. `deploy-staging` (**self-hosted runner on this VM**, label `hub-vm` — none is
   registered today, so a future runner must register with that label) — runs
   `deploy.sh hub-staging --force --ci-verified`, i.e. this exact pipeline.

The runner is outbound-only, so the architecture stays pull-based: no deploy key
in GitHub, no inbound NSG hole, no repo secrets at all. The deploy job is gated
on the repository variable `CD_STAGING_ENABLED`; unset means the job is skipped,
which keeps the commit's checks green for the production gate.

The production cron is untouched by this and remains the deploy path for
`hub`. Retiring it in favor of the gh-workflow is a separate decision, taken
only once staging has proven the pipeline over time.

## Adding an app

Extend the `case "$APP"` block: repo dir, compose file, service name, health
command — then add a cron line (or reuse the tick with a second invocation).
Keep config in the app's own repo; secrets in `.env` only.

## Manual use (force/diagnose)

```
~/agent/workspace/setup-scripts/deploy/deploy.sh hub
~/agent/workspace/setup-scripts/deploy/deploy.sh hub-staging --force
```
Same behavior, output to the terminal. The devops agent uses exactly this.
