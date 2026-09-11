# Resume the frozen build after inspecting the initial limited-token failures.
# CPU tests use the existing authorized SSH token; packaged UI remains Limited.
# No privilege grant, policy change, assertion edit, test skip or source rebuild
# from a moving checkout. Original negative TAP/receipt stay intact.
$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
$project=(Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
if ($project -ne 'C:\Synora_QA_final_20260909_6fe71e6f74ff' -or $env:COMPUTERNAME -ne 'AXIOM-WIN-BUILD') {throw 'Unexpected frozen QA root'}
Set-Location $project
$node='C:\Program Files\nodejs\node.exe'
$env:Path='C:\Program Files\nodejs;'+$env:Path
$initial=Get-Content -LiteralPath 'out\live-evidence\windows-final-build.json' -Raw | ConvertFrom-Json
if ($initial.source -ne 'c858d96739122c854083d288f26acc94064c16d7' -or $initial.currentStep -ne 'full-local-suite' -or $initial.exitCode -ne 1) {throw 'Unexpected initial build state'}
$path='out\live-evidence\windows-final-build-resume.json'
if (Test-Path -LiteralPath $path) {throw 'Resume receipt exists; inspect instead of restarting'}
$r=[ordered]@{started=[DateTime]::UtcNow.ToString('o');source=$initial.source;qaRoot=$project;sessionId=[Diagnostics.Process]::GetCurrentProcess().SessionId;elevated=([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator);initialReceipt='out/live-evidence/windows-final-build.json';initialSuite='out/live-evidence/windows-final-local.tap';steps=@();passed=$false;installed=$false;published=$false}
$exitCode=1
function Save-Receipt { [IO.File]::WriteAllText((Join-Path $project $path),($r | ConvertTo-Json -Depth 8),[Text.UTF8Encoding]::new($false)) }
function Step($name,[scriptblock]$action) {$r.currentStep=$name;Save-Receipt;& $action;$r.steps+=@{name=$name;finished=[DateTime]::UtcNow.ToString('o')};Save-Receipt}
try {
  if ($r.sessionId -ne 0 -or -not $r.elevated) {throw 'Use the existing SSH CPU-test token; no elevation is requested here'}
  Step 'frozen-source-reverification' {
    $proof=& $node scripts/source-receipt.mjs verify out/compiled-source-receipt.json
    if ($LASTEXITCODE -ne 0) {throw 'Frozen source mismatch'}
    $r.sourceVerification=($proof -join [Environment]::NewLine) | ConvertFrom-Json
    if ($r.sourceVerification.commit -ne $initial.source -or $r.sourceVerification.files -ne 1185) {throw 'Frozen inventory mismatch'}
    $r.overlay=@(Get-ChildItem -LiteralPath 'tests\fixtures' -File -Filter 'windows-final-*' | ForEach-Object {@{path=('tests/fixtures/'+$_.Name);sha256=(Get-FileHash -LiteralPath $_.FullName).Hash.ToLowerInvariant()}})
    $r.overlay+=@{path='tests/windows-final-metadata.desktop.spec.ts';sha256=(Get-FileHash -LiteralPath 'tests\windows-final-metadata.desktop.spec.ts').Hash.ToLowerInvariant()}
    $r.tempPath=[IO.Path]::GetTempPath()
  }
  $env:SYNORA_QA_ICON_TLS_DIR=Join-Path $project 'out\icon-tls'
  Step 'exact-failure-files-plus-regressions' {
    cmd.exe /d /c 'node node_modules/tsx/dist/cli.mjs --test --test-reporter=tap tests/catalog-icon.test.ts tests/core-updater.test.ts tests/image-attachments.test.ts tests/services.test.ts > out/live-evidence/windows-final-affected-retry.tap 2>&1'
    $r.affectedExitCode=$LASTEXITCODE
    Get-Content 'out\live-evidence\windows-final-affected-retry.tap' -Tail 12
    if ($r.affectedExitCode -ne 0) {throw 'Affected file regression still fails; preserve runtime freeze and inspect exact TAP'}
  }
  Step 'complete-local-suite' {
    cmd.exe /d /c 'node node_modules/tsx/dist/cli.mjs --test --test-reporter=tap tests/*.test.ts tests/native-preparation.test.mjs > out/live-evidence/windows-final-local-retry.tap 2>&1'
    $r.suiteExitCode=$LASTEXITCODE;$r.suiteLog='out/live-evidence/windows-final-local-retry.tap'
    Get-Content $r.suiteLog -Tail 12
    if ($r.suiteExitCode -ne 0) {throw 'Full local suite still fails; preserve negative TAP'}
  }
  Step 'frozen-web-build' {
    & 'C:\Program Files\nodejs\npm.cmd' run build:web
    if ($LASTEXITCODE -ne 0) {throw 'Frozen web build failed'}
  }
  Step 'x64-nsis-unpacked-build' {
    if (Test-Path 'out\production-qa-windows-c858d967') {throw 'Package already exists; refuse overwrite'}
    & 'C:\Program Files\nodejs\npm.cmd' run package:win -- --x64 --config.directories.output=out/production-qa-windows-c858d967 --publish never
    if ($LASTEXITCODE -ne 0) {throw 'Package build failed'}
    $r.executable=Join-Path $project 'out\production-qa-windows-c858d967\win-unpacked\Synora Harness Desktop.exe'
    $r.executableSha256=(Get-FileHash -LiteralPath $r.executable).Hash.ToLowerInvariant()
    $r.asarSha256=(Get-FileHash -LiteralPath 'out\production-qa-windows-c858d967\win-unpacked\resources\app.asar').Hash.ToLowerInvariant()
  }
  Step 'post-build-source-verification' {
    & $node scripts/source-receipt.mjs verify out/compiled-source-receipt.json
    if ($LASTEXITCODE -ne 0) {throw 'Frozen source changed during build'}
  }
  $r.passed=$true;$exitCode=0
} catch {$r.error=$_.Exception.Message} finally {$r.exitCode=$exitCode;$r.finished=[DateTime]::UtcNow.ToString('o');Save-Receipt}
exit $exitCode
