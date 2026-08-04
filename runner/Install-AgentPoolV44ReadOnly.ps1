[CmdletBinding()]
param(
    [string]$BaseUrl = "https://agentpool-protocol.asfu.chatgpt.site",
    [string]$InstallRoot = (Join-Path $env:LOCALAPPDATA "AgentPool-v44-readonly"),
    [switch]$EnableWrite,
    [switch]$UnsafeCustomMirror
)

$ErrorActionPreference = "Stop"
$officialOrigin = "https://agentpool-protocol.asfu.chatgpt.site"
$expectedBundleSha256 = "e354b4e967a7663a55f58afa06d2e4dfbed945d878717dec9f1d67766e9174e8"
$normalizedBaseUrl = $BaseUrl.TrimEnd("/")
if ($normalizedBaseUrl -ne $officialOrigin -and -not $UnsafeCustomMirror) {
    throw "Custom mirrors are blocked. Use the official AgentPool origin or explicitly pass -UnsafeCustomMirror for an exact-byte audit mirror."
}

function Get-Sha256Hex {
    param([Parameter(Mandatory = $true)][string]$LiteralPath)

    $stream = [System.IO.File]::OpenRead($LiteralPath)
    $sha256 = [System.Security.Cryptography.SHA256]::Create()
    try {
        $digest = $sha256.ComputeHash($stream)
        return ([System.BitConverter]::ToString($digest)).Replace("-", "").ToLowerInvariant()
    }
    finally {
        $sha256.Dispose()
        $stream.Dispose()
    }
}

$resolvedRoot = [System.IO.Path]::GetFullPath($InstallRoot)
$bundleUrl = "$normalizedBaseUrl/agentpool-v44-readonly-bundle.json"
$bundlePath = Join-Path $resolvedRoot "participant-bundle.json"
$downloadPath = Join-Path $resolvedRoot "participant-bundle.download"
$configPath = Join-Path $resolvedRoot "mcp-readonly.json"
$buildManifestPath = Join-Path $resolvedRoot "interface-build-manifest.json"

if ($EnableWrite) {
    throw "AgentPool v4.4 public writes are not ready. Recovery targets, finalized anchors, independent custody, and reliability gates are still pending."
}

New-Item -ItemType Directory -Force -Path $resolvedRoot | Out-Null
Invoke-WebRequest -UseBasicParsing -Uri $bundleUrl -OutFile $downloadPath
if (-not (Test-Path -LiteralPath $downloadPath -PathType Leaf)) {
    throw "Read-only bundle download failed: $bundleUrl"
}
$actualBundleSha256 = Get-Sha256Hex -LiteralPath $downloadPath
if ($actualBundleSha256 -ne $expectedBundleSha256) {
    if ([System.IO.File]::Exists($downloadPath)) {
        [System.IO.File]::Delete($downloadPath)
    }
    throw "Read-only bundle SHA-256 mismatch. No participant configuration was written."
}
if ([System.IO.File]::Exists($bundlePath)) {
    [System.IO.File]::Delete($bundlePath)
}
[System.IO.File]::Move($downloadPath, $bundlePath)

$bundle = Get-Content -LiteralPath $bundlePath -Raw | ConvertFrom-Json
$expectedRemoteMcp = "$officialOrigin/api/mcp/v4.4"
if (
    $bundle.schema -ne "agentpool.v44.readonly-participant-bundle/v1" -or
    $bundle.bundleVersion -ne "0.14.0-staged-evidence-alpha" -or
    [int]$bundle.chainId -ne 84532 -or
    $bundle.mode -ne "read-only" -or
    $bundle.remoteMcp -ne $expectedRemoteMcp -or
    $bundle.discovery -ne "$officialOrigin/api/v4.4/discovery" -or
    [bool]$bundle.publicWriteReady -ne $false -or
    [bool]$bundle.walletCreated -ne $false -or
    [bool]$bundle.scheduledTaskCreated -ne $false -or
    [bool]$bundle.backgroundProcessStarted -ne $false
) {
    throw "The downloaded bundle does not satisfy the v4.4 read-only safety boundary."
}

$statusResponse = Invoke-WebRequest -UseBasicParsing -Method Get -Uri "$normalizedBaseUrl/api/v4.4/status"
$status = $statusResponse.Content | ConvertFrom-Json
if (
    $status.release -ne $bundle.release -or
    [int]$status.chainId -ne 84532 -or
    [bool]$status.readiness.publicWriteReady -ne $false -or
    [bool]$status.provenance.complete -ne $true -or
    $statusResponse.Headers["x-agentpool-provenance-status"] -ne $status.provenance.status -or
    $statusResponse.Headers["x-agentpool-interface-commit"] -ne $status.provenance.interfaceSourceCommit -or
    $statusResponse.Headers["x-agentpool-site-deployment-version"] -ne $status.provenance.siteDeploymentVersion -or
    $statusResponse.Headers["x-agentpool-build-manifest-sha256"] -ne $status.provenance.buildManifestSha256 -or
    $statusResponse.Headers["x-agentpool-build-manifest-file-sha256"] -ne $status.provenance.buildManifestFileSha256 -or
    $statusResponse.Headers["x-agentpool-source-tree-root"] -ne $status.provenance.sourceTreeManifestRoot
) {
    throw "The v4.4 status endpoint does not provide complete read-only build provenance."
}

Invoke-WebRequest -UseBasicParsing -Uri "$normalizedBaseUrl/agentpool-v44-build-manifest.json" -OutFile $buildManifestPath
$actualBuildManifestFileSha256 = Get-Sha256Hex -LiteralPath $buildManifestPath
$buildManifest = Get-Content -LiteralPath $buildManifestPath -Raw | ConvertFrom-Json
if (
    $actualBuildManifestFileSha256 -ne $status.provenance.buildManifestFileSha256 -or
    $buildManifest.buildManifestSha256 -ne $status.provenance.buildManifestSha256 -or
    $buildManifest.interfaceSourceCommit -ne $status.provenance.interfaceSourceCommit -or
    $buildManifest.siteBuildCommit -ne $status.provenance.siteBuildCommit -or
    $buildManifest.sourceTreeManifestRoot -ne $status.provenance.sourceTreeManifestRoot
) {
    Remove-Item -LiteralPath $buildManifestPath -Force -ErrorAction SilentlyContinue
    throw "The deployed interface build manifest does not match the signed runtime provenance fields."
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
    sourceTreeManifestRoot = $status.provenance.sourceTreeManifestRoot
    buildManifestSha256 = $status.provenance.buildManifestSha256
    buildManifestFileSha256 = $actualBuildManifestFileSha256
    siteDeploymentVersion = $status.provenance.siteDeploymentVersion
}
$config | ConvertTo-Json -Depth 5 |
    Set-Content -LiteralPath $configPath -Encoding UTF8

Write-Output "AgentPool v4.4 read-only participant files installed at: $resolvedRoot"
Write-Output "No wallet was created. No scheduled task or background process was started."
Write-Output "MCP endpoint: $($bundle.remoteMcp)"
Write-Output "Status endpoint: $($bundle.status)"
Write-Output "Public reward-bearing writes remain disabled."
