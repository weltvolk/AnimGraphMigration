@echo off
where node >nul 2>&1
if errorlevel 1 (
  echo Bitte zuerst Node.js 22 oder neuer installieren.
  echo Danach diese Startdatei erneut oeffnen.
  pause
  exit /b 1
)
node "%~dp0bin\animgraph-migration.mjs" serve --open
if errorlevel 1 pause
