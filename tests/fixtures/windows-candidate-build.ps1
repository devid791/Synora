# Build only the isolated candidate owning this script. No setup or installation.
$ErrorActionPreference = 'Stop'
$project = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
if ($project -ne 'C:\Synora_QA_ea9df76_20260909') { throw 'Unexpected QA root' }
Set-Location $project
$reuse = 'C:\Synora_Production_QA_9cfc8ac'
if ((Get-FileHash 'package-lock.json').Hash -ne (Get-FileHash (Join-Path $reuse 'package-lock.json')).Hash) { throw 'Cannot reuse dependencies from a different lock' }
if (-not (Test-Path 'node_modules')) {
  robocopy (Join-Path $reuse 'node_modules') (Join-Path $project 'node_modules') /E /COPY:DAT /DCOPY:DAT /R:1 /W:1 /NFL /NDL /NJH /NJS /NP
  if ($LASTEXITCODE -gt 7) { throw 'Dependency copy failed' }
}
New-Item -ItemType Directory -Force 'out\core-packages','out\native','out\live-evidence' | Out-Null
if (-not (Test-Path 'out\native\win32-x64')) {
  Copy-Item (Join-Path $reuse 'out\native\win32-x64') 'out\native\win32-x64' -Recurse
}
if (-not (Test-Path 'out\core-packages\codex-package-x86_64-pc-windows-msvc.tar.gz')) {
  Copy-Item (Join-Path $reuse 'out\core-packages\codex-package-x86_64-pc-windows-msvc.tar.gz') 'out\core-packages\'
}
# package-runtime.mjs verifies exact Core archive, helper binary AND all sources.
node scripts/source-receipt.mjs verify out/compiled-source-receipt.json
if ($LASTEXITCODE -ne 0) { throw 'Compiled input mismatch' }
npm.cmd run typecheck
if ($LASTEXITCODE -ne 0) { throw 'Typecheck failed' }
node scripts/prepare-native.mjs
if ($LASTEXITCODE -ne 0) { throw 'Native preparation failed' }
$env:SYNORA_QA_ICON_TLS_DIR=Join-Path $project 'out\icon-tls'
$suiteLog='out/live-evidence/windows-suite-ea9df76-'+[Guid]::NewGuid().ToString('N')+'.tap'
cmd.exe /d /c "node node_modules/tsx/dist/cli.mjs --test --test-reporter=tap tests/*.test.ts tests/native-preparation.test.mjs > $suiteLog 2>&1"
if ($LASTEXITCODE -ne 0) { throw 'Local test suite failed; read the preserved TAP' }
Write-Output $suiteLog
Get-Content $suiteLog -Tail 12
npm.cmd run build:web
if ($LASTEXITCODE -ne 0) { throw 'Web build failed' }
npm.cmd run package:win -- --config.directories.output=out/production-qa-windows-ea9df76 --publish never
if ($LASTEXITCODE -ne 0) { throw 'Windows package failed' }
Get-FileHash 'out\production-qa-windows-ea9df76\win-unpacked\resources\app.asar'
