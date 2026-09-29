$ErrorActionPreference='Stop'
$runtime=Get-Command node -ErrorAction SilentlyContinue
if(!$runtime){throw 'Node.js 22 oder neuer wird benötigt. Nach der Installation dieses Startskript erneut ausführen.'}
& $runtime.Source (Join-Path $PSScriptRoot 'bin\animgraph-migration.mjs') serve --open
exit $LASTEXITCODE
