# Additive QA controller: frozen source only, no setup, installation or publish.
$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
$project=(Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
if ($project -ne 'C:\Synora_QA_final_20260909_6fe71e6f74ff' -or $env:COMPUTERNAME -ne 'AXIOM-WIN-BUILD') { throw 'Unexpected owned QA target' }
Set-Location $project
$node='C:\Program Files\nodejs\node.exe'
$env:Path='C:\Program Files\nodejs;'+$env:Path
$commit='c858d96739122c854083d288f26acc94064c16d7'
$reuse='C:\Synora_QA_ea9df76_20260909'
$package='out\production-qa-windows-c858d967'
$receiptPath='out\live-evidence\windows-final-build.json'
if (Test-Path -LiteralPath $receiptPath) { throw 'Existing build receipt; inspect before any retry' }
$r=[ordered]@{started=[DateTime]::UtcNow.ToString('o');source=$commit;qaRoot=$project;sessionId=[Diagnostics.Process]::GetCurrentProcess().SessionId;elevated=([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator);steps=@();passed=$false;installed=$false;published=$false}
$exitCode=1
function Save-Receipt { [IO.File]::WriteAllText((Join-Path $project $receiptPath),($r | ConvertTo-Json -Depth 8),[Text.UTF8Encoding]::new($false)) }
function Step($name,[scriptblock]$action) {
  $r.currentStep=$name; Save-Receipt
  & $action
  $r.steps+=@{name=$name;finished=[DateTime]::UtcNow.ToString('o')}
  Save-Receipt
}
try {
  if ($r.sessionId -ne 1 -or $r.elevated) { throw 'Expected limited builder Session1' }
  Step 'source-admission' {
    if ((Get-FileHash -LiteralPath 'source.tar.gz' -Algorithm SHA256).Hash -ine '24477a52c247d29cb167b0424a459edac146887e168ca6fed0d828309fc5b78e') { throw 'Archive hash mismatch' }
    if ((Get-FileHash -LiteralPath 'out\compiled-source-receipt.json' -Algorithm SHA256).Hash -ine 'b52ee9aa2a6ba5f4c9810d9ee9b18d041d108ff084036a843d22841789ddcc60') { throw 'Source receipt hash mismatch' }
    $proof=& $node scripts/source-receipt.mjs verify out/compiled-source-receipt.json
    if ($LASTEXITCODE -ne 0) { throw 'Frozen compiled source mismatch' }
    $s=($proof -join [Environment]::NewLine) | ConvertFrom-Json
    if ($s.commit -ne $commit -or $s.files -ne 1185 -or $s.mismatches.Count -ne 0) { throw 'Unexpected frozen source inventory' }
    $r.sourceVerification=$s
    $r.overlay=@(Get-ChildItem -LiteralPath 'tests\fixtures' -File -Filter 'windows-final-*' | ForEach-Object { @{path=('tests/fixtures/'+$_.Name);sha256=(Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash.ToLowerInvariant()} })
    if (Test-Path 'tests\windows-final-metadata.desktop.spec.ts') {
      $r.overlay+=@{path='tests/windows-final-metadata.desktop.spec.ts';sha256=(Get-FileHash -LiteralPath 'tests\windows-final-metadata.desktop.spec.ts' -Algorithm SHA256).Hash.ToLowerInvariant()}
    }
  }
  Step 'reuse-matching-dependencies' {
    if ((Get-FileHash 'package-lock.json').Hash -ne (Get-FileHash (Join-Path $reuse 'package-lock.json')).Hash) { throw 'Cannot reuse a different dependency lock' }
    if (Test-Path 'node_modules') { throw 'Dependencies already exist; inspect prior run' }
    robocopy (Join-Path $reuse 'node_modules') (Join-Path $project 'node_modules') /E /COPY:DAT /DCOPY:DAT /R:1 /W:1 /NFL /NDL /NJH /NJS /NP
    if ($LASTEXITCODE -gt 7) { throw 'Dependency copy failed' }
    Copy-Item -LiteralPath (Join-Path $reuse 'out\native\win32-x64') -Destination 'out\native\win32-x64' -Recurse
    Copy-Item -LiteralPath (Join-Path $reuse 'out\core-packages\codex-package-x86_64-pc-windows-msvc.tar.gz') -Destination 'out\core-packages\codex-package-x86_64-pc-windows-msvc.tar.gz'
  }
  Step 'typecheck' {
    & $node node_modules/typescript/bin/tsc --noEmit
    if ($LASTEXITCODE -ne 0) { throw 'Typecheck failed' }
  }
  Step 'native-preparation' {
    & $node scripts/prepare-native.mjs
    if ($LASTEXITCODE -ne 0) { throw 'Native preparation failed' }
  }
  Step 'full-local-suite' {
    $env:SYNORA_QA_ICON_TLS_DIR=Join-Path $project 'out\icon-tls'
    if (-not (Test-Path (Join-Path $env:SYNORA_QA_ICON_TLS_DIR 'cert.pem')) -or -not (Test-Path (Join-Path $env:SYNORA_QA_ICON_TLS_DIR 'key.pem'))) { throw 'Fresh QA-only TLS inputs required' }
    $r.suiteLog='out/live-evidence/windows-final-local.tap'
    cmd.exe /d /c 'node node_modules/tsx/dist/cli.mjs --test --test-reporter=tap tests/*.test.ts tests/native-preparation.test.mjs > out/live-evidence/windows-final-local.tap 2>&1'
    $r.suiteExitCode=$LASTEXITCODE
    Get-Content -LiteralPath $r.suiteLog -Tail 12
    if ($r.suiteExitCode -ne 0) { throw 'Local suite failed; full original TAP retained' }
  }
  Step 'frozen-web-build' {
    & 'C:\Program Files\nodejs\npm.cmd' run build:web
    if ($LASTEXITCODE -ne 0) { throw 'Frozen web build failed' }
  }
  Step 'x64-nsis-unpacked-build' {
    if (Test-Path -LiteralPath $package) { throw 'Package target already exists; no overwrite' }
    & 'C:\Program Files\nodejs\npm.cmd' run package:win -- --x64 --config.directories.output=out/production-qa-windows-c858d967 --publish never
    if ($LASTEXITCODE -ne 0) { throw 'Windows package failed' }
    $r.asarSha256=(Get-FileHash -LiteralPath (Join-Path $package 'win-unpacked\resources\app.asar') -Algorithm SHA256).Hash.ToLowerInvariant()
    $r.executable=Join-Path $project (Join-Path $package 'win-unpacked\Synora Harness Desktop.exe')
    $r.executableSha256=(Get-FileHash -LiteralPath $r.executable -Algorithm SHA256).Hash.ToLowerInvariant()
  }
  Step 'post-build-source-verification' {
    & $node scripts/source-receipt.mjs verify out/compiled-source-receipt.json
    if ($LASTEXITCODE -ne 0) { throw 'Frozen source changed during build' }
  }
  $r.passed=$true;$exitCode=0
} catch { $r.error=$_.Exception.Message } finally {
  $r.exitCode=$exitCode;$r.finished=[DateTime]::UtcNow.ToString('o');Save-Receipt
}
exit $exitCode
