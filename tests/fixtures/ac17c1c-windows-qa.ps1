# Exact isolated candidate build / five non-inference native checks.
# No old helper invocation, prepared-home use, Core extraction or OS setup.
param([Parameter(Mandatory=$true)][ValidateSet('Build','Native')][string]$Phase)
$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
$project=(Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
if ($project -ne 'C:\Synora_QA_ac17c1c_20260910_c05c8a76b463' -or $env:COMPUTERNAME -ne 'AXIOM-WIN-BUILD') {throw 'Unexpected owned QA root'}
Set-Location $project
$node='C:\Program Files\nodejs\node.exe'
$env:Path='C:\Program Files\nodejs;'+$env:Path
$source='ac17c1c3183b88a5721778f751a3410010f56259'
$package='out\production-qa-windows-ac17c1c'
$reuse='C:\Synora_QA_6abb5b9_20260910_2e1a753a1d8a'
$session=[Diagnostics.Process]::GetCurrentProcess().SessionId
$elevated=([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
$receipt=Join-Path $project ('out\live-evidence\ac17c1c-windows-'+$Phase.ToLower()+'.json')
if (Test-Path -LiteralPath $receipt) {throw 'Phase already attempted; preserve evidence and inspect'}
$r=[ordered]@{started=[DateTime]::UtcNow.ToString('o');source=$source;root=$project;phase=$Phase;pid=$PID;sessionId=$session;elevated=$elevated;steps=@();passed=$false;inferenceRequests=0;preparedHomeUsed=$false;installed=$false;published=$false}
function Save-Receipt {[IO.File]::WriteAllText($receipt,($r|ConvertTo-Json -Depth 12),[Text.UTF8Encoding]::new($false))}
function Step($name,[scriptblock]$action) {$r.currentStep=$name;Save-Receipt;& $action;$r.steps+=@{name=$name;finished=[DateTime]::UtcNow.ToString('o')};Save-Receipt}
function Verify-Source {
  $raw=& $node scripts/source-receipt.mjs verify out/compiled-source-receipt.json
  if ($LASTEXITCODE -ne 0) {throw 'Frozen compiled inputs changed'}
  $v=($raw-join '')|ConvertFrom-Json
  if ($v.commit -ne $source -or $v.files -ne 1186 -or $v.mismatches.Count -ne 0) {throw 'Unexpected source inventory'}
  return $v
}
$exitCode=1
Save-Receipt
try {
  if ($Phase -eq 'Build') {
    if ($session -ne 0) {throw 'Use existing SSH CPU session for build'}
    Step 'frozen-source-admission' {
      $r.archiveSha256=(Get-FileHash -LiteralPath 'source.tar.gz').Hash.ToLowerInvariant()
      $r.compiledReceiptSha256=(Get-FileHash -LiteralPath 'compiled-source-receipt.json').Hash.ToLowerInvariant()
      if ($r.archiveSha256 -ne 'bf56c0f7268b1db3600157cb8e7e8e10e3b39bf5c546ef098fab8fdd8e04e5b7' -or $r.compiledReceiptSha256 -ne '974e9a897c60bea75debc5e0c50186af13af1b7f18a8292f9c8534ebe310c092') {throw 'Canonical archive/receipt mismatch'}
      if (Test-Path -LiteralPath 'src') {throw 'Do not overwrite extracted source'}
      & tar.exe -xzf source.tar.gz -C $project
      if ($LASTEXITCODE -ne 0) {throw 'Frozen source extraction failed'}
      Copy-Item -LiteralPath 'compiled-source-receipt.json' -Destination 'out\compiled-source-receipt.json'
      $r.sourceBefore=Verify-Source
    }
    Step 'isolated-dependencies-and-reused-payload-input' {
      if ((Get-FileHash -LiteralPath 'package-lock.json').Hash -ne (Get-FileHash -LiteralPath ($reuse+'\package-lock.json')).Hash) {throw 'Donor dependency lock differs'}
      if (Test-Path -LiteralPath 'node_modules') {throw 'Dependency target already exists'}
      robocopy ($reuse+'\node_modules') ($project+'\node_modules') /E /COPY:DAT /DCOPY:DAT /R:1 /W:1 /NFL /NDL /NJH /NJS /NP
      if ($LASTEXITCODE -gt 7) {throw 'Isolated dependency copy failed'}
      New-Item -ItemType Directory -Path 'out\native','out\core-packages'|Out-Null
      Copy-Item -LiteralPath ($reuse+'\out\native\win32-x64') -Destination 'out\native\win32-x64' -Recurse
      $archive='codex-package-x86_64-pc-windows-msvc.tar.gz'
      $donorArchive=Join-Path $reuse ('out\core-packages\'+$archive)
      if ((Get-FileHash -LiteralPath $donorArchive).Hash -ine 'a6ef3442cb12766a88b39311d79244289e4f9763e2c53ff4fbebc2cb653cc5f3') {throw 'Donor Core archive mismatch'}
      # Read-only build input hardlink, not another 136MB archive or Core home.
      # Existing afterPack validates it and copies only into the new package.
      New-Item -ItemType HardLink -Path (Join-Path $project ('out\core-packages\'+$archive)) -Target $donorArchive|Out-Null
      $r.donor=$reuse;$r.coreInputReuse='NTFS hardlink; no Core extraction'
      $r.dependencyLockSha256=(Get-FileHash -LiteralPath 'package-lock.json').Hash.ToLowerInvariant()
    }
    Step 'typecheck' {
      & $node node_modules/typescript/bin/tsc --noEmit
      if ($LASTEXITCODE -ne 0) {throw 'Typecheck failed'}
    }
    Step 'x64-nsis-and-unpacked' {
      if (Test-Path -LiteralPath $package) {throw 'Refuse existing package output'}
      & 'C:\Program Files\nodejs\npm.cmd' run package:win -- --x64 --config.directories.output=out/production-qa-windows-ac17c1c --publish never
      if ($LASTEXITCODE -ne 0) {throw 'Windows package build failed'}
      $r.executable=Join-Path $project ($package+'\win-unpacked\Synora Harness Desktop.exe')
      $resources=Join-Path $project ($package+'\win-unpacked\resources')
      $r.executableSha256=(Get-FileHash -LiteralPath $r.executable).Hash.ToLowerInvariant()
      $r.asarSha256=(Get-FileHash -LiteralPath ($resources+'\app.asar')).Hash.ToLowerInvariant()
      $installer=Join-Path $project ($package+'\Synora Harness Desktop Setup 0.1.0-foundation.2.exe')
      $r.installer=@{path=$installer;bytes=(Get-Item -LiteralPath $installer).Length;sha256=(Get-FileHash -LiteralPath $installer).Hash.ToLowerInvariant();signing=(Get-AuthenticodeSignature -LiteralPath $installer).Status.ToString()}
      $r.executableSigning=(Get-AuthenticodeSignature -LiteralPath $r.executable).Status.ToString()
      $lock=Get-Content -LiteralPath 'docs\core-runtime-lock.json' -Raw|ConvertFrom-Json
      $core=$lock.targets.'win32-x64'
      $r.packagedCore=@{version=$lock.version;bytes=(Get-Item -LiteralPath ($resources+'\core-packages\'+$core.file)).Length;sha256=(Get-FileHash -LiteralPath ($resources+'\core-packages\'+$core.file)).Hash.ToLowerInvariant()}
      if ($r.packagedCore.sha256 -ne $core.sha256 -or $r.packagedCore.bytes -ne $core.size -or (Get-FileHash -LiteralPath (Join-Path $reuse ('out\core-packages\'+$core.file))).Hash -ine $core.sha256) {throw 'Original Core input/package mismatch'}
    }
    Step 'post-build-source' {$r.sourceAfter=Verify-Source}
  } else {
    if ($session -ne 1 -or $elevated) {throw 'Native cases require existing Limited Session1'}
    Add-Type -TypeDefinition @'
using System;using System.Text;using System.Runtime.InteropServices;
public static class Ac17QaStation {
 [DllImport("user32.dll")]static extern IntPtr GetProcessWindowStation();
 [DllImport("user32.dll",SetLastError=true,CharSet=CharSet.Unicode)]static extern bool GetUserObjectInformationW(IntPtr h,int n,StringBuilder b,uint len,out uint need);
 public static string Name(){var b=new StringBuilder(512);uint n;if(!GetUserObjectInformationW(GetProcessWindowStation(),2,b,1024,out n))throw new Exception("Cannot read station");return b.ToString();}
}
'@
    if ([Ac17QaStation]::Name() -ine 'WinSta0') {throw 'Interactive station required'}
    $r.station='WinSta0'
    $build=Get-Content -LiteralPath 'out\live-evidence\ac17c1c-windows-build.json' -Raw|ConvertFrom-Json
    if (-not $build.passed -or $build.source -ne $source) {throw 'Exact build not complete'}
    $env:SYNORA_TEST_EXECUTABLE=$build.executable
    $asar=Join-Path (Split-Path $build.executable) 'resources\app.asar'
    if ((Get-FileHash -LiteralPath $asar).Hash -ine $build.asarSha256 -or (Get-FileHash -LiteralPath $build.executable).Hash -ine $build.executableSha256) {throw 'New package changed'}
    foreach ($name in @('SYNORA_TEST_ENDPOINT','SYNORA_CODEX_BINARY','SYNORA_TEST_PREPARED_WINDOWS_QA','SYNORA_CORE_CACHE','SYNORA_DATA_DIR','SYNORA_AUTHORIZE_WINDOWS_SETUP','SYNORA_QA_RESET_AFTER_SUCCESS','SYNORA_TEST_SEARCH_URL')) {Remove-Item ('Env:'+ $name) -ErrorAction SilentlyContinue}
    $r.cases=@()
    $cases=@(
      @{name='base';config='playwright.config.ts';report='test-results/desktop.json';count=2},
      @{name='quality';config='playwright.quality-desktop.config.ts';report='test-results/ui-quality-desktop.json';count=1},
      @{name='updater';config='playwright.core-update-desktop.config.ts';report='test-results/core-update-native.json';count=1},
      @{name='bearer';config='playwright.provider-native.config.ts';report='test-results/provider-native.json';count=1}
    )
    foreach ($case in $cases) {
      if (Test-Path -LiteralPath $case.report) {throw 'Previous report exists; never overwrite'}
      $r.currentStep=$case.name;Save-Receipt
      $env:PLAYWRIGHT_JSON_OUTPUT_FILE=Join-Path $project $case.report
      $started=[DateTime]::UtcNow
      & cmd.exe /d /c ('node node_modules/@playwright/test/cli.js test --workers=1 --retries=0 --config '+$case.config+' > out/live-evidence/ac17c1c-'+$case.name+'.stdout.log 2> out/live-evidence/ac17c1c-'+$case.name+'.stderr.log')
      $status=$LASTEXITCODE
      $entry=[ordered]@{name=$case.name;exitCode=$status;started=$started.ToString('o');finished=[DateTime]::UtcNow.ToString('o');passed=$false}
      if (Test-Path -LiteralPath $case.report) {
        if ((Get-Item -LiteralPath $case.report).LastWriteTimeUtc -lt $started) {throw 'Stale report rejected'}
        $report=Get-Content -LiteralPath $case.report -Raw|ConvertFrom-Json
        $entry.reportSha256=(Get-FileHash -LiteralPath $case.report).Hash.ToLowerInvariant();$entry.stats=$report.stats
        $entry.passed=($status -eq 0 -and $report.stats.expected -eq $case.count -and $report.stats.unexpected -eq 0 -and $report.stats.skipped -eq 0 -and $report.stats.flaky -eq 0 -and $report.config.metadata.asar_sha256 -eq $build.asarSha256 -and $report.config.metadata.executable -eq $build.executable)
      }
      $r.cases+=@($entry);Save-Receipt
      if (-not $entry.passed) {throw ('Failed '+$case.name+'; retain original evidence, no automatic retry')}
    }
    $raw=& $node tests/fixtures/package-receipt.mjs out/production-qa-windows-ac17c1c --label=independent-five test-results/desktop.json test-results/ui-quality-desktop.json test-results/core-update-native.json test-results/provider-native.json
    if ($LASTEXITCODE -ne 0) {throw 'Source/dist/ASAR/package collector failed'}
    $r.collector=($raw-join '')|ConvertFrom-Json
    if ($r.collector.source -ne $source -or $r.collector.tests -ne 5 -or $r.collector.asar -ne $build.asarSha256) {throw 'Unexpected collector identity'}
  }
  $r.passed=$true;$exitCode=0
} catch {$r.error=$_.Exception.Message} finally {$r.finished=[DateTime]::UtcNow.ToString('o');$r.exitCode=$exitCode;Save-Receipt}
exit $exitCode
