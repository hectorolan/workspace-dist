# setup-scripts/windows/ — one-time setup on an interactive Windows box

Scripts the CEO runs by hand when standing up or repairing a Windows environment.
Nothing here runs on a schedule and nothing here costs tokens. The procedure these
implement is `.claude/SETUP.md` ("New environment bootstrap"); which boxes are in
what state is `.claude/environments/environments_setup.md`.

| Script | What it does | When you run it |
|---|---|---|
| `station-bootstrap.cmd` | Double-clickable launcher for `cli\util-tools\station-bootstrap.js` — walks the whole bootstrap, probes only, tells you what is owed | First and last thing on any new or repaired box; safe to re-run any time |
| `register-pull-task.cmd` | Double-clickable launcher for the script below | Whenever you run it by hand |
| `register-pull-task.ps1` | Registers the `Claude-WorkspacePull` S4U scheduled task (`node cli\ws.js pull` every 15 min) | Bootstrap step 8 on a new Windows box (it is what `station-bootstrap` tells you to run), or to repair a box whose task went missing |

## station-bootstrap.cmd

**Double-click it, or run `node cli\util-tools\station-bootstrap.js`.** It walks the ten
ordered steps of the station procedure, in dependency order, and ends every step in a
machine check. It **never performs a credential action** — it prints the exact command
for you and verifies the result on the next run. Full behaviour, flags and the D5
boundary: SYSTEM.md "Station bootstrap"; the procedure it implements: `.claude/SETUP.md`.

## register-pull-task.ps1

**Double-click `register-pull-task.cmd`** (keep it next to the `.ps1`), or from a shell:

```powershell
powershell -ExecutionPolicy Bypass -File setup-scripts\windows\register-pull-task.ps1
```

**Always launch it one of those two ways.** Windows' default execution policy is
`Restricted`, so a `.ps1` invoked without an explicit bypass — double-clicked, or
right-clicked when the context menu does not supply one — never starts at all: no
output, no transcript, no task, nothing to diagnose. That silent-nothing is what the
`.cmd` exists to prevent; it passes `-ExecutionPolicy Bypass` for that one process and
changes no policy on the box. (Windows 11 2026-07-28: this bit `windows-pc-2` — two
runs produced no evidence whatsoever before the cause was clear.) Do **not** "fix" it
by loosening the machine's policy.

Defaults to `<user profile>\sources\workspace` and task name `Claude-WorkspacePull`;
override with `-WorkspacePath`, `-TaskName`, `-IntervalMinutes`, `-UserId`. Re-running
replaces an existing task, so it is also the repair path.

It preflights *before* asking for elevation (workspace clone, `cli\ws.js`, node,
`git` on the machine PATH, `WS_ENV`), then re-launches itself through UAC, registers
the task, fires it once, and reports `LastTaskResult` — `0` is success.

**Every run is transcripted** to `<WS_DATA_DIR or ~\sources\data>\setup\register-pull-task.log`
(appended, both the unelevated and the elevated pass), each exit path pauses on
`Press Enter to close`, and terminating errors are trapped rather than unwinding the
window shut. This is deliberate: the script spawns a *second* window through UAC whose
output the operator may never see, so "it closed too fast" has to stay diagnosable
after the fact. If a run seems to vanish, read the log — it holds both passes.

Ground truth is never the window anyway:

```powershell
Get-ScheduledTask -TaskName Claude-WorkspacePull | Get-ScheduledTaskInfo
```

**Why elevation is unavoidable:** the task uses the S4U logon type ("run whether user
is logged on or not", no stored password), and registering S4U requires admin. That
logon type is the whole point — it runs in a non-interactive session where no console
window can exist. An Interactive-logon task flashes a window every 15 minutes and
steals focus, which is exactly the 2026-07-17 regression. Do not substitute one to
dodge the UAC prompt.

**Why the task matters more than "keeping docs fresh":** the same 15-minute tick also
replays queued audit lines from the offline fallback and *ensures this box's SSH
tunnel to the log API*. Without the task the tunnel dies with the session, so the box
silently loses log API access until someone runs `ws pull` by hand.

The task's own mechanics, the S4U recipe it encodes, and how to diagnose a task that
did not fire live in the `windows-hosting` skill — not restated here.

## Writing PowerShell for this repo: ASCII only

Windows PowerShell 5.1 reads a BOM-less UTF-8 script as ANSI. A UTF-8 em dash then
decodes as a cp1252 smart quote, and PowerShell accepts smart quotes as string
delimiters — so one stray dash inside a string silently terminates it early and the
file stops parsing (hit while writing `register-pull-task.ps1`; same family as the
UTF-8 BOM that leaked a token on 2026-07-28). Keep `.ps1` files in this repo pure ASCII.

**The byte half of that check is automated** and no longer needs doing by hand: the
`encoding` gate runs on every `ws sync` and as the first CI step, refusing any `.ps1`
holding a byte > 127 (and any BOM'd shell script — the opposite direction of the same
fault). Run it yourself with `node cli/util-tools/encoding-check.js`. Rules, scope and
the never-print-the-line requirement: SYSTEM.md "Encoding guard".

**The parser half stays manual** — it needs a real PowerShell host, which no CI runner
here has. After editing a `.ps1`, on a Windows box:

```powershell
$errs = $null
[System.Management.Automation.Language.Parser]::ParseFile($path, [ref]$null, [ref]$errs)
$errs   # expect nothing
```
