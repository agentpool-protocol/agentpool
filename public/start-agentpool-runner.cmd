@echo off
setlocal
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0Start-AgentPoolRunner.ps1" %*
set "AGENTPOOL_EXIT=%ERRORLEVEL%"
if not "%AGENTPOOL_EXIT%"=="0" (
  echo.
  echo AgentPool Runner failed. See the log path printed above.
  if /I not "%~1"=="--autostart" if /I not "%~1"=="-LauncherSmoke" pause
)
exit /b %AGENTPOOL_EXIT%
