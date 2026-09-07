@echo off
REM Double-clickable launcher for the station bootstrap walk
REM (cli\util-tools\station-bootstrap.js - plan environment-setup-streamlining, W6).
REM
REM Why a .cmd and not a .ps1: the default LocalMachine execution policy is Restricted,
REM so a .ps1 invoked without an explicit bypass does not error - it silently never
REM starts, leaving no output and nothing to read. A .cmd always executes on
REM double-click. This launcher changes no policy on the box.
REM
REM What it runs is a Node tool, and it PROBES ONLY: it reads, compares and reports,
REM prints the exact commands for you to run, and never performs a credential action.
REM Safe to run any number of times.
REM
REM Pass-through flags: --all  --deep  --fast  --json  --step <id>

setlocal
set "TOOL=%~dp0..\..\cli\util-tools\station-bootstrap.js"

if not exist "%TOOL%" (
  echo.
  echo FAIL station-bootstrap.js was not found at:
  echo      %TOOL%
  echo      Run this from inside the workspace clone ^(setup-scripts\windows\^).
  echo.
  pause
  exit /b 2
)

set "NODE=C:\Program Files\nodejs\node.exe"
if not exist "%NODE%" set "NODE=node"

"%NODE%" "%TOOL%" %*
set "RC=%ERRORLEVEL%"

echo.
if "%RC%"=="0" echo Result: this station is fully bootstrapped ^(nothing owed^).
if "%RC%"=="1" echo Result: a human action is owed - see the TODO step above.
if "%RC%"=="2" echo Result: the tool itself failed - the transcript path is printed above.
echo Launcher exit code: %RC%
echo.
pause
exit /b %RC%
