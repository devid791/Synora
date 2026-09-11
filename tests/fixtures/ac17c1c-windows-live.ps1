# QA overlay only: four existing actual cases, no setup/install/OS controls.
# Invoke ONLY after main's exclusive GPU handoff, from existing Limited Session1.
param([switch]$MainGpuGo)
$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
if (-not $MainGpuGo) {throw 'Explicit main GPU handoff required; preparation does not authorize execution'}
$project=(Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
if ($project -ne 'C:\Synora_QA_ac17c1c_20260910_c05c8a76b463' -or $env:COMPUTERNAME -ne 'AXIOM-WIN-BUILD') {throw 'Unexpected owned QA root'}
Set-Location $project
$session=[Diagnostics.Process]::GetCurrentProcess().SessionId
$elevated=([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if ($session -ne 1 -or $elevated) {throw 'Requires existing Limited Session1'}
Add-Type -TypeDefinition @'
using System; using System.Text; using System.Runtime.InteropServices;
public static class CandidateAc17LiveStation {
  [DllImport("user32.dll")] static extern IntPtr GetProcessWindowStation();
  [DllImport("user32.dll",SetLastError=true,CharSet=CharSet.Unicode)] static extern bool GetUserObjectInformationW(IntPtr h,int n,StringBuilder b,uint len,out uint need);
  public static string Name(){var b=new StringBuilder(512);uint n;if(!GetUserObjectInformationW(GetProcessWindowStation(),2,b,1024,out n))throw new Exception("Cannot read station");return b.ToString();}
}
'@
if ([CandidateAc17LiveStation]::Name() -ine 'WinSta0') {throw 'Requires interactive WinSta0'}
$qaHome='C:\Users\axiom-builder\AppData\Local\Temp\synora-live-native-Mb5PPy'
$exe=Join-Path $project 'out\production-qa-windows-ac17c1c\win-unpacked\Synora Harness Desktop.exe'
$asar=Join-Path (Split-Path $exe) 'resources\app.asar'
$node='C:\Program Files\nodejs\node.exe'
$pins=@(
  @($exe,'2875aac8009caf890f44f02253930923f730a2dabd76cac95ce6b685f816b32f'),
  @($asar,'74ff72a6bb0a5edb52a3bfad93645190ea437ff70761b4922f22bdb693afb19f'),
  @((Join-Path $qaHome 'state\core-runtime\0.153.4-x86_64-pc-windows-msvc-a6ef3442cb12766a\bin\codex.exe'),'444a3f0008050605cae73cd9b7a2dcac61294062dfaab56dd20430fd6498518b'),
  @((Join-Path $qaHome 'state\app-server\.windows-home.json'),'076351d7ede73b7d986135ab81ede4f5d849dd667d71b4ca4227ffd7653655b4'),
  @((Join-Path $qaHome 'state\app-server\native-axiom\.sandbox-secrets\sandbox_users.json'),'e4a62e26a2d84d09696946d8b65c3737529e48e0da7aa5e98cea3bfed25edb1f'),
  @((Join-Path $qaHome 'state\app-server\native-axiom\.sandbox\setup_marker.json'),'a9293d6c496acef647603f309ad9cb4381f8a8def437f1444f0102a03c7a4d02'),
  @((Join-Path $project 'out\compiled-source-receipt.json'),'974e9a897c60bea75debc5e0c50186af13af1b7f18a8292f9c8534ebe310c092'),
  @((Join-Path $project 'tests\images.desktop.spec.ts'),'a08088d76325a9573721c4bbe2acf3f51edfdb3ca1ef6a6f2b1fc39d6d0275d6')
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
function Read-Owners {
  @(Get-CimInstance Win32_Process | Where-Object {$_.ProcessId -ne $PID -and ($_.Name -in @('node.exe','Synora Harness Desktop.exe','codex.exe','synora-web.exe') -or ($_.ExecutablePath -and $_.ExecutablePath.StartsWith($qaHome,[StringComparison]::OrdinalIgnoreCase)))} | Select-Object ProcessId,ParentProcessId,SessionId,Name)
}
function Read-Idle {
  $status=Invoke-RestMethod -Uri 'http://10.23.45.10:8015/ops/runtime' -TimeoutSec 5
  foreach ($field in @('loaded','generation_busy','active_request_sequence','active_session_id','session_leases_active')) {
    if ($status.PSObject.Properties.Name -notcontains $field) {throw 'Incomplete runtime idle observation'}
  }
  return [ordered]@{at=[DateTime]::UtcNow.ToString('o');loaded=$status.loaded;generation_busy=$status.generation_busy;active_request_sequence=$status.active_request_sequence;active_session_id=$status.active_session_id;session_leases_active=$status.session_leases_active}
}
function Is-Idle($status) {
  return ($status.loaded -eq $true -and $status.generation_busy -eq $false -and $null -eq $status.active_request_sequence -and $null -eq $status.active_session_id -and $status.session_leases_active -eq 0)
}
function Assert-Source {
  $raw=& $node scripts/source-receipt.mjs verify out/compiled-source-receipt.json
  if ($LASTEXITCODE -ne 0) {throw 'Frozen source mismatch'}
  $source=$raw|ConvertFrom-Json
  if ($source.commit -ne 'ac17c1c3183b88a5721778f751a3410010f56259' -or $source.files -ne 1186 -or @($source.mismatches).Count -ne 0) {throw 'Unexpected frozen source receipt'}
  return $source
}
$output=Join-Path $project 'out\live-evidence\ac17c1c-windows-actual-four'
if (Test-Path -LiteralPath $output) {throw 'Attempt already exists; preserve it, no automatic retry'}
Assert-Pins
if (@(Read-Owners).Count) {throw 'Existing app/Core/node owner; no launch'}
$initialIdle=Read-Idle
if (-not (Is-Idle $initialIdle)) {throw 'GPU is not idle; no launch'}
New-Item -ItemType Directory -Path $output|Out-Null
$r=[ordered]@{started=[DateTime]::UtcNow.ToString('o');source='ac17c1c3183b88a5721778f751a3410010f56259';pid=$PID;sessionId=$session;station='WinSta0';elevated=$elevated;executable=$exe;executableSha256=$pins[0][1];asarSha256=$pins[1][1];preparedHome=$qaHome;idleBefore=$initialIdle;cases=@();cleanupObservations=@();passed=$false}
$r.qaOverlay=@{helperSha256=(Get-FileHash -LiteralPath $PSCommandPath).Hash.ToLowerInvariant();imagesSha256=$pins[7][1]}
function Save-Receipt {[IO.File]::WriteAllText((Join-Path $output 'receipt.json'),($r|ConvertTo-Json -Depth 12),[Text.UTF8Encoding]::new($false))}
function Observe-Cleanup {
  $deadline=[DateTime]::UtcNow.AddSeconds(30)
  do {
    $observation=[ordered]@{at=[DateTime]::UtcNow.ToString('o');owners=@(Read-Owners);idle=Read-Idle}
    $r.cleanupObservations+=@($observation);Save-Receipt
    if ($observation.owners.Count -eq 0 -and (Is-Idle $observation.idle)) {return}
    Start-Sleep -Milliseconds 1000
  } while ([DateTime]::UtcNow -lt $deadline)
  throw 'Cleanup not idle/owner-free within observation bound; no kill or rerun'
}
$exitCode=1
Save-Receipt
try {
  $r.sourceBefore=Assert-Source
  $previous='C:\Synora_QA_6abb5b9_20260910_2e1a753a1d8a\out\live-evidence\live-native.json'
  $previousHash='27172975acf307279ed53823e1a4f7ede48dc78bfe7614d8a50e5921e3f4af3f'
  if ((Get-FileHash -LiteralPath $previous).Hash -ine $previousHash) {throw 'Previous positive receipt changed'}
  $archive=Join-Path $output 'prior-positive-live-native.json'
  Copy-Item -LiteralPath $previous -Destination $archive
  if ((Get-FileHash -LiteralPath $archive).Hash -ine $previousHash) {throw 'Previous receipt archive mismatch'}
  $r.previousReceiptSha256=$previousHash
  # The original live fixture validates exact dir/completed/restored/AFTER
  # before its sole native-check.txt AFTER -> BEFORE reset. History stays intact.
  $env:Path='C:\Program Files\nodejs;'+$env:Path
  foreach ($name in @('SYNORA_CODEX_BINARY','SYNORA_CORE_CACHE','SYNORA_DATA_DIR','SYNORA_AUTHORIZE_WINDOWS_SETUP','SYNORA_QA_NETWORK_PROOF','SYNORA_QA_RESET_AFTER_SUCCESS','SYNORA_QA_PREVIOUS_LIVE_RECEIPT','SYNORA_TEST_SEARCH_URL')) {Remove-Item ('Env:'+ $name) -ErrorAction SilentlyContinue}
  $env:SYNORA_TEST_EXECUTABLE=$exe
  $env:SYNORA_TEST_ENDPOINT='http://10.23.45.10:8015/codex/v1'
  $env:SYNORA_TEST_PREPARED_WINDOWS_QA=$qaHome
  $env:SYNORA_QA_PREVIOUS_LIVE_RECEIPT=$archive
  $cases=@(
    @{name='live';config='playwright.live-desktop.config.ts';report='test-results/live-desktop.json';detail='out/live-evidence/live-native.json';directory='test-results/live-desktop';failure='out/live-evidence/live-native-failure.json'},
    @{name='cancel';config='playwright.cancel-windows.config.ts';report='test-results/cancel-windows.json';detail='out/live-evidence/cancel-native-win32.json';directory='test-results/cancel-windows';failure='out/live-evidence/cancel-native-win32-failure.json'},
    @{name='image';config='playwright.images-desktop.config.ts';report='test-results/images-desktop.json';detail='out/live-evidence/image-native-actual.json';directory='test-results/images-desktop';failure='out/live-evidence/image-native-failure.json'},
    @{name='web';config='playwright.live-mcp-desktop.config.ts';report='test-results/live-mcp-native.json';detail='out/live-evidence/web-mcp-native.json';directory='test-results/live-mcp-native';failure='out/live-evidence/web-mcp-native-failure.json'}
  )
  foreach ($case in $cases) {foreach ($path in @($case.report,$case.detail,$case.directory,$case.failure)) {if (Test-Path -LiteralPath $path) {throw ('Existing evidence must not be overwritten: '+$path)}}}
  foreach ($case in $cases) {
    Assert-Pins
    if (@(Read-Owners).Count) {throw 'Existing owner before next case'}
    $r.currentCase=$case.name;$r.idleBeforeCase=Read-Idle
    if (-not (Is-Idle $r.idleBeforeCase)) {throw 'GPU not idle before next case'}
    Save-Receipt
    $env:SYNORA_QA_RESET_AFTER_SUCCESS=if ($case.name -eq 'live') {'1'} else {'0'}
    if ($case.name -eq 'web') {$env:SYNORA_TEST_SEARCH_URL='http://10.23.46.16:8888'}
    $env:PLAYWRIGHT_JSON_OUTPUT_FILE=Join-Path $project $case.report
    $started=[DateTime]::UtcNow
    $command='node node_modules/@playwright/test/cli.js test --workers=1 --retries=0 --global-timeout=210000 --config '+$case.config+' > '+(Join-Path $output ($case.name+'.stdout.log'))+' 2> '+(Join-Path $output ($case.name+'.stderr.log'))
    & cmd.exe /d /c $command
    $status=$LASTEXITCODE
    $r.lastProcessExitCode=$status;$r.lastProcessFinished=[DateTime]::UtcNow.ToString('o');Save-Receipt
    $entry=[ordered]@{name=$case.name;config=$case.config;exitCode=$status;started=$started.ToString('o');finished=[DateTime]::UtcNow.ToString('o');passed=$false}
    if (Test-Path -LiteralPath $case.report) {
      $report=Get-Content -LiteralPath $case.report -Raw|ConvertFrom-Json
      Copy-Item -LiteralPath $case.report -Destination (Join-Path $output ($case.name+'.json'))
      $entry.reportSha256=(Get-FileHash -LiteralPath $case.report).Hash.ToLowerInvariant();$entry.stats=$report.stats
      $entry.passed=($status -eq 0 -and (Get-Item -LiteralPath $case.report).LastWriteTimeUtc -ge $started -and $report.stats.expected -eq 1 -and $report.stats.unexpected -eq 0 -and $report.stats.skipped -eq 0 -and $report.stats.flaky -eq 0 -and $report.config.metadata.asar_sha256 -eq $pins[1][1] -and $report.config.metadata.executable -eq $exe)
    }
    foreach ($kind in @('detail','failure')) {
      if (Test-Path -LiteralPath $case[$kind]) {Copy-Item -LiteralPath $case[$kind] -Destination (Join-Path $output ($case.name+'-'+$kind+'.json'));$entry[$kind+'Sha256']=(Get-FileHash -LiteralPath $case[$kind]).Hash.ToLowerInvariant()}
    }
    $r.cases+=@($entry);Save-Receipt
    if (-not $entry.passed) {throw ('Failed '+$case.name+'; retain original errors and stop')}
    Observe-Cleanup
  }
  $r.passed=$true;$exitCode=0
} catch {$r.error=$_.Exception.Message} finally {
  try {Observe-Cleanup;Assert-Pins;$r.sourceAfter=Assert-Source;$r.cleanupPassed=$true} catch {$r.cleanupPassed=$false;$r.cleanupError=$_.Exception.Message;$r.passed=$false;$exitCode=1}
  $r.finished=[DateTime]::UtcNow.ToString('o');$r.exitCode=$exitCode;Save-Receipt
  Write-Output ('EVIDENCE='+$output)
}
exit $exitCode
