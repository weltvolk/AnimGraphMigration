$ErrorActionPreference='Stop'
$runtime=Get-Command node -ErrorAction SilentlyContinue
if(!$runtime){throw 'Node.js 22 or newer is required. Install it and run this launcher again. / Bitte Node.js 22 oder neuer installieren und dieses Startskript erneut ausführen.'}
& $runtime.Source (Join-Path $PSScriptRoot 'bin\animgraph-migration.mjs') serve --open
exit $LASTEXITCODE
