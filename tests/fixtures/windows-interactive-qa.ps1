# QA only: run from an InteractiveToken scheduled task in the logged-in desktop.
# No account/DACL/policy changes, inference in Helper mode, or sandbox fallback.
param(
  [ValidateSet('Helper','Live','LiveSource')][string]$Mode = 'Helper',
  [ValidatePattern('^production-qa-windows-[0-9a-f]{7,40}$')][string]$Candidate = 'production-qa-windows-8fe6044',
  [ValidatePattern('^[0-9a-f]{64}$')][string]$ExpectedHash = 'c88e7a937717b3956d91e21d0859ca316841f5348c4fdec22fea563273058b20',
  [ValidateSet('playwright.live-desktop.config.ts','playwright.live-mcp-desktop.config.ts','playwright.quality-desktop.config.ts','playwright.config.ts','playwright.cancel-windows.config.ts','playwright.windows-home.config.ts','playwright.windows-recovery.config.ts')][string]$Config = 'playwright.live-desktop.config.ts',
  [switch]$ResetFixture,
  [string]$SearchUrl
)
$ErrorActionPreference = 'Stop'
Set-Location (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$session = [Diagnostics.Process]::GetCurrentProcess().SessionId
if ([Security.Principal.WindowsIdentity]::GetCurrent().Name -ne 'AXIOM-WIN-BUILD\axiom-builder' -or $session -eq 0) { throw 'Requires actual builder desktop, not SSH Session0' }
Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;
public static class SynoraQaInteractive {
  [DllImport("user32.dll")] static extern IntPtr GetProcessWindowStation();
  [DllImport("user32.dll",SetLastError=true,CharSet=CharSet.Unicode)] static extern bool GetUserObjectInformationW(IntPtr h,int n,StringBuilder b,uint len,out uint need);
  public static string Station() { var b=new StringBuilder(512); uint need; if(!GetUserObjectInformationW(GetProcessWindowStation(),2,b,1024,out need)) throw new Win32Exception(); return b.ToString(); }
}
'@
$station = [SynoraQaInteractive]::Station()
if ($station -ine 'WinSta0') { throw 'Not the interactive window station' }
$receiptDir = Join-Path (Get-Location) ('out\live-evidence\windows-interactive-' + $Mode.ToLower() + '-' + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $receiptDir -ErrorAction Stop | Out-Null
$exitCode = 1
$qaHome = 'C:\Users\axiom-builder\AppData\Local\Temp\synora-live-native-Mb5PPy'
$core = Join-Path $qaHome 'state\core-runtime\0.153.4-x86_64-pc-windows-msvc-a6ef3442cb12766a\bin\codex.exe'
$node = (Get-Command node.exe).Source
$receipt = [ordered]@{ started=[DateTime]::UtcNow.ToString('o'); mode=$Mode; sessionId=$session; station=$station; qaHome=$qaHome; coreSha256=(Get-FileHash $core -Algorithm SHA256).Hash; elevated=([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator) }
try {
  if ($Mode -eq 'Helper') {
    & $node tests/fixtures/windows-helper-elevated.mjs $qaHome $core 'interactive' 1> (Join-Path $receiptDir 'stdout.log') 2> (Join-Path $receiptDir 'stderr.log')
  } else {
    if ($Mode -eq 'Live') {
      $env:SYNORA_TEST_EXECUTABLE=Join-Path (Get-Location) ('out\'+$Candidate+'\win-unpacked\Synora Harness Desktop.exe')
      $receipt.asarSha256=(Get-FileHash (Join-Path (Split-Path $env:SYNORA_TEST_EXECUTABLE) 'resources\app.asar') -Algorithm SHA256).Hash
      if ($receipt.asarSha256 -ine $ExpectedHash) { throw 'Candidate hash mismatch' }
    } else {
      Remove-Item Env:SYNORA_TEST_EXECUTABLE -ErrorAction SilentlyContinue
      $receipt.developmentBundleSha256=(Get-FileHash 'dist\main.cjs' -Algorithm SHA256).Hash
    }
    $env:SYNORA_TEST_ENDPOINT='http://10.23.45.10:8015/codex/v1'
    $env:SYNORA_TEST_PREPARED_WINDOWS_QA=$qaHome
    if ($ResetFixture) { $env:SYNORA_QA_RESET_AFTER_SUCCESS='1' }
    if ($SearchUrl) { $env:SYNORA_TEST_SEARCH_URL=$SearchUrl }
    $receipt.config=$Config
    & $node node_modules/@playwright/test/cli.js test --config $Config 1> (Join-Path $receiptDir 'stdout.log') 2> (Join-Path $receiptDir 'stderr.log')
  }
  $exitCode=$LASTEXITCODE
} catch { $receipt.error=$_.Exception.Message } finally {
  $receipt.exitCode=$exitCode
  $receipt.finished=[DateTime]::UtcNow.ToString('o')
  [IO.File]::WriteAllText((Join-Path $receiptDir 'receipt.json'),($receipt | ConvertTo-Json),[Text.UTF8Encoding]::new($false))
}
exit $exitCode
