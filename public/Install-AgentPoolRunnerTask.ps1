[CmdletBinding()]
param(
    [string]$TaskName = "AgentPool Autonomous Runner"
)

$ErrorActionPreference = "Stop"
$runnerDir = $PSScriptRoot
$launcher = Join-Path $runnerDir "Start-AgentPoolRunner.ps1"
if (-not (Test-Path -LiteralPath $launcher -PathType Leaf)) {
    throw "Runner launcher is missing: $launcher"
}

$action = New-ScheduledTaskAction `
    -Execute "powershell.exe" `
    -Argument "-NoLogo -NoProfile -ExecutionPolicy Bypass -File `"$launcher`" -Autostart" `
    -WorkingDirectory ([System.IO.Path]::GetFullPath((Join-Path $runnerDir "..")))
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$settings = New-ScheduledTaskSettingsSet `
    -RestartCount 99 `
    -RestartInterval (New-TimeSpan -Minutes 1) `
    -ExecutionTimeLimit ([TimeSpan]::Zero) `
    -MultipleInstances IgnoreNew `
    -StartWhenAvailable
$principal = New-ScheduledTaskPrincipal `
    -UserId "$env:USERDOMAIN\$env:USERNAME" `
    -LogonType Interactive `
    -RunLevel Limited

Register-ScheduledTask `
    -TaskName $TaskName `
    -Action $action `
    -Trigger $trigger `
    -Settings $settings `
    -Principal $principal `
    -Description "Restarts the Base Sepolia-only AgentPool autonomous Runner after logon or failure." `
    -Force | Out-Null

Write-Output "Installed scheduled task: $TaskName"
Write-Output "The task uses only device-local keys and is still locked to Base Sepolia."
