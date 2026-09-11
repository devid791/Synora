# Limited interactive desktop only. Existing private sandbox state is reused.
param([ValidateSet('base','quality','file','web','cancel')][string]$StartAt='base')
$ErrorActionPreference='Stop'
$project=(Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
if ($project -ne 'C:\Synora_QA_ea9df76_20260909') { throw 'Unexpected QA root' }
Set-Location $project
if ([Diagnostics.Process]::GetCurrentProcess().SessionId -eq 0 -or ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw 'Requires a limited interactive desktop token' }
$asar='out\production-qa-windows-ea9df76\win-unpacked\resources\app.asar'
$hash=(Get-FileHash $asar).Hash
$cases=@(
  @{name='base';config='playwright.config.ts'},
  @{name='quality';config='playwright.quality-desktop.config.ts'},
  @{name='file';config='playwright.live-desktop.config.ts'},
  @{name='web';config='playwright.live-mcp-desktop.config.ts'},
  @{name='cancel';config='playwright.cancel-windows.config.ts'}
)
$receipt=[ordered]@{started=[DateTime]::UtcNow.ToString('o');source='ea9df7636e743d2c4b1cbf5a18f2baa25809c06e';asar=$hash;startAt=$StartAt;cases=@();passed=$false}
$file=Join-Path $project ('out\live-evidence\windows-native-matrix-'+[Guid]::NewGuid().ToString('N')+'.json')
$exitCode=1
try {
  $active=$false
  foreach ($case in $cases) {
    if ($case.name -eq $StartAt) { $active=$true }
    if (-not $active) { continue }
    $synoraCaseArgs=@('-NoProfile','-NonInteractive','-ExecutionPolicy','RemoteSigned','-File',(Join-Path $PSScriptRoot 'windows-interactive-qa.ps1'),'-Mode','Live','-Candidate','production-qa-windows-ea9df76','-ExpectedHash',$hash,'-Config',$case.config)
    if ($case.name -eq 'file') {
      $env:SYNORA_QA_PREVIOUS_LIVE_RECEIPT='C:\Synora_Production_QA_9cfc8ac\out\live-evidence\live-native.json'
      $currentMarker=[IO.File]::ReadAllText('C:\Users\axiom-builder\AppData\Local\Temp\synora-live-native-Mb5PPy\workspace\native-check.txt')
      if ($currentMarker -eq "SYNORA_NATIVE_AFTER`n") { $synoraCaseArgs+='-ResetFixture' }
      elseif ($currentMarker -ne "SYNORA_NATIVE_BEFORE`n") { throw 'Unexpected fixture content; do not overwrite it' }
    }
    if ($case.name -eq 'web') { $synoraCaseArgs+=@('-SearchUrl','http://10.23.46.16:8888') }
    & powershell.exe @synoraCaseArgs
    $result=$LASTEXITCODE
    $receipt.cases+=@{name=$case.name;config=$case.config;exitCode=$result;finished=[DateTime]::UtcNow.ToString('o')}
    if ($result -ne 0) { throw ('Failed native case: '+$case.name) }
  }
  $receipt.passed=$true
  $exitCode=0
} catch { $receipt.error=$_.Exception.Message } finally {
  $receipt.finished=[DateTime]::UtcNow.ToString('o')
  [IO.File]::WriteAllText($file,($receipt | ConvertTo-Json -Depth 6),[Text.UTF8Encoding]::new($false))
}
exit $exitCode
