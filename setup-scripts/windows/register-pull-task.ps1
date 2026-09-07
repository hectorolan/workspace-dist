<#
.SYNOPSIS
  Registers the Claude-WorkspacePull scheduled task on a Windows interactive box.

.DESCRIPTION
  Step 6 of the "New environment bootstrap" in .claude/SETUP.md, as a script.

  The task runs `node cli\ws.js pull` every 15 minutes. That single tick does three
  things the box cannot go without: it keeps the workspace clone fresh, it replays
  queued audit lines from the offline fallback, and it ensures the SSH tunnel that
  carries this box's log API traffic. Without the task, the tunnel dies with the
  session and the log API is unreachable until someone runs `ws pull` by hand.

  Logon type is S4U ("run whether user is logged on or not", no stored password):
  it runs in a non-interactive session where no console window can exist. An
  Interactive-logon task flashes a window every 15 minutes and steals focus - do
  not substitute one. S4U registration is what needs the elevation; the script
  re-launches itself through UAC if it was not started elevated.

  Safe to re-run: an existing task with the same name is replaced.

  ASCII ONLY, deliberately. Windows PowerShell 5.1 reads a BOM-less UTF-8 script as
  ANSI, which turns a UTF-8 em dash into a cp1252 smart quote - and PowerShell
  accepts smart quotes as string delimiters, so one stray dash terminates a string
  early and the file no longer parses. Keep every character in this file ASCII.

.PARAMETER WorkspacePath
  The workspace clone. Defaults to <user profile>\sources\workspace.

.PARAMETER TaskName
  Defaults to Claude-WorkspacePull. Convention is Claude-<Job>.

.PARAMETER IntervalMinutes
  Repetition interval. Defaults to 15 - every environment pulls at least this often,
  which is what bounds config propagation (e.g. a scheduleOwner flip).

.PARAMETER UserId
  Account the task runs as. Defaults to the user who launched the script - captured
  BEFORE elevation on purpose, so elevating as a different admin account still
  registers the task for the right person.

.PARAMETER SkipVerify
  Skip the post-registration test run.

.EXAMPLE
  .\register-pull-task.ps1
  Right-click "Run with PowerShell", approve the UAC prompt, read the result.
#>
[CmdletBinding()]
param(
  [string] $WorkspacePath   = (Join-Path $env:USERPROFILE 'sources\workspace'),
  [string] $TaskName        = 'Claude-WorkspacePull',
  [int]    $IntervalMinutes = 15,
  [string] $UserId          = $env:USERNAME,
  [switch] $SkipVerify
)

$ErrorActionPreference = 'Stop'

function Write-Step  { param($m) Write-Host "==> $m" -ForegroundColor Cyan }
function Write-Ok    { param($m) Write-Host "OK   $m" -ForegroundColor Green }
function Write-Warn2 { param($m) Write-Host "WARN $m" -ForegroundColor Yellow }
function Write-Fail  { param($m) Write-Host "FAIL $m" -ForegroundColor Red }

# --- Evidence: never let a failure vanish with the window ---
# This script elevates, which means a second window whose output the operator may
# never see. Both runs append to one transcript, so "it closed too fast" is always
# diagnosable after the fact.

$logDir = $env:WS_DATA_DIR
if ([string]::IsNullOrWhiteSpace($logDir)) {
  $logDir = Join-Path $env:USERPROFILE 'sources\data'
}
$logDir = Join-Path $logDir 'setup'
try {
  if (-not (Test-Path $logDir)) { New-Item -ItemType Directory -Path $logDir -Force | Out-Null }
} catch {
  $logDir = $env:TEMP
}
$LogPath = Join-Path $logDir 'register-pull-task.log'
try { Start-Transcript -Path $LogPath -Append | Out-Null } catch { }

# Every exit goes through here: stop the transcript, tell the operator where the log
# is, and hold the window open so the last screen is readable.
function Finish {
  param([int] $Code)
  Write-Host ""
  Write-Host "Log: $LogPath"
  try { Stop-Transcript | Out-Null } catch { }
  if ([Environment]::UserInteractive) {
    Write-Host ""
    Read-Host "Press Enter to close"
  }
  exit $Code
}

# ErrorActionPreference is Stop, so any cmdlet failure (a denied Register-ScheduledTask
# above all) is terminating. Without this trap it would unwind past Finish, leaving the
# transcript open and the window closing on the operator before they can read the cause.
trap {
  Write-Fail "unhandled error: $($_.Exception.Message)"
  if ($_.ScriptStackTrace) { Write-Host $_.ScriptStackTrace }
  Finish 1
}

# --- Preflight (runs unelevated too, so failures surface before the UAC prompt) ---

Write-Step "Checking prerequisites"

if (-not (Test-Path $WorkspacePath)) {
  Write-Fail "workspace clone not found at $WorkspacePath"
  Write-Host "  Pass the real path: .\register-pull-task.ps1 -WorkspacePath C:\path\to\workspace"
  Finish 1
}

$wsScript = Join-Path $WorkspacePath 'cli\ws.js'
if (-not (Test-Path $wsScript)) {
  Write-Fail "cli\ws.js not found under $WorkspacePath - is that really the workspace clone?"
  Finish 1
}
Write-Ok "workspace  $WorkspacePath"

# The action uses node's absolute path, so node itself needs no PATH entry.
$nodeExe = 'C:\Program Files\nodejs\node.exe'
if (-not (Test-Path $nodeExe)) {
  $cmd = Get-Command node.exe -ErrorAction SilentlyContinue
  if ($null -eq $cmd) {
    Write-Fail "node.exe not found (looked in Program Files and on PATH)"
    Finish 1
  }
  $nodeExe = $cmd.Source
}
Write-Ok "node       $nodeExe"

