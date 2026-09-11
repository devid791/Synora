# CPU-only limited-session reproduction/regression. No builds or Core/setup.
param(
  [Parameter(Mandatory=$true)][ValidateSet('Baseline','Fixed')][string]$Phase,
  [Parameter(Mandatory=$true)][ValidatePattern('^[0-9a-f]{64}$')][string]$ExpectedSourceSha256
)
$ErrorActionPreference='Stop'
$project=(Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$required=if ($Phase -eq 'Baseline') {'C:\Synora_QA_final_20260909_6fe71e6f74ff'} else {'C:\Synora_QA_imagefix_20260909_7277d77888ff'}
if ($project -ne $required -or $env:COMPUTERNAME -ne 'AXIOM-WIN-BUILD') {throw 'Unexpected QA target'}
Set-Location $project
$session=[Diagnostics.Process]::GetCurrentProcess().SessionId
$elevated=([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if ($session -ne 1 -or $elevated) {throw 'Requires preserved Limited Session1'}
Add-Type -TypeDefinition @'
using System; using System.Text; using System.Runtime.InteropServices;
public static class WindowsFinalImageStation {
  [DllImport("user32.dll")] static extern IntPtr GetProcessWindowStation();
  [DllImport("user32.dll",SetLastError=true,CharSet=CharSet.Unicode)] static extern bool GetUserObjectInformationW(IntPtr h,int n,StringBuilder b,uint len,out uint need);
  public static string Name(){var b=new StringBuilder(512);uint n;if(!GetUserObjectInformationW(GetProcessWindowStation(),2,b,1024,out n))throw new Exception("Cannot read station");return b.ToString();}
}
'@
if ([WindowsFinalImageStation]::Name() -ine 'WinSta0') {throw 'Requires WinSta0'}
$sourceHash=(Get-FileHash -LiteralPath 'src\main\image-attachments.ts').Hash.ToLowerInvariant()
if ($sourceHash -ne $ExpectedSourceSha256) {throw 'Unexpected image implementation hash'}
# The original failing six image/service checks run unchanged in the limited
# token; separately added file-symlink regressions use the existing SSH token.
if ((Get-FileHash -LiteralPath 'tests\image-attachments.test.ts').Hash -ine 'c11314740204391322b2f785bfccd8310058030efd1e727d02ba0ebfbd9fd513') {throw 'Expected unchanged original six-case image test file'}
$node='C:\Program Files\nodejs\node.exe'
$env:Path='C:\Program Files\nodejs;'+$env:Path
$stem='windows-final-image-'+$Phase.ToLowerInvariant()
$output=Join-Path $project 'out\live-evidence'
$env:SYNORA_IMAGE_ALIAS_EXPECT=if ($Phase -eq 'Baseline') {'reject'} else {'pass'}
$env:SYNORA_IMAGE_ALIAS_RECEIPT=Join-Path $output ($stem+'-alias.json')
$receiptPath=Join-Path $output ($stem+'-session.json')
if ((Test-Path -LiteralPath $receiptPath) -or (Test-Path -LiteralPath $env:SYNORA_IMAGE_ALIAS_RECEIPT)) {throw 'Evidence exists; do not overwrite/restart'}
$r=[ordered]@{started=[DateTime]::UtcNow.ToString('o');phase=$Phase;root=$project;sessionId=$session;elevated=$elevated;station='WinSta0';sourceSha256=$sourceHash;temp=$env:TEMP;tmp=$env:TMP;tempOverridden=$false;inferenceRequests=0;packaged=$false;passed=$false}
$exitCode=1
try {
  & cmd.exe /d /c ('node node_modules/tsx/dist/cli.mjs tests/fixtures/windows-final-image-alias-check.ts > out/live-evidence/'+$stem+'-alias.stdout.log 2> out/live-evidence/'+$stem+'-alias.stderr.log')
  $r.aliasExitCode=$LASTEXITCODE
  if ($r.aliasExitCode -ne 0) {throw 'Explicit alias check failed; preserve original evidence'}
  if ($Phase -eq 'Fixed') {
    & cmd.exe /d /c ('node node_modules/tsx/dist/cli.mjs --test --test-reporter=tap tests/image-attachments.test.ts tests/services.test.ts > out/live-evidence/'+$stem+'-original-regressions.tap 2>&1')
    $r.regressionExitCode=$LASTEXITCODE
    if ($r.regressionExitCode -ne 0) {throw 'Original image/service regression failed'}
  }
  $r.passed=$true;$exitCode=0
} catch {$r.error=$_.Exception.Message} finally {
  $r.exitCode=$exitCode;$r.finished=[DateTime]::UtcNow.ToString('o')
  [IO.File]::WriteAllText($receiptPath,($r|ConvertTo-Json -Depth 5),[Text.UTF8Encoding]::new($false))
}
exit $exitCode
