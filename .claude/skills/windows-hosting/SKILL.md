---
name: windows-hosting
description: "The Windows PC's hosting role: Node-based helper Task Scheduler jobs (no agent jobs — those run in the workspace container), the S4U task recipe, the local-container rollback path, and diagnosing tasks that didn't fire. Use when creating/changing PC scheduled tasks or standing up the rollback host."
---

# Windows Hosting (this PC)

**The PC does not run agent jobs.** All scheduled agent work (digest, inbox, backups)
lives in the workspace container (`configs/jobs/jobs.json` via `ws scheduler`, live on
the Azure VM — see SYSTEM.md). The PC hosts only lightweight helper tasks, currently
exactly one: `Claude-WorkspacePull` (git freshness pull every 15 min).

**Everything runs on Node** (Hector 2026-07-19: one runtime, no PowerShell/VBS layers).
A PC task's action is always `C:\Program Files\nodejs\node.exe` with a `cli\ws.js`
subcommand (or a `cli\util-tools\` script) as the argument — never a .ps1, .vbs, or .bat wrapper.

## The S4U task recipe (THE pattern — proven 2026-07-19 on Claude-WorkspacePull)

Tasks registered to run in the interactive session flash a console window for any
console app, node.exe included (stole focus from Hector's game, 2026-07-17). The fix
is the task's **logon type, not a wrapper**: S4U — "Run whether user is logged on or
not" with *Do not store password* — runs the task in a non-interactive session where
no window can exist.

```powershell
# Registering/changing an S4U task needs ONE elevated prompt (the CEO approves UAC):
$principal = New-ScheduledTaskPrincipal -UserId "$env:USERNAME" -LogonType S4U -RunLevel Limited
$action    = New-ScheduledTaskAction -Execute "C:\Program Files\nodejs\node.exe" `
               -Argument "$env:USERPROFILE\sources\workspace\cli\ws.js pull"
$trigger   = New-ScheduledTaskTrigger -Once -At (Get-Date) -RepetitionInterval (New-TimeSpan -Minutes 15)
Register-ScheduledTask -TaskName "Claude-<Job>" -Principal $principal -Action $action `
  -Trigger $trigger -Settings (New-ScheduledTaskSettingsSet -StartWhenAvailable)
```

What is known to WORK inside the S4U session (verified 2026-07-19):
- `node` and `git` resolve (both on the **machine** PATH — a user-PATH-only tool won't).
- **Git Credential Manager auth works** (DPAPI user store loads with the profile) — a
  private-repo `git fetch` succeeded, so `ws pull`/`ws sync` style tasks are safe.
- Verify a new task the same way it was proven: temporarily wrap the action in
  `cmd.exe /c "... > log 2>&1"`, fire it, read the log (expect the command's real
  output, e.g. `ws pull: up-to-date`), then set the final plain-node action.

Conventions:
- Task names: `Claude-<Job>`; always `-StartWhenAvailable` (missed trigger → runs on wake).
- Keep helper tasks pure-script (zero tokens). If a task needs an agent session, it
  belongs in the container schedule instead.
- If the PC ever becomes a job host again (e.g. a local digest/email lane), do NOT
  create per-job tasks — register ONE S4U task running `node cli\ws.js scheduler`
  at logon; the schedule stays in `configs/jobs/jobs.json` like the container.

## The log-API SSH tunnel (a PC's transport to the VM)

A PC never talks to the log API in cleartext: `LOG_API_URL=http://127.0.0.1:8790` and ssh
forwards that port to the VM. Nothing to register — the existing `Claude-WorkspacePull` tick
ensures the tunnel (config `environments.<WS_ENV>.logApiTunnel` — each PC has its own block,
its own SSH key, and its own source entry in the VM's NSG SSH rule; mechanics in
`server/README.md` / SYSTEM.md). When the API looks unreachable in a session:
`node cli\util-tools\log-api-tunnel.js --status` then plain `log-api-tunnel.js` to heal it
(exits as soon as the tunnel is up; the supervisor keeps running detached, windowless).
Queued audit lines in `<WS_DATA_DIR>/fallback/log.md` replay themselves on the next tick.

**Long-lived processes started from a task**: create them through WMI
(`Invoke-CimMethod Win32_Process Create`), never as a `spawn(detached)` child — a daemon
left in the task's job object makes every later run of that task report 3221226505
(0xC0000409) with the work actually succeeding (see SYSTEM.md, log-API tunnel).

## Rollback host (if the Azure VM dies)

Job-host identity is CONFIG, not procedure (`configs/environments.json` +
`WS_ENV`; the scheduler refuses to arm on a non-owner and re-checks before every
fire — double-running is structurally impossible, not just forbidden):

1. Flip `scheduleOwner` to the rescuing box's `WS_ENV` in `configs/environments.json`
   (names of the current environments: `.claude/environments/environments_setup.md`),
   push (`node cli/ws.js sync`). Name exactly one — the scheduler arms on that
   environment alone. If the VM is still alive, its scheduler silences itself
   within one pull cycle (≤15 min).
2. `cd sources\workspace`, create/copy `.env` with the real secrets (see
   `.env.example`) — including `WS_ENV` set to that same environment.
3. `docker compose up -d --build` — entrypoint pulls the repo, restores the DB
   from the `workspace-backups` repo if empty, and starts the scheduler (which now
   arms because this environment is the owner).
4. Recovery is the same flip in reverse: `scheduleOwner` back to `azure-vm`, push,
   stop the local compose, restart the VM container.

## Diagnosing a task that didn't run

1. `Get-ScheduledTask -TaskName "Claude-*" | Get-ScheduledTaskInfo` — LastRunTime/LastTaskResult
   (0 = success, 267011 = never ran).
2. Task Scheduler history is enabled: Event Viewer → Microsoft-Windows-TaskScheduler/Operational.
3. Common causes: PC asleep past the trigger (StartWhenAvailable catches up on wake), tool
   only on the USER Path (S4U sessions see the machine PATH), execution time limit hit.

## Local app hosting (future)

For hosting actual apps/tools on this PC: a Node process managed as an "At startup"
S4U scheduled task (same recipe) before reaching for NSSM or IIS. Document anything
installed in SYSTEM.md.
