# Finite non-inference package gate. No model endpoint, OS setup or installation.
param([ValidateSet('base','quality','updater','bearer')][string]$StartAt='base')
$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
$project=(Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
if ($project -ne 'C:\Synora_QA_final_20260909_6fe71e6f74ff' -or $env:COMPUTERNAME -ne 'AXIOM-WIN-BUILD') {throw 'Unexpected owned QA root'}
Set-Location $project
$node='C:\Program Files\nodejs\node.exe'
$env:Path='C:\Program Files\nodejs;'+$env:Path
$session=[Diagnostics.Process]::GetCurrentProcess().SessionId
$elevated=([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if ($session -ne 1 -or $elevated) {throw 'Requires existing limited Session1'}
Add-Type -TypeDefinition @'
using System; using System.Text; using System.Runtime.InteropServices;
public static class WindowsFinalNativeStation {
  [DllImport("user32.dll")] static extern IntPtr GetProcessWindowStation();
  [DllImport("user32.dll",SetLastError=true,CharSet=CharSet.Unicode)] static extern bool GetUserObjectInformationW(IntPtr h,int n,StringBuilder b,uint len,out uint need);
  public static string Name(){var b=new StringBuilder(512);uint n;if(!GetUserObjectInformationW(GetProcessWindowStation(),2,b,1024,out n))throw new Exception("Cannot read station");return b.ToString();}
}
'@
if ([WindowsFinalNativeStation]::Name() -ine 'WinSta0') {throw 'Requires interactive WinSta0'}
$buildReceipt='out\live-evidence\windows-final-build.json'
if (Test-Path -LiteralPath 'out\live-evidence\windows-final-build-resume.json') {$buildReceipt='out\live-evidence\windows-final-build-resume.json'}
$build=Get-Content -LiteralPath $buildReceipt -Raw | ConvertFrom-Json
if (-not $build.passed -or $build.source -ne 'c858d96739122c854083d288f26acc94064c16d7') {throw 'Frozen candidate build is not complete'}
$env:SYNORA_TEST_EXECUTABLE=Join-Path $project 'out\production-qa-windows-c858d967\win-unpacked\Synora Harness Desktop.exe'
$asar=Join-Path (Split-Path $env:SYNORA_TEST_EXECUTABLE) 'resources\app.asar'
if ((Get-FileHash -LiteralPath $asar).Hash -ine $build.asarSha256) {throw 'Candidate ASAR mismatch'}
if ((Get-FileHash -LiteralPath $env:SYNORA_TEST_EXECUTABLE).Hash -ine $build.executableSha256) {throw 'Candidate executable mismatch'}
Remove-Item Env:SYNORA_TEST_ENDPOINT -ErrorAction SilentlyContinue
Remove-Item Env:SYNORA_CODEX_BINARY -ErrorAction SilentlyContinue
Remove-Item Env:SYNORA_TEST_PREPARED_WINDOWS_QA -ErrorAction SilentlyContinue
$cases=@(
  @{name='base';config='playwright.config.ts';report='test-results/desktop.json';count=2},
  @{name='quality';config='playwright.quality-desktop.config.ts';report='test-results/ui-quality-desktop.json';count=1},
  @{name='updater';config='playwright.core-update-desktop.config.ts';report='test-results/core-update-native.json';count=1},
  @{name='bearer';config='playwright.provider-native.config.ts';report='test-results/provider-native.json';count=1}
)
$id=[Guid]::NewGuid().ToString('N')
$output=Join-Path $project ('out\live-evidence\windows-final-independent-'+$id)
New-Item -ItemType Directory -Path $output | Out-Null
$r=[ordered]@{started=[DateTime]::UtcNow.ToString('o');source=$build.source;executable=$env:SYNORA_TEST_EXECUTABLE;asarSha256=$build.asarSha256;sessionId=$session;station='WinSta0';elevated=$elevated;startAt=$StartAt;cases=@();passed=$false;inferenceRequests=0}
$exitCode=1
try {
  $active=$false
  foreach ($case in $cases) {
    if ($case.name -eq $StartAt) {$active=$true}
    if (-not $active) {continue}
    if (Test-Path -LiteralPath $case.report) {
      Copy-Item -LiteralPath $case.report -Destination (Join-Path $output ('prior-'+$case.name+'.json'))
    }
    $env:PLAYWRIGHT_JSON_OUTPUT_FILE=Join-Path $project $case.report
    $started=[DateTime]::UtcNow
    # Outer cmd captures native stdout/stderr without PowerShell turning a
    # Node warning into a terminating NativeCommandError.
    $command='node node_modules/@playwright/test/cli.js test --config '+$case.config+' > '+(Join-Path $output ($case.name+'.stdout.log'))+' 2> '+(Join-Path $output ($case.name+'.stderr.log'))
    & cmd.exe /d /c $command
    $status=$LASTEXITCODE
    $entry=[ordered]@{name=$case.name;config=$case.config;exitCode=$status;started=$started.ToString('o');finished=[DateTime]::UtcNow.ToString('o');report=$case.report}
    if (Test-Path -LiteralPath $case.report) {
      $info=Get-Item -LiteralPath $case.report
      if ($info.LastWriteTimeUtc -lt $started) {throw 'Stale report cannot qualify this run'}
      $report=Get-Content -LiteralPath $case.report -Raw | ConvertFrom-Json
      Copy-Item -LiteralPath $case.report -Destination (Join-Path $output ($case.name+'.json'))
      $entry.reportSha256=(Get-FileHash -LiteralPath $case.report).Hash.ToLowerInvariant()
      $entry.stats=$report.stats
      $entry.packageMatches=($report.config.metadata.asar_sha256 -eq $build.asarSha256 -and $report.config.metadata.executable -eq $env:SYNORA_TEST_EXECUTABLE)
      $entry.allPassed=($status -eq 0 -and $entry.packageMatches -and $report.stats.expected -eq $case.count -and $report.stats.unexpected -eq 0 -and $report.stats.skipped -eq 0 -and $report.stats.flaky -eq 0)
    } else {$entry.allPassed=$false}
    $r.cases+=@($entry)
    [IO.File]::WriteAllText((Join-Path $output 'receipt.json'),($r | ConvertTo-Json -Depth 8),[Text.UTF8Encoding]::new($false))
    if (-not $entry.allPassed) {throw ('Failed native gate: '+$case.name+'; original report retained')}
    if ((Get-FileHash -LiteralPath $asar).Hash -ine $build.asarSha256) {throw 'Candidate changed during native checks'}
  }
  $r.passed=$true;$exitCode=0
} catch {$r.error=$_.Exception.Message} finally {
  $r.finished=[DateTime]::UtcNow.ToString('o');$r.exitCode=$exitCode
  [IO.File]::WriteAllText((Join-Path $output 'receipt.json'),($r | ConvertTo-Json -Depth 8),[Text.UTF8Encoding]::new($false))
  Write-Output ('EVIDENCE='+$output)
}
exit $exitCode
