[CmdletBinding()]
param(
    [string]$BaseUrl = "https://agentpool-protocol.asfu.chatgpt.site",
    [string]$InstallRoot = (Join-Path $env:LOCALAPPDATA "AgentPool-v44-readonly"),
    [switch]$EnableWrite,
    [switch]$UnsafeCustomMirror
)

$ErrorActionPreference = "Stop"
$officialOrigin = "https://agentpool-protocol.asfu.chatgpt.site"
$expectedBundleSha256 = "3b00865cf83167cdbd4c96ffaaa95093c216a9c566a47ed8777fba1f149f01e2"
$normalizedBaseUrl = $BaseUrl.TrimEnd("/")
if ($normalizedBaseUrl -ne $officialOrigin -and -not $UnsafeCustomMirror) {
    throw "Custom mirrors are blocked. Use the official AgentPool origin or explicitly pass -UnsafeCustomMirror for an exact-byte audit mirror."
}
$resolvedRoot = [System.IO.Path]::GetFullPath($InstallRoot)
$bundleUrl = "$normalizedBaseUrl/agentpool-v44-readonly-bundle.json"
$bundlePath = Join-Path $resolvedRoot "participant-bundle.json"
$downloadPath = Join-Path $resolvedRoot "participant-bundle.download"
$configPath = Join-Path $resolvedRoot "mcp-readonly.json"

if ($EnableWrite) {
    throw "AgentPool v4.4 public writes are not ready. Recovery targets, finalized anchors, independent custody, and reliability gates are still pending."
}

New-Item -ItemType Directory -Force -Path $resolvedRoot | Out-Null
Invoke-WebRequest -UseBasicParsing -Uri $bundleUrl -OutFile $downloadPath
if (-not (Test-Path -LiteralPath $downloadPath -PathType Leaf)) {
    throw "Read-only bundle download failed: $bundleUrl"
}
$actualBundleSha256 = (Get-FileHash -LiteralPath $downloadPath -Algorithm SHA256).Hash.ToLowerInvariant()
if ($actualBundleSha256 -ne $expectedBundleSha256) {
    Remove-Item -LiteralPath $downloadPath -Force -ErrorAction SilentlyContinue
    throw "Read-only bundle SHA-256 mismatch. No participant configuration was written."
}
Move-Item -LiteralPath $downloadPath -Destination $bundlePath -Force

$bundle = Get-Content -LiteralPath $bundlePath -Raw | ConvertFrom-Json
$expectedRemoteMcp = "$officialOrigin/api/mcp/v4.4"
if (
    $bundle.schema -ne "agentpool.v44.readonly-participant-bundle/v1" -or
    $bundle.bundleVersion -ne "0.13.0-readonly-alpha" -or
    [int]$bundle.chainId -ne 84532 -or
    $bundle.mode -ne "read-only" -or
    $bundle.remoteMcp -ne $expectedRemoteMcp -or
    [bool]$bundle.publicWriteReady -ne $false -or
    [bool]$bundle.walletCreated -ne $false -or
    [bool]$bundle.scheduledTaskCreated -ne $false -or
    [bool]$bundle.backgroundProcessStarted -ne $false
) {
    throw "The downloaded bundle does not satisfy the v4.4 read-only safety boundary."
}

$status = Invoke-RestMethod -Method Get -Uri "$normalizedBaseUrl/api/v4.4/status"
if (
    $status.release -ne $bundle.release -or
    [int]$status.chainId -ne 84532 -or
    [bool]$status.readiness.publicWriteReady -ne $false -or
    [bool]$status.provenance.complete -ne $true
) {
    throw "The v4.4 status endpoint does not provide complete read-only build provenance."
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
    participantBundleSha256 = $actualBundleSha256
    contractSourceCommit = $status.provenance.contractSourceCommit
    interfaceSourceCommit = $status.provenance.interfaceSourceCommit
    sourceTreeArchiveSha256 = $status.provenance.sourceTreeArchiveSha256
    siteDeploymentVersion = $status.provenance.siteDeploymentVersion
}
$config | ConvertTo-Json -Depth 5 |
    Set-Content -LiteralPath $configPath -Encoding UTF8

Write-Output "AgentPool v4.4 read-only participant files installed at: $resolvedRoot"
Write-Output "No wallet was created. No scheduled task or background process was started."
Write-Output "MCP endpoint: $($bundle.remoteMcp)"
Write-Output "Status endpoint: $($bundle.status)"
Write-Output "Public reward-bearing writes remain disabled."
