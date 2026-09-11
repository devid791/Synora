# One authorized P13 invocation via an existing Limited InteractiveToken desktop.
# No setup, credential import, Add-Type/compiler, OS/ACL change or retry.
param([Parameter(Mandatory=$true)][ValidatePattern('^[a-z0-9-]+$')][string]$RunId)
$ErrorActionPreference='Stop'
$project=(Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
if ($project -ne 'C:\Synora_QA_c7a7fb8_20260909_6774e0336697') {throw 'Unexpected frozen QA root'}
Set-Location $project
$session=[Diagnostics.Process]::GetCurrentProcess().SessionId
$identity=[Security.Principal.WindowsIdentity]::GetCurrent()
$elevated=([Security.Principal.WindowsPrincipal]$identity).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if ($session -ne 1 -or $elevated -or $identity.Name -ine 'AXIOM-WIN-BUILD\axiom-builder') {throw 'Requires existing Limited builder Session1'}
$release=Join-Path $project 'out\live-evidence\c7a7-windows-independent-cleanup.json'
if ((Get-FileHash -LiteralPath $release).Hash -ine '781d8196893321a447ef97696a9a9c3197b93a0bb8d4dfef25242b8ba23d9e8c') {throw 'Mill cleanup receipt changed'}
if (Get-ScheduledTask -TaskName 'Synora-QA-c7a7fb8-independent-6774e0336697' -ErrorAction SilentlyContinue) {throw 'Mill still owns its native task'}
$output=Join-Path $project ('out\live-evidence\supervisor-windows-'+$RunId)
if (Test-Path -LiteralPath $output) {throw 'Invocation already exists; retain it, no retry/overwrite'}
New-Item -ItemType Directory -Path $output | Out-Null
$env:Path='C:\Program Files\nodejs;'+$env:Path
$env:SYNORA_TEST_EXECUTABLE=Join-Path $project 'out\production-qa-windows-c7a7fb8\win-unpacked\Synora Harness Desktop.exe'
$env:SYNORA_TEST_PREPARED_WINDOWS_QA='C:\Users\axiom-builder\AppData\Local\Temp\synora-live-native-Mb5PPy'
$env:SYNORA_TEST_ENDPOINT='http://10.23.45.10:8015/codex/v1'
$env:SYNORA_ONE_AGENT_AUTHORIZED='1'
$env:SYNORA_P13_WINDOWS_GPU_HANDOFF='1'
$env:SYNORA_P13_WINDOWS_EVIDENCE=$output
$env:PLAYWRIGHT_JSON_OUTPUT_FILE=Join-Path $output 'test.json'
$r=[ordered]@{started=[DateTime]::UtcNow.ToString('o');runId=$RunId;source='c7a7fb873dce16e403cb6b127c32ed5fbdbfd683';sessionId=$session;identity=$identity.Name;elevated=$elevated;interactiveTaskRequired=$true;config='playwright.supervisor-windows.config.ts';invocations=1;retries=0;passed=$false}
$exitCode=1
try {
  $command='node node_modules/@playwright/test/cli.js test --config playwright.supervisor-windows.config.ts > "'+(Join-Path $output 'stdout.log')+'" 2> "'+(Join-Path $output 'stderr.log')+'"'
  & cmd.exe /d /c $command
  $exitCode=$LASTEXITCODE
  $report=Get-Content -LiteralPath (Join-Path $output 'test.json') -Raw | ConvertFrom-Json
  $r.stats=$report.stats
  $r.passed=($exitCode -eq 0 -and $report.stats.expected -eq 1 -and $report.stats.unexpected -eq 0 -and $report.stats.skipped -eq 0 -and $report.stats.flaky -eq 0)
  if (-not $r.passed) {$exitCode=1}
} catch {$r.error=$_.Exception.Message;$exitCode=1} finally {
  $r.exitCode=$exitCode;$r.finished=[DateTime]::UtcNow.ToString('o')
  $r.files=@(Get-ChildItem -LiteralPath $output -File | ForEach-Object {@{name=$_.Name;bytes=$_.Length;sha256=(Get-FileHash -LiteralPath $_.FullName).Hash.ToLowerInvariant()}})
  [IO.File]::WriteAllText((Join-Path $output 'runner.json'),($r | ConvertTo-Json -Depth 8),[Text.UTF8Encoding]::new($false))
}
exit $exitCode
