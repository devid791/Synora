# QA-only: exact executable outbound isolation, ActiveStore proof and cleanup.
# No production service, account password, global firewall profile or SSH change.
param(
  [ValidateSet('Run','Verify','Cleanup')][string]$Action='Verify',
  [string]$Proof,
  [ValidateSet('playwright.openai-provider-desktop.config.ts','playwright.xai-desktop.config.ts','playwright.openrouter-desktop.config.ts','playwright.anthropic-desktop.config.ts','playwright.gemini-desktop.config.ts','playwright.deepseek-desktop.config.ts','playwright.mistral-desktop.config.ts','playwright.compatible-desktop.config.ts')][string]$Config,
  [ValidateSet('legacy','c7a7fb8','6abb5b9')][string]$Candidate='legacy',
  [ValidateRange(1024,65535)][int]$TcpPort=49150,
  [ValidateRange(1024,65535)][int]$UdpPort=49151
)
$ErrorActionPreference='Stop'
$project='C:\Synora_Production_QA_9cfc8ac'
$base='C:\ProgramData\Synora-QA-Network'
$ranges=@('0.0.0.0-126.255.255.255','128.0.0.0-255.255.255.255','::2-ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff')
function Write-Json($path,$value) { [IO.File]::WriteAllText($path,($value | ConvertTo-Json -Depth 10),[Text.UTF8Encoding]::new($false)) }
function Assert-Protected($path) {
  $item=Get-Item -LiteralPath $path
  if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Linked proof rejected' }
  $acl=Get-Acl -LiteralPath $path
  if ($acl.GetOwner([Security.Principal.SecurityIdentifier]).Value -notin @('S-1-5-32-544','S-1-5-18')) { throw 'Proof must have administrator ownership' }
  foreach ($ace in $acl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])) {
    if ($ace.AccessControlType -eq 'Allow' -and $ace.IdentityReference.Value -notin @('S-1-5-32-544','S-1-5-18') -and ($ace.FileSystemRights -band [Security.AccessControl.FileSystemRights]::Write)) { throw 'Unprivileged writable proof rejected' }
  }
}
function Read-Proof {
  if ($Proof -notmatch '^C:\\ProgramData\\Synora-QA-Network\\[0-9a-f]{32}\\proof.json$') { throw 'Invalid proof path' }
  foreach ($v in @($base,(Split-Path $Proof),$Proof)) { Assert-Protected $v }
  $p=Get-Content -LiteralPath $Proof -Raw | ConvertFrom-Json
  if ($p.schema -ne 'synora.qa-windows-network.v1' -or $p.id -notmatch '^[0-9a-f]{32}$' -or (Split-Path (Split-Path $Proof) -Leaf) -ne $p.id) { throw 'Invalid proof identity' }
  return $p
}
function Verify-Proof($p) {
  $now=[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
  if ($p.expires -le $now -or $p.expires -gt $now+420000) { throw 'Expired network proof' }
  # Windows Firewall's documented COM reader is available to the limited UI
  # token; the CIM ActiveStore cmdlet requires elevation even for reads.
  $policy=New-Object -ComObject HNetCfg.FwPolicy2
  foreach ($profile in @(1,2,4)) { if (-not $policy.FirewallEnabled($profile)) { throw 'All existing firewall profiles must remain enabled' } }
  if ($p.files.Count -ne 3) { throw 'Incomplete process isolation' }
  foreach ($f in $p.files) {
    if ((Get-FileHash -LiteralPath $f.path -Algorithm SHA256).Hash -ine $f.sha256) { throw 'QA executable changed' }
    $r=$policy.Rules.Item($f.rule)
    $remote=@($r.RemoteAddresses.Split(',') | Sort-Object)
    if (-not $r.Enabled -or $r.Direction -ne 2 -or $r.Action -ne 0 -or $r.Profiles -ne 2147483647 -or $r.ApplicationName -ine $f.path -or (Compare-Object $remote @($ranges | Sort-Object))) { throw 'QA firewall rule does not match scope' }
    if ($r.Protocol -ne 256) { throw 'Protocol bypass in rule' }
  }
  foreach ($before in @($p.before.node,$p.before.electron,$p.unrelated)) {
    if ($before.tcp -ne 'allowed' -or $before.udp -ne 'allowed') { throw 'Missing external control baseline' }
  }
}
function Cleanup-Proof($p) {
  # The only executable paths in this admin-owned plan are our three QA copies.
  Stop-ScheduledTask -TaskName ('Synora-QA-Controlled-'+$p.id) -ErrorAction SilentlyContinue
  $paths=@($p.files | ForEach-Object path)
  $owned=@(Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -and $_.ExecutablePath -in $paths })
  foreach ($proc in $owned) { Stop-Process -Id $proc.ProcessId -Force -ErrorAction SilentlyContinue }
  Start-Sleep -Milliseconds 300
  $remaining=@(Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -and $_.ExecutablePath -in $paths })
  if ($remaining.Count) { throw 'QA processes still alive; retain isolation' }
  foreach ($f in $p.files) { Get-NetFirewallRule -Name $f.rule -ErrorAction SilentlyContinue | Remove-NetFirewallRule }
  $remainingRules=@($p.files | ForEach-Object { Get-NetFirewallRule -Name $_.rule -ErrorAction SilentlyContinue })
  if ($remainingRules.Count) { throw 'Scoped QA rules remain; cleanup must be retried' }
  Write-Json (Join-Path (Split-Path $Proof) 'cleanup.json') @{ finished=[DateTime]::UtcNow.ToString('o'); killed=@($owned | ForEach-Object ProcessId); remaining=0; removedRules=@($p.files | ForEach-Object rule) }
}
if ($Action -eq 'Verify') { $p=Read-Proof; Verify-Proof $p; $p | ConvertTo-Json -Depth 10; exit 0 }
if (-not ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw 'Requires elevated administrator for scoped rules' }
if ($Action -eq 'Cleanup') { $p=Read-Proof; Cleanup-Proof $p; exit 0 }
if (-not $Config) { throw 'Select one exact controlled test' }
$candidatePlan=$null
if ($Candidate -in @('c7a7fb8','6abb5b9')) {
  $candidateRoots=@{
    c7a7fb8='C:\Synora_QA_c7a7fb8_20260909_6774e0336697'
    '6abb5b9'='C:\Synora_QA_6abb5b9_20260910_2e1a753a1d8a'
  }
  $project=$candidateRoots[$Candidate]
  Set-Location $project
  # Read-only identity admission before any directory, task or firewall change.
  $planJson=& node.exe tests/fixtures/native-provider-candidate.mjs $Candidate $Config
  if ($LASTEXITCODE -ne 0) { throw 'Exact candidate admission failed; no rules installed' }
  $candidatePlan=$planJson | ConvertFrom-Json
} elseif ($Config -notin @('playwright.openai-provider-desktop.config.ts','playwright.xai-desktop.config.ts')) {
  throw 'Extended provider fixtures require exact packaged candidate admission'
}
Set-Location $project
$id=[Guid]::NewGuid().ToString('N')
if (-not (Test-Path -LiteralPath $base)) {
  New-Item -ItemType Directory -Path $base | Out-Null
  $acl=[Security.AccessControl.DirectorySecurity]::new()
  $acl.SetOwner([Security.Principal.SecurityIdentifier]::new('S-1-5-32-544'))
  $acl.SetAccessRuleProtection($true,$false)
  foreach ($sid in @('S-1-5-32-544','S-1-5-18')) {
    $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]::new($sid),'FullControl','ContainerInherit,ObjectInherit','None','Allow'))
  }
  $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.NTAccount]::new('AXIOM-WIN-BUILD\axiom-builder'),'ReadAndExecute','ContainerInherit,ObjectInherit','None','Allow'))
  Set-Acl -LiteralPath $base -AclObject $acl
}
Assert-Protected $base
$dir=Join-Path $base $id
New-Item -ItemType Directory -Path $dir | Out-Null
$Proof=Join-Path $dir 'proof.json'
$output=Join-Path $project ('out\live-evidence\windows-network-'+$id)
New-Item -ItemType Directory -Path $output | Out-Null
$qaHome='C:\Users\axiom-builder\AppData\Local\Temp\synora-live-native-Mb5PPy'
$core=Join-Path $qaHome 'state\core-runtime\0.153.4-x86_64-pc-windows-msvc-a6ef3442cb12766a\bin\codex.exe'
$electron=Join-Path $project 'node_modules\electron\dist\electron.exe'
if ($candidatePlan) {
  $qaHome=$candidatePlan.qaHome
  $core=$candidatePlan.core
  $electron=$candidatePlan.executable
}
$node=(Get-Command node.exe).Source
Copy-Item -LiteralPath $node -Destination (Join-Path $dir 'node.exe')
Copy-Item -LiteralPath $PSCommandPath -Destination (Join-Path $dir 'network.ps1')
Copy-Item -LiteralPath (Join-Path $project 'tests\fixtures\windows-controlled-provider-qa.ps1') -Destination (Join-Path $dir 'desktop.ps1')
$privateNode=Join-Path $dir 'node.exe'
$paths=@($privateNode,$electron,$core)
if (@(Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -and $_.ExecutablePath -in $paths }).Count) { throw 'A QA executable is already running; no intervention' }
if ((Get-FileHash $core -Algorithm SHA256).Hash -ine '444a3f0008050605cae73cd9b7a2dcac61294062dfaab56dd20430fd6498518b') { throw 'Original Core identity mismatch' }
function Probe($exe) {
  # GUI-subsystem Electron does not reliably pipe stdout through PowerShell's
  # call operator. Own the process/handles explicitly for both native programs.
  $info=[Diagnostics.ProcessStartInfo]::new()
  $info.FileName=$exe
  $info.Arguments='"'+(Join-Path $project 'tests\fixtures\windows-qa-probe.mjs')+'" 10.23.46.16 '+$TcpPort+' '+$UdpPort
  $info.UseShellExecute=$false
  $info.RedirectStandardOutput=$true
  $info.RedirectStandardError=$true
  $proc=[Diagnostics.Process]::Start($info)
  try {
    $stdout=$proc.StandardOutput.ReadToEndAsync()
    $stderr=$proc.StandardError.ReadToEndAsync()
    if (-not $proc.WaitForExit(6000)) { $proc.Kill(); throw 'Probe deadline' }
    if ($proc.ExitCode -ne 0) { throw ('Probe failed: '+$stderr.Result) }
    return ($stdout.Result | ConvertFrom-Json)
  } finally { $proc.Dispose() }
}
$beforeNode=Probe $privateNode
try { $env:ELECTRON_RUN_AS_NODE='1'; $beforeElectron=Probe $electron } finally { Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue }
Write-Json (Join-Path $output 'baseline.json') @{ node=$beforeNode; electron=$beforeElectron }
foreach ($before in @($beforeNode,$beforeElectron)) { if ($before.tcp -ne 'allowed' -or $before.udp -ne 'allowed') { throw 'External baseline unavailable; no rules installed' } }
$files=@()
for ($i=0;$i -lt $paths.Count;$i++) { $files+=@{ path=$paths[$i]; sha256=(Get-FileHash $paths[$i] -Algorithm SHA256).Hash; rule=('Synora-QA-'+$id+'-'+$i) } }
$p=[ordered]@{ schema='synora.qa-windows-network.v1'; id=$id; qaHome=$qaHome; output=$output; host='10.23.46.16'; tcp=$TcpPort; udp=$UdpPort; expires=([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()+360000); files=$files; before=@{node=$beforeNode;electron=$beforeElectron}; unrelated=$null }
if ($candidatePlan) { $p.candidate=$candidatePlan }
Write-Json $Proof $p
Assert-Protected $Proof
$cleanupName='Synora-QA-Network-Cleanup-'+$id
$taskName='Synora-QA-Controlled-'+$id
$cleanupAction=New-ScheduledTaskAction -Execute 'powershell.exe' -Argument ('-NoProfile -NonInteractive -ExecutionPolicy RemoteSigned -File "'+(Join-Path $dir 'network.ps1')+'" -Action Cleanup -Proof "'+$Proof+'"')
Register-ScheduledTask -TaskName $cleanupName -Action $cleanupAction -Trigger (New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(6)) -Principal (New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest) | Out-Null
$exitCode=1
try {
  foreach ($f in $files) { New-NetFirewallRule -Name $f.rule -DisplayName $f.rule -Direction Outbound -Action Block -Program $f.path -RemoteAddress $ranges -Profile Any -Protocol Any -Enabled True | Out-Null }
  foreach ($f in $files) {
    $active=Get-NetFirewallRule -PolicyStore ActiveStore -Name $f.rule
    if ($active.Enabled -ne 'True' -or $active.Action -ne 'Block') { throw 'Rule absent from ActiveStore' }
  }
  $p.unrelated=Probe $node
  Write-Json $Proof $p
  Verify-Proof ([pscustomobject]$p)
  $blockedNode=Probe $privateNode
  try { $env:ELECTRON_RUN_AS_NODE='1'; $blockedElectron=Probe $electron } finally { Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue }
  foreach ($actual in @($blockedNode,$blockedElectron)) { if ($actual.tcp -notin @('timeout','EACCES','EPERM','ENETUNREACH','EHOSTUNREACH') -or $actual.udp -notin @('timeout','EACCES','EPERM','ENETUNREACH','EHOSTUNREACH')) { throw 'Scoped network isolation did not block both protocols' } }
  Write-Json (Join-Path $output 'isolation.json') @{ proof=$p; blockedNode=$blockedNode; blockedElectron=$blockedElectron }
  $taskAction=New-ScheduledTaskAction -Execute 'powershell.exe' -Argument ('-NoProfile -NonInteractive -ExecutionPolicy RemoteSigned -File "'+(Join-Path $dir 'desktop.ps1')+'" -Proof "'+$Proof+'" -Config '+$Config)
  Register-ScheduledTask -TaskName $taskName -Action $taskAction -Principal (New-ScheduledTaskPrincipal -UserId 'AXIOM-WIN-BUILD\axiom-builder' -LogonType Interactive -RunLevel Limited) -Settings (New-ScheduledTaskSettingsSet -ExecutionTimeLimit (New-TimeSpan -Minutes 4)) | Out-Null
  Start-ScheduledTask -TaskName $taskName
  $deadline=(Get-Date).AddSeconds(240)
  while (-not (Test-Path -LiteralPath (Join-Path $output 'desktop-receipt.json'))) {
    if ((Get-Date) -gt $deadline) { throw 'Controlled desktop task exceeded its bound' }
    Start-Sleep -Seconds 1
  }
  $receipt=Get-Content -LiteralPath (Join-Path $output 'desktop-receipt.json') -Raw | ConvertFrom-Json
  $exitCode=$receipt.exitCode
  $receipt | ConvertTo-Json
} catch { Write-Json (Join-Path $output 'controller-error.json') @{ error=$_.Exception.Message; position=$_.InvocationInfo.PositionMessage }; Write-Output $_.Exception.Message } finally {
  Cleanup-Proof ([pscustomobject]$p)
  foreach ($task in @($taskName,$cleanupName)) { Unregister-ScheduledTask -TaskName $task -Confirm:$false -ErrorAction SilentlyContinue }
  Copy-Item -LiteralPath (Join-Path $dir 'cleanup.json') -Destination (Join-Path $output 'cleanup.json')
  $after=Probe $privateNode
  Write-Json (Join-Path $output 'restored.json') $after
  if ($after.tcp -ne 'allowed' -or $after.udp -ne 'allowed') { $exitCode=1 }
  if ($candidatePlan) {
    # Same immutable app/Core and protected home identities AFTER cleanup too.
    $afterPlan=& node.exe tests/fixtures/native-provider-candidate.mjs $Candidate $Config
    if ($LASTEXITCODE -ne 0) { $exitCode=1 }
    else { [IO.File]::WriteAllText((Join-Path $output 'candidate-restored.json'),[string]$afterPlan,[Text.UTF8Encoding]::new($false)) }
  }
  Write-Output ('EVIDENCE='+$output)
}
exit $exitCode
