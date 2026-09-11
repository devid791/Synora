# Exact 6abb5b9 QA build. Derived from the validated c7 procedure, never runs it.
$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
$project=(Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
if ($project -ne 'C:\Synora_QA_6abb5b9_20260910_2e1a753a1d8a' -or $env:COMPUTERNAME -ne 'AXIOM-WIN-BUILD') {throw 'Unexpected new QA root'}
Set-Location $project
$node='C:\Program Files\nodejs\node.exe'
$env:Path='C:\Program Files\nodejs;'+$env:Path
$reuse='C:\Synora_QA_c7a7fb8_20260909_6774e0336697'
$source='6abb5b9339e51898846d86e3bf62fb43d6d65a7d'
$output='out\production-qa-windows-6abb5b9'
$receipt=Join-Path $project 'out\live-evidence\6abb5b9-windows-build.json'
if (Test-Path -LiteralPath $receipt) {throw 'Build already attempted; preserve and inspect'}
$r=[ordered]@{started=[DateTime]::UtcNow.ToString('o');source=$source;root=$project;pid=$PID;sessionId=[Diagnostics.Process]::GetCurrentProcess().SessionId;elevated=([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator);tempOverridden=$false;steps=@();passed=$false;installed=$false;published=$false;inferenceRequests=0}
$exitCode=1
function Save-Receipt {[IO.File]::WriteAllText($receipt,($r|ConvertTo-Json -Depth 10),[Text.UTF8Encoding]::new($false))}
function Step($name,[scriptblock]$action) {$r.currentStep=$name;Save-Receipt;& $action;$r.steps+=@{name=$name;finished=[DateTime]::UtcNow.ToString('o')};Save-Receipt}
function Verify-Source {
  $raw=& $node scripts/source-receipt.mjs verify out/compiled-source-receipt.json
  if ($LASTEXITCODE -ne 0) {throw 'Frozen compiled inputs changed'}
  $verified=($raw-join '')|ConvertFrom-Json
  if ($verified.commit -ne $source -or $verified.files -ne 1186 -or $verified.mismatches.Count -ne 0) {throw 'Unexpected source inventory'}
  return $verified
}
try {
  if ($r.sessionId -ne 0 -or -not $r.elevated) {throw 'Requires existing SSH CPU token; no privilege grant'}
  Step 'frozen-source-admission' {
    $r.archiveSha256=(Get-FileHash -LiteralPath 'source.tar.gz').Hash.ToLowerInvariant()
    $r.compiledReceiptSha256=(Get-FileHash -LiteralPath 'compiled-source-receipt.json').Hash.ToLowerInvariant()
    if ($r.archiveSha256 -ne '48215e03086b65df28b1ee1801716a709532674615b809328053f38197c64779' -or $r.compiledReceiptSha256 -ne 'db2ca146585e509ab19a7c01462883ce5a6f95751d6f0eab594207e514abef38') {throw 'Canonical source artifact mismatch'}
    if (Test-Path -LiteralPath 'src') {throw 'Source already extracted; do not overwrite'}
    & tar.exe -xzf source.tar.gz -C $project
    if ($LASTEXITCODE -ne 0) {throw 'Source archive extraction failed'}
    Copy-Item -LiteralPath 'compiled-source-receipt.json' -Destination 'out\compiled-source-receipt.json'
    $r.sourceBefore=Verify-Source
    $r.qaOverlay=@(Get-ChildItem -LiteralPath 'tests\fixtures' -Filter '6abb5b9-windows-*' -File | ForEach-Object {@{path=('tests/fixtures/'+$_.Name);sha256=(Get-FileHash -LiteralPath $_.FullName).Hash.ToLowerInvariant()}})
  }
  Step 'reuse-validated-build-resources' {
    if ((Get-FileHash -LiteralPath 'package-lock.json').Hash -ne (Get-FileHash -LiteralPath ($reuse+'\package-lock.json')).Hash) {throw 'Donor dependency lock mismatch'}
    if (Test-Path -LiteralPath 'node_modules') {throw 'Dependencies already exist; inspect previous attempt'}
    robocopy ($reuse+'\node_modules') ($project+'\node_modules') /E /COPY:DAT /DCOPY:DAT /R:1 /W:1 /NFL /NDL /NJH /NJS /NP
    if ($LASTEXITCODE -gt 7) {throw 'Dependency copy failed'}
    New-Item -ItemType Directory -Path 'out\native','out\core-packages' | Out-Null
    Copy-Item -LiteralPath ($reuse+'\out\native\win32-x64') -Destination 'out\native\win32-x64' -Recurse
    Copy-Item -LiteralPath ($reuse+'\out\core-packages\codex-package-x86_64-pc-windows-msvc.tar.gz') -Destination 'out\core-packages\codex-package-x86_64-pc-windows-msvc.tar.gz'
    # Existing short-lived fixture pair only; no OS trust or private Core state.
    Copy-Item -LiteralPath ($reuse+'\out\icon-tls') -Destination 'out\icon-tls' -Recurse
    $r.donor=$reuse
    $r.dependencyLockSha256=(Get-FileHash -LiteralPath 'package-lock.json').Hash.ToLowerInvariant()
  }
  Step 'typecheck' {
    & $node node_modules/typescript/bin/tsc --noEmit
    if ($LASTEXITCODE -ne 0) {throw 'Typecheck failed'}
  }
  Step 'native-preparation' {
    & $node scripts/prepare-native.mjs
    if ($LASTEXITCODE -ne 0) {throw 'Native preparation failed'}
  }
  Step 'full-windows-366' {
    $env:SYNORA_QA_ICON_TLS_DIR=Join-Path $project 'out\icon-tls'
    cmd.exe /d /c 'node node_modules/tsx/dist/cli.mjs --test --test-reporter=tap tests/*.test.ts tests/native-preparation.test.mjs > out/live-evidence/6abb5b9-windows-local.tap 2>&1'
    $r.testExitCode=$LASTEXITCODE
    $tap=Get-Content -LiteralPath 'out\live-evidence\6abb5b9-windows-local.tap' -Raw
    Get-Content -LiteralPath 'out\live-evidence\6abb5b9-windows-local.tap' -Tail 12
    if ($r.testExitCode -ne 0 -or $tap -notmatch '(?m)^# tests 366\r?$' -or $tap -notmatch '(?m)^# pass 366\r?$' -or $tap -notmatch '(?m)^# fail 0\r?$' -or $tap -notmatch '(?m)^# skipped 0\r?$' -or $tap -notmatch '(?m)^# cancelled 0\r?$') {throw 'Full 366-case suite did not pass completely'}
    $r.testReportSha256=(Get-FileHash -LiteralPath 'out\live-evidence\6abb5b9-windows-local.tap').Hash.ToLowerInvariant()
  }
  Step 'pre-package-source-verification' {$r.sourcePrePackage=Verify-Source}
  Step 'x64-nsis-and-unpacked' {
    if (Test-Path -LiteralPath $output) {throw 'Refuse existing package output'}
    & 'C:\Program Files\nodejs\npm.cmd' run package:win -- --x64 --config.directories.output=out/production-qa-windows-6abb5b9 --publish never
    if ($LASTEXITCODE -ne 0) {throw 'Windows package build failed'}
    $r.executable=Join-Path $project ($output+'\win-unpacked\Synora Harness Desktop.exe')
    $resources=Join-Path $project ($output+'\win-unpacked\resources')
    $r.asarSha256=(Get-FileHash -LiteralPath ($resources+'\app.asar')).Hash.ToLowerInvariant()
    $r.executableSha256=(Get-FileHash -LiteralPath $r.executable).Hash.ToLowerInvariant()
    $installer=Join-Path $project ($output+'\Synora Harness Desktop Setup 0.1.0-foundation.2.exe')
    $r.installer=@{path=$installer;bytes=(Get-Item -LiteralPath $installer).Length;sha256=(Get-FileHash -LiteralPath $installer).Hash.ToLowerInvariant();signing=(Get-AuthenticodeSignature -LiteralPath $installer).Status.ToString()}
    $r.executableSigning=(Get-AuthenticodeSignature -LiteralPath $r.executable).Status.ToString()
    $lock=Get-Content -LiteralPath 'docs\core-runtime-lock.json' -Raw|ConvertFrom-Json
    $core=$lock.targets.'win32-x64'
    $r.packagedCore=@{version=$lock.version;archive=$core.file;bytes=(Get-Item -LiteralPath ($resources+'\core-packages\'+$core.file)).Length;sha256=(Get-FileHash -LiteralPath ($resources+'\core-packages\'+$core.file)).Hash.ToLowerInvariant()}
    if ($r.packagedCore.sha256 -ne $core.sha256 -or $r.packagedCore.bytes -ne $core.size) {throw 'Packaged original Core archive mismatch'}
    $r.nativeWebManifest=Get-Content -LiteralPath ($resources+'\native\win32-x64\web-mcp-manifest.json') -Raw|ConvertFrom-Json
  }
  Step 'post-build-source-verification' {$r.sourceAfter=Verify-Source}
  $r.passed=$true;$exitCode=0
} catch {$r.error=$_.Exception.Message} finally {$r.finished=[DateTime]::UtcNow.ToString('o');$r.exitCode=$exitCode;Save-Receipt}
exit $exitCode
