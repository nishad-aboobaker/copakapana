@echo off
rem Starts the Copakapana print agent (minimised) whenever this Windows user signs in.
rem Adds one Task Scheduler entry for the current user only - nothing else on the PC changes.
rem Remove it again with uninstall-startup.bat
cd /d "%~dp0"
call npm run build || (echo Build failed & pause & exit /b 1)
schtasks /create /tn "Copakapana Print Agent" /sc onlogon /rl limited /f /tr "cmd /c start \"Copakapana Print Agent\" /min \"%~dp0run-agent.bat\""
if errorlevel 1 (echo Could not create the startup task. & pause & exit /b 1)
echo.
echo Done. The print agent will start automatically at sign-in.
echo Starting it now...
start "Copakapana Print Agent" /min "%~dp0run-agent.bat"
pause
