[CmdletBinding()]
param(
    [string]$BaseUrl = "https://agentpool-protocol.asfu.chatgpt.site",
    [string]$InstallRoot = (Join-Path $env:LOCALAPPDATA "AgentPool-v44-readonly"),
    [switch]$EnableWrite
)

$ErrorActionPreference = "Stop"
$resolvedRoot = [System.IO.Path]::GetFullPath($InstallRoot)
$bundleUrl = "$($BaseUrl.TrimEnd('/'))/agentpool-v44-readonly-bundle.json"
$bundlePath = Join-Path $resolvedRoot "participant-bundle.json"
$configPath = Join-Path $resolvedRoot "mcp-readonly.json"

if ($EnableWrite) {
    throw "AgentPool v4.4 public writes are not ready. Recovery targets, finalized anchors, independent custody, and reliability gates are still pending."
}

New-Item -ItemType Directory -Force -Path $resolvedRoot | Out-Null
Invoke-WebRequest -UseBasicParsing -Uri $bundleUrl -OutFile $bundlePath
if (-not (Test-Path -LiteralPath $bundlePath -PathType Leaf)) {
    throw "Read-only bundle download failed: $bundleUrl"
}

$bundle = Get-Content -LiteralPath $bundlePath -Raw | ConvertFrom-Json
if (
    $bundle.schema -ne "agentpool.v44.readonly-participant-bundle/v1" -or
    [int]$bundle.chainId -ne 84532 -or
    $bundle.mode -ne "read-only" -or
    [bool]$bundle.publicWriteReady -ne $false -or
    [bool]$bundle.walletCreated -ne $false -or
    [bool]$bundle.scheduledTaskCreated -ne $false -or
    [bool]$bundle.backgroundProcessStarted -ne $false
) {
    throw "The downloaded bundle does not satisfy the v4.4 read-only safety boundary."
}

$config = [ordered]@{
    name = "agentpool-v44-readonly"
    transport = "streamable-http"
    url = $bundle.remoteMcp
    chainId = 84532
    mode = "read-only"
    wallet = $null
    autoStart = $false
    scheduledTask = $false
    workspaceWrite = $false
}
$config | ConvertTo-Json -Depth 5 |
    Set-Content -LiteralPath $configPath -Encoding UTF8

Write-Output "AgentPool v4.4 read-only participant files installed at: $resolvedRoot"
Write-Output "No wallet was created. No scheduled task or background process was started."
Write-Output "MCP endpoint: $($bundle.remoteMcp)"
Write-Output "Status endpoint: $($bundle.status)"
Write-Output "Public reward-bearing writes remain disabled."
