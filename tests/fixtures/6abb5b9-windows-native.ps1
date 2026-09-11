# Exactly five new-artifact, non-inference cases in existing Limited Session1.
$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
$project=(Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
if ($project -ne 'C:\Synora_QA_6abb5b9_20260910_2e1a753a1d8a' -or $env:COMPUTERNAME -ne 'AXIOM-WIN-BUILD') {throw 'Unexpected owned QA root'}
Set-Location $project
$node='C:\Program Files\nodejs\node.exe'
$env:Path='C:\Program Files\nodejs;'+$env:Path
$session=[Diagnostics.Process]::GetCurrentProcess().SessionId
$elevated=([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if ($session -ne 1 -or $elevated) {throw 'Requires existing Limited Session1'}
Add-Type -TypeDefinition @'
using System; using System.Text; using System.Runtime.InteropServices;
public static class Candidate6abbWindowsStation {
  [DllImport("user32.dll")] static extern IntPtr GetProcessWindowStation();
  [DllImport("user32.dll",SetLastError=true,CharSet=CharSet.Unicode)] static extern bool GetUserObjectInformationW(IntPtr h,int n,StringBuilder b,uint len,out uint need);
  public static string Name(){var b=new StringBuilder(512);uint n;if(!GetUserObjectInformationW(GetProcessWindowStation(),2,b,1024,out n))throw new Exception("Cannot read station");return b.ToString();}
}
'@
if ([Candidate6abbWindowsStation]::Name() -ine 'WinSta0') {throw 'Requires interactive WinSta0'}
$build=Get-Content -LiteralPath 'out\live-evidence\6abb5b9-windows-build.json' -Raw|ConvertFrom-Json
if (-not $build.passed -or $build.source -ne '6abb5b9339e51898846d86e3bf62fb43d6d65a7d') {throw 'Exact candidate build is not complete'}
$env:SYNORA_TEST_EXECUTABLE=Join-Path $project 'out\production-qa-windows-6abb5b9\win-unpacked\Synora Harness Desktop.exe'
$asar=Join-Path (Split-Path $env:SYNORA_TEST_EXECUTABLE) 'resources\app.asar'
if ((Get-FileHash -LiteralPath $asar).Hash -ine $build.asarSha256 -or (Get-FileHash -LiteralPath $env:SYNORA_TEST_EXECUTABLE).Hash -ine $build.executableSha256) {throw 'New artifact identity mismatch'}
# Process-local removal only. Each unchanged case creates its own fresh QA data.
foreach ($name in @('SYNORA_TEST_ENDPOINT','SYNORA_CODEX_BINARY','SYNORA_TEST_PREPARED_WINDOWS_QA','SYNORA_CORE_CACHE','SYNORA_DATA_DIR')) {Remove-Item ('Env:'+ $name) -ErrorAction SilentlyContinue}
$cases=@(
  @{name='base';config='playwright.config.ts';report='test-results/desktop.json';count=2},
  @{name='quality';config='playwright.quality-desktop.config.ts';report='test-results/ui-quality-desktop.json';count=1},
  @{name='updater';config='playwright.core-update-desktop.config.ts';report='test-results/core-update-native.json';count=1},
  @{name='bearer';config='playwright.provider-native.config.ts';report='test-results/provider-native.json';count=1}
)
$output=Join-Path $project 'out\live-evidence\6abb5b9-windows-independent-five'
if (Test-Path -LiteralPath $output) {throw 'Native attempt already exists; retain and inspect, never retry blindly'}
New-Item -ItemType Directory -Path $output|Out-Null
$r=[ordered]@{started=[DateTime]::UtcNow.ToString('o');source=$build.source;executable=$env:SYNORA_TEST_EXECUTABLE;executableSha256=$build.executableSha256;asarSha256=$build.asarSha256;pid=$PID;sessionId=$session;station='WinSta0';elevated=$elevated;cases=@();passed=$false;inferenceRequests=0;preparedHomeUsed=$false}
function Save-Receipt {[IO.File]::WriteAllText((Join-Path $output 'receipt.json'),($r|ConvertTo-Json -Depth 10),[Text.UTF8Encoding]::new($false))}
$exitCode=1
Save-Receipt
try {
  foreach ($case in $cases) {
    if (Test-Path -LiteralPath $case.report) {throw ('Unexpected previous report: '+$case.report)}
    $r.currentCase=$case.name;Save-Receipt
    $env:PLAYWRIGHT_JSON_OUTPUT_FILE=Join-Path $project $case.report
    $started=[DateTime]::UtcNow
    # Preserve raw native stderr without PowerShell treating warnings as errors.
    $command='node node_modules/@playwright/test/cli.js test --workers=1 --retries=0 --config '+$case.config+' > '+(Join-Path $output ($case.name+'.stdout.log'))+' 2> '+(Join-Path $output ($case.name+'.stderr.log'))
    & cmd.exe /d /c $command
    $status=$LASTEXITCODE
    $entry=[ordered]@{name=$case.name;config=$case.config;exitCode=$status;started=$started.ToString('o');finished=[DateTime]::UtcNow.ToString('o');report=$case.report;allPassed=$false}
    if (Test-Path -LiteralPath $case.report) {
      $info=Get-Item -LiteralPath $case.report
      if ($info.LastWriteTimeUtc -lt $started) {throw 'Stale report cannot qualify this invocation'}
      $report=Get-Content -LiteralPath $case.report -Raw|ConvertFrom-Json
      Copy-Item -LiteralPath $case.report -Destination (Join-Path $output ($case.name+'.json'))
      $entry.reportSha256=(Get-FileHash -LiteralPath $case.report).Hash.ToLowerInvariant()
      $entry.stats=$report.stats
      $entry.packageMatches=($report.config.metadata.asar_sha256 -eq $build.asarSha256 -and $report.config.metadata.executable -eq $env:SYNORA_TEST_EXECUTABLE)
      $entry.allPassed=($status -eq 0 -and $entry.packageMatches -and $report.stats.expected -eq $case.count -and $report.stats.unexpected -eq 0 -and $report.stats.skipped -eq 0 -and $report.stats.flaky -eq 0)
    }
    $r.cases+=@($entry);Save-Receipt
    if (-not $entry.allPassed) {throw ('Failed native gate: '+$case.name+'; original evidence retained')}
    if ((Get-FileHash -LiteralPath $asar).Hash -ine $build.asarSha256 -or (Get-FileHash -LiteralPath $env:SYNORA_TEST_EXECUTABLE).Hash -ine $build.executableSha256) {throw 'Candidate changed during native checks'}
  }
  $raw=& $node tests/fixtures/package-receipt.mjs out/production-qa-windows-6abb5b9 --label=independent-five test-results/desktop.json test-results/ui-quality-desktop.json test-results/core-update-native.json test-results/provider-native.json
  if ($LASTEXITCODE -ne 0) {throw 'Strict source/dist/ASAR/package collector failed'}
  $r.collector=($raw -join '')|ConvertFrom-Json
  if ($r.collector.source -ne $build.source -or $r.collector.tests -ne 5 -or $r.collector.asar -ne $build.asarSha256) {throw 'Unexpected collector result'}
  $r.passed=$true;$exitCode=0
} catch {$r.error=$_.Exception.Message} finally {
  $r.finished=[DateTime]::UtcNow.ToString('o');$r.exitCode=$exitCode;Save-Receipt
  Write-Output ('EVIDENCE='+$output)
}
exit $exitCode