# git DOES need to be on the MACHINE path: an S4U session does not see user PATH.
$machinePath = [Environment]::GetEnvironmentVariable('Path', 'Machine')
$gitOnMachinePath = $false
foreach ($entry in ($machinePath -split ';')) {
  if ([string]::IsNullOrWhiteSpace($entry)) { continue }
  try {
    if (Test-Path (Join-Path $entry 'git.exe')) { $gitOnMachinePath = $true; break }
  } catch { }
}
if ($gitOnMachinePath) {
  Write-Ok "git        on the machine PATH (visible to the S4U session)"
} else {
  Write-Warn2 "git.exe not found on the MACHINE PATH - an S4U session cannot see user-only PATH"
  Write-Warn2 'the task will register, but ws pull may fail inside it; verify the run result below'
}

# WS_ENV is how every environment identifies itself; without it ws refuses to act.
if ([string]::IsNullOrWhiteSpace($env:WS_ENV)) {
  Write-Warn2 "WS_ENV is not set in this shell - the box may not be fully bootstrapped yet"
  Write-Warn2 "see .claude/SETUP.md 'New environment bootstrap' step 4 (identity env vars)"
} else {
  Write-Ok "WS_ENV     $env:WS_ENV"
}

# --- Elevate (S4U registration is what needs it) ---

$identity       = [Security.Principal.WindowsIdentity]::GetCurrent()
$principalCheck = New-Object Security.Principal.WindowsPrincipal($identity)
$isElevated     = $principalCheck.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)

if (-not $isElevated) {
  Write-Step "Not elevated - re-launching through UAC (approve the prompt)"
  $argList = @(
    '-NoExit', '-ExecutionPolicy', 'Bypass', '-File', "`"$PSCommandPath`"",
    '-WorkspacePath', "`"$WorkspacePath`"",
    '-TaskName', "`"$TaskName`"",
    '-IntervalMinutes', $IntervalMinutes,
    '-UserId', "`"$UserId`""
  )
  if ($SkipVerify) { $argList += '-SkipVerify' }
  try {
    Start-Process -FilePath 'powershell.exe' -Verb RunAs -ArgumentList $argList
  } catch {
    Write-Fail "elevation was declined or failed - the task cannot be registered without it"
    Finish 1
  }
  Write-Host "Continue in the elevated window that just opened."
  Finish 0
}

Write-Ok "elevated   yes (registering as user '$UserId')"

# --- Register ---

Write-Step "Registering scheduled task '$TaskName'"

$existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($null -ne $existing) {
  Write-Warn2 "task already exists - replacing it"
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
}

$principal = New-ScheduledTaskPrincipal -UserId $UserId -LogonType S4U -RunLevel Limited
$action    = New-ScheduledTaskAction -Execute $nodeExe -Argument "$wsScript pull"
$trigger   = New-ScheduledTaskTrigger -Once -At (Get-Date) `
               -RepetitionInterval (New-TimeSpan -Minutes $IntervalMinutes)
$settings  = New-ScheduledTaskSettingsSet -StartWhenAvailable

Register-ScheduledTask -TaskName $TaskName -Principal $principal -Action $action `
  -Trigger $trigger -Settings $settings | Out-Null

Write-Ok "registered $TaskName - every $IntervalMinutes min, S4U, StartWhenAvailable"

# --- Verify (same way the pattern was proven: fire it, read the result) ---

if ($SkipVerify) {
  Write-Warn2 "verification skipped (-SkipVerify) - check LastTaskResult yourself"
  Finish 0
}

Write-Step "Test run"
Start-ScheduledTask -TaskName $TaskName

$deadline = (Get-Date).AddSeconds(90)
$info = $null
while ((Get-Date) -lt $deadline) {
  Start-Sleep -Seconds 3
  $info = Get-ScheduledTask -TaskName $TaskName | Get-ScheduledTaskInfo
  if ($info.LastTaskResult -ne 267009) { break }   # 267009 = still running
}

if ($null -eq $info) {
  Write-Fail "could not read task info"
  Finish 1
}

Write-Host ""
Write-Host "LastRunTime    : $($info.LastRunTime)"
Write-Host "LastTaskResult : $($info.LastTaskResult)"
Write-Host ""

switch ($info.LastTaskResult) {
  0 {
    Write-Ok "task ran successfully - pull + tunnel keeper are live on this box"
    Write-Host ""
    Write-Host "Record it: mark the box's pull task registered in"
    Write-Host "  .claude/environments/environments_setup.md"
    Write-Host "and close the backlog item, then one 'node cli\ws.js log' call."
    Finish 0
  }
  267009 {
    Write-Warn2 "still running after 90s - first pull can be slow; re-check with:"
    Write-Host "  Get-ScheduledTask -TaskName '$TaskName' | Get-ScheduledTaskInfo"
    Finish 0
  }
  267011 {
    Write-Fail "task has never run - check the trigger in Task Scheduler"
    Finish 1
  }
  default {
    Write-Fail "task exited with $($info.LastTaskResult)"
    Write-Host "  Diagnose per the windows-hosting skill:"
    Write-Host "   - Event Viewer -> Microsoft-Windows-TaskScheduler/Operational"
    Write-Host "   - a tool visible only on the USER PATH (S4U sees the machine PATH)"
    Write-Host "   - 3221226505 (0xC0000409): a daemon left in the task's job object"
    Finish 1
  }
}
