# Executed only by a Limited InteractiveToken task; never performs OS setup.
param([Parameter(Mandatory=$true)][string]$Proof,
  [ValidateSet('playwright.openai-provider-desktop.config.ts','playwright.xai-desktop.config.ts','playwright.openrouter-desktop.config.ts','playwright.anthropic-desktop.config.ts','playwright.gemini-desktop.config.ts','playwright.deepseek-desktop.config.ts','playwright.mistral-desktop.config.ts','playwright.compatible-desktop.config.ts')][string]$Config)
$ErrorActionPreference='Stop'
Set-Location 'C:\Synora_Production_QA_9cfc8ac'
$p=Get-Content -LiteralPath $Proof -Raw | ConvertFrom-Json
$dir=Split-Path $Proof
$receipt=[ordered]@{ started=[DateTime]::UtcNow.ToString('o'); config=$Config; sessionId=[Diagnostics.Process]::GetCurrentProcess().SessionId; elevated=([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator) }
$exitCode=1
try {
  if ($receipt.sessionId -eq 0 -or $receipt.elevated) { throw 'Requires limited interactive desktop token' }
  $env:SYNORA_QA_NETWORK_PROOF=$Proof
  $env:SYNORA_TEST_PREPARED_WINDOWS_QA=$p.qaHome
  $env:SYNORA_QA_CORE_LAUNCHER='C:\Synora_Production_QA_9cfc8ac\out\qa-core-launcher\controlled-core.exe'
  Remove-Item Env:SYNORA_TEST_EXECUTABLE -ErrorAction SilentlyContinue
  if ($p.candidate) {
    $candidateRoots=@{
      c7a7fb8='C:\Synora_QA_c7a7fb8_20260909_6774e0336697'
      '6abb5b9'='C:\Synora_QA_6abb5b9_20260910_2e1a753a1d8a'
    }
    if ($p.candidate.candidate -notin @('c7a7fb8','6abb5b9') -or $p.candidate.config -ne $Config -or $p.candidate.root -ne $candidateRoots[$p.candidate.candidate]) { throw 'Unexpected packaged candidate' }
    Set-Location $p.candidate.root
    # Validate the administrator-protected proof before using its executable.
    & powershell.exe -NoProfile -NonInteractive -ExecutionPolicy RemoteSigned -File tests/fixtures/windows-qa-network.ps1 -Action Verify -Proof $Proof | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'Limited-token firewall proof failed' }
    $env:SYNORA_TEST_EXECUTABLE=$p.candidate.executable
    $env:SYNORA_QA_CORE_LAUNCHER=$p.candidate.launcher
    $receipt.candidate=$p.candidate
  } elseif ($Config -notin @('playwright.openai-provider-desktop.config.ts','playwright.xai-desktop.config.ts')) {
    throw 'Extended provider fixtures require exact packaged candidate admission'
  }
  & $p.files[0].path node_modules/@playwright/test/cli.js test --config $Config 1> (Join-Path $p.output 'stdout.log') 2> (Join-Path $p.output 'stderr.log')
  $exitCode=$LASTEXITCODE
} catch { $receipt.error=$_.Exception.Message } finally {
  $receipt.exitCode=$exitCode
  $receipt.finished=[DateTime]::UtcNow.ToString('o')
  [IO.File]::WriteAllText((Join-Path $p.output 'desktop-receipt.json'),($receipt | ConvertTo-Json -Depth 6),[Text.UTF8Encoding]::new($false))
}
exit $exitCode
