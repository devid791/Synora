# Candidate-specific actual Axiom QA; existing Limited Session1 and Core only.
# Main GPU GO is required separately. No provisioning, install or OS controls.
param([switch]$Image)
$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
$project=(Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
if ($project -ne 'C:\Synora_QA_6abb5b9_20260910_2e1a753a1d8a' -or $env:COMPUTERNAME -ne 'AXIOM-WIN-BUILD') {throw 'Unexpected owned QA root'}
Set-Location $project
$session=[Diagnostics.Process]::GetCurrentProcess().SessionId
$elevated=([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if ($session -ne 1 -or $elevated) {throw 'Requires existing Limited Session1'}
Add-Type -TypeDefinition @'
using System; using System.Text; using System.Runtime.InteropServices;
public static class Candidate6abbLiveStation {
  [DllImport("user32.dll")] static extern IntPtr GetProcessWindowStation();
  [DllImport("user32.dll",SetLastError=true,CharSet=CharSet.Unicode)] static extern bool GetUserObjectInformationW(IntPtr h,int n,StringBuilder b,uint len,out uint need);
  public static string Name(){var b=new StringBuilder(512);uint n;if(!GetUserObjectInformationW(GetProcessWindowStation(),2,b,1024,out n))throw new Exception("Cannot read station");return b.ToString();}
}
'@
if ([Candidate6abbLiveStation]::Name() -ine 'WinSta0') {throw 'Requires interactive WinSta0'}
$qaHome='C:\Users\axiom-builder\AppData\Local\Temp\synora-live-native-Mb5PPy'
$exe=Join-Path $project 'out\production-qa-windows-6abb5b9\win-unpacked\Synora Harness Desktop.exe'
$asar=Join-Path (Split-Path $exe) 'resources\app.asar'
$pins=@(
  @($exe,'0178f51ced5f1923cc58b7876692317b220df7d81a6a2cd7587c54da0695727d'),
  @($asar,'cdd59de23a53c5fbab17ebe86925666c996ea18a82ee977f81c11a9f43c12c02'),
  @((Join-Path $qaHome 'state\core-runtime\0.153.4-x86_64-pc-windows-msvc-a6ef3442cb12766a\bin\codex.exe'),'444a3f0008050605cae73cd9b7a2dcac61294062dfaab56dd20430fd6498518b'),
  @((Join-Path $qaHome 'state\app-server\.windows-home.json'),'076351d7ede73b7d986135ab81ede4f5d849dd667d71b4ca4227ffd7653655b4'),
  @((Join-Path $qaHome 'state\app-server\native-axiom\.sandbox-secrets\sandbox_users.json'),'e4a62e26a2d84d09696946d8b65c3737529e48e0da7aa5e98cea3bfed25edb1f'),
  @((Join-Path $qaHome 'state\app-server\native-axiom\.sandbox\setup_marker.json'),'a9293d6c496acef647603f309ad9cb4381f8a8def437f1444f0102a03c7a4d02')
)
function Assert-Pins {
  foreach ($pin in $pins) {
    $item=Get-Item -LiteralPath $pin[0] -Force
    if ($item.PSIsContainer -or $item.FullName -ine $pin[0]) {throw 'Noncanonical artifact'}
    for ($ancestor=$item; $null -ne $ancestor; $ancestor=$ancestor.Parent) {
      if (($ancestor.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {throw 'Redirected artifact rejected'}
      if ($ancestor -is [IO.FileInfo]) {$ancestor=$ancestor.Directory; if (($ancestor.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {throw 'Redirected parent rejected'}}
    }
    if ((Get-FileHash -LiteralPath $pin[0]).Hash -ine $pin[1]) {throw 'Candidate/prepared Core pin mismatch'}
  }
}
function Read-Idle {
  $status=Invoke-RestMethod -Uri 'http://10.23.45.10:8015/ops/runtime' -TimeoutSec 10
  foreach ($field in @('loaded','generation_busy','active_request_sequence','active_session_id','session_leases_active')) {
    if ($status.PSObject.Properties.Name -notcontains $field) {throw 'Incomplete runtime idle observation'}
  }
  if ($status.loaded -ne $true -or $status.generation_busy -ne $false -or $null -ne $status.active_request_sequence -or $null -ne $status.active_session_id -or $status.session_leases_active -ne 0) {throw 'GPU is not idle; no model launch'}
  return [ordered]@{at=[DateTime]::UtcNow.ToString('o');loaded=$status.loaded;generation_busy=$status.generation_busy;active_request_sequence=$status.active_request_sequence;active_session_id=$status.active_session_id;session_leases_active=$status.session_leases_active}
}
$output=Join-Path $project $(if ($Image) {'out\live-evidence\6abb5b9-windows-actual-image'} else {'out\live-evidence\6abb5b9-windows-actual-live-cancel'})
if (Test-Path -LiteralPath $output) {throw 'Attempt already exists; preserve it, no automatic retry'}
New-Item -ItemType Directory -Path $output|Out-Null
$r=[ordered]@{started=[DateTime]::UtcNow.ToString('o');source='6abb5b9339e51898846d86e3bf62fb43d6d65a7d';pid=$PID;sessionId=$session;station='WinSta0';elevated=$elevated;executable=$exe;executableSha256=$pins[0][1];asarSha256=$pins[1][1];preparedHome=$qaHome;cases=@();passed=$false}
function Save-Receipt {[IO.File]::WriteAllText((Join-Path $output 'receipt.json'),($r|ConvertTo-Json -Depth 12),[Text.UTF8Encoding]::new($false))}
$exitCode=1
Save-Receipt
try {
  Assert-Pins
  if (-not $Image) {
  $previous='C:\Synora_Production_QA_9cfc8ac\out\live-evidence\live-native.json'
  $previousHash=(Get-FileHash -LiteralPath $previous).Hash.ToLowerInvariant()
  if ($previousHash -ne '0da47f594c44017b0bf41950e5ba192bcb3987419dc7fc9cb2f8af63bba23e02') {throw 'Previous positive receipt changed'}
  $archive=Join-Path $output 'prior-positive-live-native.json'
  Copy-Item -LiteralPath $previous -Destination $archive
  if ((Get-FileHash -LiteralPath $archive).Hash -ine $previousHash) {throw 'Previous receipt archive mismatch'}
  $r.previousReceiptSha256=$previousHash
  }
  # The unchanged live fixture additionally checks dir/completed/restored/AFTER
  # before its single exact native-check.txt AFTER -> BEFORE write.
  $env:Path='C:\Program Files\nodejs;'+$env:Path
  foreach ($name in @('SYNORA_CODEX_BINARY','SYNORA_CORE_CACHE','SYNORA_DATA_DIR','SYNORA_AUTHORIZE_WINDOWS_SETUP','SYNORA_QA_NETWORK_PROOF')) {Remove-Item ('Env:'+ $name) -ErrorAction SilentlyContinue}
  $env:SYNORA_TEST_EXECUTABLE=$exe
  $env:SYNORA_TEST_ENDPOINT='http://10.23.45.10:8015/codex/v1'
  $env:SYNORA_TEST_PREPARED_WINDOWS_QA=$qaHome
  if (-not $Image) {$env:SYNORA_QA_PREVIOUS_LIVE_RECEIPT=$archive}
  $cases=if ($Image) {
    @(@{name='image';config='playwright.images-desktop.config.ts';report='test-results/images-desktop.json';detail='out/live-evidence/image-native-actual.json'})
  } else {@(
    @{name='live';config='playwright.live-desktop.config.ts';report='test-results/live-desktop.json';detail='out/live-evidence/live-native.json'},
    @{name='cancel';config='playwright.cancel-windows.config.ts';report='test-results/cancel-windows.json';detail='out/live-evidence/cancel-native-win32.json'}
  )}
  foreach ($case in $cases) {
    foreach ($path in @($case.report,$case.detail)) {if (Test-Path -LiteralPath $path) {throw ('Existing current report must not be overwritten: '+$path)}}
    $r.currentCase=$case.name;$r.idleBefore=Read-Idle;Save-Receipt
    $env:SYNORA_QA_RESET_AFTER_SUCCESS=if ($case.name -eq 'live') {'1'} else {'0'}
    $env:PLAYWRIGHT_JSON_OUTPUT_FILE=Join-Path $project $case.report
    $started=[DateTime]::UtcNow
    $command='node node_modules/@playwright/test/cli.js test --workers=1 --retries=0 --config '+$case.config+' > '+(Join-Path $output ($case.name+'.stdout.log'))+' 2> '+(Join-Path $output ($case.name+'.stderr.log'))
    & cmd.exe /d /c $command
    $status=$LASTEXITCODE
    $entry=[ordered]@{name=$case.name;config=$case.config;exitCode=$status;started=$started.ToString('o');finished=[DateTime]::UtcNow.ToString('o');passed=$false}
    if (Test-Path -LiteralPath $case.report) {
      if ((Get-Item -LiteralPath $case.report).LastWriteTimeUtc -lt $started) {throw 'Stale report rejected'}
      $report=Get-Content -LiteralPath $case.report -Raw|ConvertFrom-Json
      Copy-Item -LiteralPath $case.report -Destination (Join-Path $output ($case.name+'.json'))
      $entry.reportSha256=(Get-FileHash -LiteralPath $case.report).Hash.ToLowerInvariant();$entry.stats=$report.stats
      $entry.passed=($status -eq 0 -and $report.stats.expected -eq 1 -and $report.stats.unexpected -eq 0 -and $report.stats.skipped -eq 0 -and $report.stats.flaky -eq 0 -and $report.config.metadata.asar_sha256 -eq $pins[1][1] -and $report.config.metadata.executable -eq $exe)
    }
    if (Test-Path -LiteralPath $case.detail) {Copy-Item -LiteralPath $case.detail -Destination (Join-Path $output ($case.name+'-detail.json'));$entry.detailSha256=(Get-FileHash -LiteralPath $case.detail).Hash.ToLowerInvariant()}
    $r.cases+=@($entry);Save-Receipt
    if (-not $entry.passed) {throw ('Failed '+$case.name+'; retain original errors and stop')}
    Assert-Pins
  }
  $r.idleAfter=Read-Idle;$r.passed=$true;$exitCode=0
} catch {$r.error=$_.Exception.Message} finally {
  $r.finished=[DateTime]::UtcNow.ToString('o');$r.exitCode=$exitCode;Save-Receipt
  Write-Output ('EVIDENCE='+$output)
}
exit $exitCode
