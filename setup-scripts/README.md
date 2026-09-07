# setup-scripts/ — how this system gets a host, boots, and stays deployed

Everything in this folder is **infrastructure mechanics** — deterministic scripts,
zero AI involvement. Agents never re-think these steps; they invoke the scripts
(or the scripts run themselves on cron/boot). Living document: update alongside
any script change, same session.

## The folders, in lifecycle order

```
azure/      you run ONCE per host       → creates the VM, installs Docker, first compose up
container/  Docker runs EVERY boot      → entrypoint: pull repo → deps → DB → scheduler (supervises the log API)
deploy/     VM host cron EVERY 5 MIN    → CI-gated pull-based deploy of product apps (hub)
windows/    you run ONCE per PC         → registers the Claude-WorkspacePull S4U task
```

`windows/` is the odd one out: it sets up an *interactive* box rather than the live
host, and stands alone (nothing chains into it). The other three chain, below.

They chain: `azure/provision.ps1` builds the host and hands off to
`vm-setup.sh`, whose final `docker compose up -d --build` bakes
`container/entrypoint.sh` into the image; from then on the entrypoint owns every
container boot, and the workspace *system* updates itself via `git pull` (no
rebuilds needed — code lives in a volume clone, not the image). Product apps
(hub) are **not** part of that loop: they ship through `deploy/deploy.sh`,
which the VM **host** cron runs every 5 minutes, gated on the CEO's PR merge +
green CI.

## Who runs what

| Script | Runs where | Triggered by | Tokens |
|---|---|---|---|
| `azure/provision.ps1` | PC (PowerShell, interactive) | the CEO, once per host / DR | none |
| `azure/vm-setup.sh` | VM host (via provision.ps1 or by hand) | provision.ps1 | none |
| `container/entrypoint.sh` | inside the container, PID 1 path | Docker, every container start | none |
| `deploy/deploy.sh <app>` | VM host | host cron `*/5` + devops agent (force/diagnose) | none |
| `windows/register-pull-task.ps1` | PC (PowerShell, elevated) | the CEO, once per PC / task repair | none |

## Update semantics

- **Workspace system code** (cli/, server/, configs/, skills): lands via
  `ws sync` on main → the container's 15-min `ws pull` + next boot pick it up.
  Long-lived processes (log API, scheduler) restart themselves when a pull
  touches their code — the self-restart in `cli/util/selfrestart.js`
  (SYSTEM.md "Self-restart on relevant pulls"); no manual recreate needed.
- **The image itself** (Dockerfile, entrypoint.sh): needs
  `sudo docker compose up -d --build` on the VM (`~/agent/workspace`).
- **deploy.sh**: self-updates — it pulls the workspace host clone at the start
  of every run, so a pushed change is live within 5 minutes.
- **provision/vm-setup**: only read at provision time; a change here affects the
  next host build, not the running one. They cover part of a rebuild, not all of
  it — the whole procedure is `docs/live-host-rebuild.md`.

Full runtime picture: `docs/container-runtime.md`. System inventory: `SYSTEM.md`.
Each subfolder's README explains its script(s) step by step.
