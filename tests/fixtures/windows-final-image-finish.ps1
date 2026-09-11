# Post-test evidence and exact task cleanup only; no build/setup/installation.
$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
$fix=(Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
if ($fix -ne 'C:\Synora_QA_imagefix_20260909_7277d77888ff' -or $env:COMPUTERNAME -ne 'AXIOM-WIN-BUILD') {throw 'Unexpected regression root'}
$original='C:\Synora_QA_final_20260909_6fe71e6f74ff'
$node='C:\Program Files\nodejs\node.exe'
Set-Location $fix
$fixedProof=& $node scripts/source-receipt.mjs verify out/compiled-source-receipt.json
$fixedCode=$LASTEXITCODE
$fixed=($fixedProof -join '')|ConvertFrom-Json
if ($fixedCode -ne 1 -or $fixed.mismatches.Count -ne 1 -or $fixed.mismatches[0] -ne 'src/main/image-attachments.ts') {throw 'Unexpected additional runtime edits'}
Set-Location $original
$originalProof=& $node scripts/source-receipt.mjs verify out/compiled-source-receipt.json
if ($LASTEXITCODE -ne 0) {throw 'Original frozen source mutated'}
$identities=@(
  @{path='out\production-qa-windows-c858d967\win-unpacked\resources\app.asar';expected='6b620623cb57b47bbd0522e8d44dc062acb7e4ab1d06e7ad263005c03c8f6e9e'},
  @{path='out\production-qa-windows-c858d967\win-unpacked\Synora Harness Desktop.exe';expected='99d7a5ff1f0173ce497defcfb0ec14f169a7ad72d73e3e53e0a3c47e7cd4a199'},
  @{path='out\production-qa-windows-c858d967\Synora Harness Desktop Setup 0.1.0-foundation.2.exe';expected='616e60018b5b0c21953c956d638eaaef22a53d8544e3a8ca6e1c86c139548967'}
)
foreach($i in $identities) {
  $i.actual=(Get-FileHash -LiteralPath $i.path).Hash.ToLowerInvariant()
  if ($i.actual -ne $i.expected) {throw 'Frozen candidate identity changed'}
}
$r=[ordered]@{finished=[DateTime]::UtcNow.ToString('o');fixedTree=$fix;fixedSourceVerification=$fixed;originalFrozenVerification=($originalProof -join '')|ConvertFrom-Json;originalIdentities=$identities;newPackageBuilt=$false;inferenceRequests=0;helperSha256=(Get-FileHash -LiteralPath $PSCommandPath).Hash.ToLowerInvariant()}
[IO.File]::WriteAllText(($fix+'\out\live-evidence\windows-final-image-frozen-preservation.json'),($r|ConvertTo-Json -Depth 5),[Text.UTF8Encoding]::new($false))
$r|ConvertTo-Json -Depth 5
$cleaned=@()
$tasks=@('Synora-QA-final-image-baseline-7277d77888ff','Synora-QA-final-image-fixed-7277d77888ff')
# Validate all targets before unregistering any of them.
foreach($name in $tasks) {
  $task=Get-ScheduledTask -TaskName $name
  $info=Get-ScheduledTaskInfo -TaskName $name
  if ($task.State -eq 'Running' -or $info.LastTaskResult -ne 0) {throw 'Image test task is not successful/terminal'}
}
foreach($name in $tasks) {
  Unregister-ScheduledTask -TaskName $name -Confirm:$false
  $cleaned+=@{task=$name;terminalResult=0;unregistered=$true}
}
$cleanup=[ordered]@{finished=[DateTime]::UtcNow.ToString('o');tasks=$cleaned;killedProcesses=@();onlyOwnedTasksRemoved=$true;helperSha256=$r.helperSha256}
[IO.File]::WriteAllText(($fix+'\out\live-evidence\windows-final-image-task-cleanup.json'),($cleanup|ConvertTo-Json -Depth 5),[Text.UTF8Encoding]::new($false))
$cleanup|ConvertTo-Json -Depth 5
