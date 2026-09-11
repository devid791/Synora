# Read-only visual follow-up; no P13 config/authorization, inference or retry.
$ErrorActionPreference='Stop'
$project=(Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
if ($project -ne 'C:\Synora_QA_c7a7fb8_20260909_6774e0336697') {throw 'Unexpected frozen QA root'}
Set-Location $project
$identity=[Security.Principal.WindowsIdentity]::GetCurrent()
$elevated=([Security.Principal.WindowsPrincipal]$identity).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if ([Diagnostics.Process]::GetCurrentProcess().SessionId -ne 1 -or $elevated -or $identity.Name -ine 'AXIOM-WIN-BUILD\axiom-builder') {throw 'Requires existing Limited builder Session1'}
$env:Path='C:\Program Files\nodejs;'+$env:Path
# cmd owns stderr redirection (Node sqlite emits a normal ExperimentalWarning).
$stem=Join-Path $project 'out\live-evidence\supervisor-windows-c7a7-20260909-p13-02-history-03'
foreach ($target in @($stem,($stem+'.node.stdout.log'),($stem+'.node.stderr.log'))) {
  if (Test-Path -LiteralPath $target) {throw 'Existing follow-up evidence: no overwrite/retry'}
}
$command='node --import tsx tests/fixtures/supervisor-windows-history.ts > "'+$stem+'.node.stdout.log" 2> "'+$stem+'.node.stderr.log"'
& cmd.exe /d /c $command
exit $LASTEXITCODE
