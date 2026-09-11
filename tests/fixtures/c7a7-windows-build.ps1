# Exact c7a7fb8 CPU-only build in a new tree. No setup, install or publish.
$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
$project=(Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
if ($project -ne 'C:\Synora_QA_c7a7fb8_20260909_6774e0336697' -or $env:COMPUTERNAME -ne 'AXIOM-WIN-BUILD') {throw 'Unexpected new QA root'}
Set-Location $project
$node='C:\Program Files\nodejs\node.exe'
$env:Path='C:\Program Files\nodejs;'+$env:Path
$reuse='C:\Synora_QA_final_20260909_6fe71e6f74ff'
$source='c7a7fb873dce16e403cb6b127c32ed5fbdbfd683'
$receipt=Join-Path $project 'out\live-evidence\c7a7-windows-build.json'
if (Test-Path -LiteralPath $receipt) {throw 'Build already attempted; preserve evidence and inspect'}
$r=[ordered]@{started=[DateTime]::UtcNow.ToString('o');source=$source;root=$project;sessionId=[Diagnostics.Process]::GetCurrentProcess().SessionId;elevated=([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator);temp=$env:TEMP;tmp=$env:TMP;tempOverridden=$false;steps=@();passed=$false;installed=$false;published=$false;inferenceRequests=0}
$exitCode=1
function Save-Receipt {[IO.File]::WriteAllText($receipt,($r|ConvertTo-Json -Depth 8),[Text.UTF8Encoding]::new($false))}
function Step($name,[scriptblock]$action) {$r.currentStep=$name;Save-Receipt;& $action;$r.steps+=@{name=$name;finished=[DateTime]::UtcNow.ToString('o')};Save-Receipt}
function Verify-Source {
  $raw=& $node scripts/source-receipt.mjs verify out/compiled-source-receipt.json
  if ($LASTEXITCODE -ne 0) {throw 'Frozen compiled inputs changed'}
  $verified=($raw-join '')|ConvertFrom-Json
  if ($verified.commit -ne $source -or $verified.files -ne 1186 -or $verified.mismatches.Count -ne 0) {throw 'Unexpected source inventory'}
  return $verified
}
try {
  if ($r.sessionId -ne 0 -or -not $r.elevated) {throw 'Use the existing SSH CPU-test token only; no privilege grant'}
  Step 'frozen-source-admission' {
    $r.archiveSha256=(Get-FileHash -LiteralPath 'source.tar.gz').Hash.ToLowerInvariant()
    $r.compiledReceiptSha256=(Get-FileHash -LiteralPath 'compiled-source-receipt.json').Hash.ToLowerInvariant()
    if ($r.archiveSha256 -ne '5cc1c24b5aba55ac5096be82068419d1b1fd08ff145de1f322b73e06c6d65014' -or $r.compiledReceiptSha256 -ne '876e7ca69b22cfdff2ac9e5d717700729ca0bbdf0d7ab5a10c0ee7d5270636c8') {throw 'Canonical source artifact mismatch'}
    if (Test-Path -LiteralPath 'src') {throw 'Source already extracted; do not overwrite a prior attempt'}
    & tar.exe -xzf source.tar.gz -C $project
    if ($LASTEXITCODE -ne 0) {throw 'Archive extraction failed'}
    Copy-Item -LiteralPath 'compiled-source-receipt.json' -Destination 'out\compiled-source-receipt.json'
    $r.sourceBefore=Verify-Source
    $r.qaOverlay=@(Get-ChildItem -LiteralPath 'tests\fixtures' -Filter 'c7a7-windows-*' -File | ForEach-Object {@{path=('tests/fixtures/'+$_.Name);sha256=(Get-FileHash -LiteralPath $_.FullName).Hash.ToLowerInvariant()}})
  }
  Step 'reuse-validated-build-dependencies' {
    if ((Get-FileHash -LiteralPath 'package-lock.json').Hash -ne (Get-FileHash -LiteralPath ($reuse+'\package-lock.json')).Hash) {throw 'Dependency lock mismatch'}
    if (Test-Path -LiteralPath 'node_modules') {throw 'Dependencies already exist; inspect prior attempt'}
    robocopy ($reuse+'\node_modules') ($project+'\node_modules') /E /COPY:DAT /DCOPY:DAT /R:1 /W:1 /NFL /NDL /NJH /NJS /NP
    if ($LASTEXITCODE -gt 7) {throw 'Dependency copy failed'}
    Copy-Item -LiteralPath ($reuse+'\out\native') -Destination 'out\native' -Recurse
    New-Item -ItemType Directory -Path 'out\core-packages' -Force | Out-Null
    Copy-Item -LiteralPath ($reuse+'\out\core-packages\codex-package-x86_64-pc-windows-msvc.tar.gz') -Destination 'out\core-packages\codex-package-x86_64-pc-windows-msvc.tar.gz'
    # Reuse only the still-valid short-lived QA TLS material, never OS trust or
    # private Core/app state. The TLS fixture checks validity and exact key pair.
    Copy-Item -LiteralPath ($reuse+'\out\icon-tls') -Destination 'out\icon-tls' -Recurse
  }
  Step 'typecheck' {
    & $node node_modules/typescript/bin/tsc --noEmit
    if ($LASTEXITCODE -ne 0) {throw 'Typecheck failed'}
  }
  Step 'native-preparation' {
    & $node scripts/prepare-native.mjs
    if ($LASTEXITCODE -ne 0) {throw 'Native preparation failed'}
  }
  Step 'full-windows-351' {
    $env:SYNORA_QA_ICON_TLS_DIR=Join-Path $project 'out\icon-tls'
    cmd.exe /d /c 'node node_modules/tsx/dist/cli.mjs --test --test-reporter=tap tests/*.test.ts tests/native-preparation.test.mjs > out/live-evidence/c7a7-windows-local.tap 2>&1'
    $r.testExitCode=$LASTEXITCODE
    $tap=Get-Content -LiteralPath 'out\live-evidence\c7a7-windows-local.tap' -Raw
    Get-Content -LiteralPath 'out\live-evidence\c7a7-windows-local.tap' -Tail 12
    if ($r.testExitCode -ne 0 -or $tap -notmatch '(?m)^# tests 351\r?$' -or $tap -notmatch '(?m)^# pass 351\r?$' -or $tap -notmatch '(?m)^# fail 0\r?$' -or $tap -notmatch '(?m)^# skipped 0\r?$' -or $tap -notmatch '(?m)^# cancelled 0\r?$') {throw 'Full 351-case suite did not pass completely'}
    $r.testReportSha256=(Get-FileHash -LiteralPath 'out\live-evidence\c7a7-windows-local.tap').Hash.ToLowerInvariant()
  }
  Step 'pre-package-source-verification' {$r.sourcePrePackage=Verify-Source}
  Step 'x64-nsis-and-unpacked' {
    if (Test-Path -LiteralPath 'out\production-qa-windows-c7a7fb8') {throw 'Refuse overwrite of existing package output'}
    & 'C:\Program Files\nodejs\npm.cmd' run package:win -- --x64 --config.directories.output=out/production-qa-windows-c7a7fb8 --publish never
    if ($LASTEXITCODE -ne 0) {throw 'Windows package build failed'}
    $r.executable=Join-Path $project 'out\production-qa-windows-c7a7fb8\win-unpacked\Synora Harness Desktop.exe'
    $r.asarSha256=(Get-FileHash -LiteralPath 'out\production-qa-windows-c7a7fb8\win-unpacked\resources\app.asar').Hash.ToLowerInvariant()
    $r.executableSha256=(Get-FileHash -LiteralPath $r.executable).Hash.ToLowerInvariant()
    $installer=Join-Path $project 'out\production-qa-windows-c7a7fb8\Synora Harness Desktop Setup 0.1.0-foundation.2.exe'
    $r.installer=@{path=$installer;bytes=(Get-Item -LiteralPath $installer).Length;sha256=(Get-FileHash -LiteralPath $installer).Hash.ToLowerInvariant();signing=(Get-AuthenticodeSignature -LiteralPath $installer).Status.ToString()}
    $r.executableSigning=(Get-AuthenticodeSignature -LiteralPath $r.executable).Status.ToString()
  }
  Step 'post-build-source-verification' {$r.sourceAfter=Verify-Source}
  $r.passed=$true;$exitCode=0
} catch {$r.error=$_.Exception.Message} finally {$r.finished=[DateTime]::UtcNow.ToString('o');$r.exitCode=$exitCode;Save-Receipt}
exit $exitCode
