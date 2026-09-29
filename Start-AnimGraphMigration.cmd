@echo off
where node >nul 2>&1
if errorlevel 1 (
  echo Install Node.js 22 or newer, then open this launcher again.
  echo Bitte Node.js 22 oder neuer installieren und diese Startdatei erneut oeffnen.
  pause
  exit /b 1
)
node "%~dp0bin\animgraph-migration.mjs" serve --open
if errorlevel 1 pause
