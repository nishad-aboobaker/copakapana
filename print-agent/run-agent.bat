@echo off
rem Copakapana print agent - keeps running; restarts automatically if it stops.
title Copakapana Print Agent
cd /d "%~dp0"
if not exist dist\agent.js call npm run build
:loop
echo [%date% %time%] Starting print agent...
node dist\agent.js
echo [%date% %time%] Print agent stopped - restarting in 5 seconds...
timeout /t 5 /nobreak >nul
goto loop
