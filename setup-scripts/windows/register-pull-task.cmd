@echo off
REM Double-clickable launcher for register-pull-task.ps1.
REM
REM Why this exists: this machine's LocalMachine execution policy is Restricted, so a
REM .ps1 invoked without an explicit bypass never starts - no output, no transcript, no
REM task, nothing to read. A .cmd always executes on double-click, and it passes
REM -ExecutionPolicy Bypass for this one process only (no policy is changed on the box).
REM
REM The PowerShell script still handles its own UAC elevation; approve the prompt.

setlocal
set "PS1=%~dp0register-pull-task.ps1"

if not exist "%PS1%" (
  echo.
  echo FAIL register-pull-task.ps1 was not found next to this launcher:
  echo      %PS1%
  echo      Keep the two files together.
  echo.
  pause
  exit /b 1
)

powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%PS1%" %*
set "RC=%ERRORLEVEL%"

echo.
echo Launcher exit code: %RC%
echo.
pause
exit /b %RC%
