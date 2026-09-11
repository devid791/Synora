# Read-only admission/observation. No Add-Type/compilation, task registration,
# credential access, setup, elevation, ACL/firewall changes or process stops.
param([int]$AppPid=0)
$ErrorActionPreference='Stop'
$identity=[Security.Principal.WindowsIdentity]::GetCurrent()
$session=[Diagnostics.Process]::GetCurrentProcess().SessionId
$elevated=([Security.Principal.WindowsPrincipal]$identity).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if ($identity.Name -ine 'AXIOM-WIN-BUILD\axiom-builder' -or $env:COMPUTERNAME -ne 'AXIOM-WIN-BUILD') {throw 'Unexpected Windows QA identity'}
if ($session -ne 1 -or $elevated) {throw 'Requires existing Limited Session1; no elevation or Session0 fallback'}
$groups=(& "$env:SystemRoot\System32\whoami.exe" /groups /fo csv /nh | Out-String)
if ($LASTEXITCODE -ne 0 -or $groups -notmatch 'S-1-16-8192' -or $groups -match 'S-1-16-(12288|16384)') {throw 'Requires actual medium-integrity token'}
$all=@(Get-CimInstance Win32_Process)
$self=$all | Where-Object ProcessId -eq $PID
$parent=$all | Where-Object ProcessId -eq $self.ParentProcessId
if (-not $parent -or $parent.Name -ine 'node.exe' -or $parent.SessionId -ne 1) {throw 'Inspector must inherit the actual Session1 Node runner token'}
if (-not ($all | Where-Object {$_.Name -ieq 'explorer.exe' -and $_.SessionId -eq 1})) {throw 'Existing console desktop is not present'}
$qa='C:\Users\axiom-builder\AppData\Local\Temp\synora-live-native-Mb5PPy'
$core=Join-Path $qa 'state\core-runtime\0.153.4-x86_64-pc-windows-msvc-a6ef3442cb12766a\bin\codex.exe'
$exe='C:\Synora_QA_c7a7fb8_20260909_6774e0336697\out\production-qa-windows-c7a7fb8\win-unpacked\Synora Harness Desktop.exe'
$related=@($all | Where-Object {$_.ExecutablePath -ieq $exe -or $_.ExecutablePath -ieq $core -or ($_.CommandLine -and $_.CommandLine.Contains($qa))})
if ($AppPid -eq 0 -and $related.Count -ne 0) {throw 'Prepared-home app/Core is already in use; do not stop it or create a new home'}
if ($AppPid -ne 0) {
  $app=$all | Where-Object ProcessId -eq $AppPid
  if (-not $app -or $app.ExecutablePath -ine $exe -or $app.SessionId -ne 1) {throw ('Owned packaged app identity changed: '+(@{expectedPid=$AppPid;expectedPath=$exe;observed=@($app | Select-Object ProcessId,ParentProcessId,Name,SessionId,ExecutablePath)} | ConvertTo-Json -Depth 3 -Compress))}
  $owned=@($AppPid)
  do {$old=$owned.Count;$owned+=@($all | Where-Object {$owned -contains $_.ParentProcessId -and $owned -notcontains $_.ProcessId} | ForEach-Object ProcessId)} while($old -ne $owned.Count)
  if (@($related | Where-Object {$owned -notcontains $_.ProcessId}).Count) {throw 'Another process owns this prepared app/Core home'}
  $children=@($all | Where-Object {$owned -contains $_.ProcessId})
  foreach($p in $children) {
    if ($p.Name -ieq 'codex.exe' -and $p.ExecutablePath -ine $core) {throw 'App launched a different Core executable'}
  }
} else {$children=@()}
[ordered]@{at=[DateTime]::UtcNow.ToString('o');identity=$identity.Name;sessionId=$session;elevated=$elevated;mediumIntegrity=$true;runnerPid=$parent.ProcessId;appPid=$AppPid;related=@($related | Select-Object ProcessId,ParentProcessId,Name,SessionId,ExecutablePath);children=@($children | Select-Object ProcessId,ParentProcessId,Name,SessionId,ExecutablePath)} | ConvertTo-Json -Depth 5 -Compress
