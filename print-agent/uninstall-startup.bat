@echo off
rem Removes the automatic start of the Copakapana print agent.
schtasks /delete /tn "Copakapana Print Agent" /f
taskkill /fi "WINDOWTITLE eq Copakapana Print Agent*" /f >nul 2>&1
echo The print agent will no longer start automatically.
pause
