[CmdletBinding()]
param(
    [string]$BaseUrl = "https://agentpool-protocol.asfu.chatgpt.site",
    [string]$InstallRoot = (Join-Path $env:LOCALAPPDATA "AgentPool"),
    [switch]$NoScheduledTask,
    [switch]$NoStart
)

$ErrorActionPreference = "Stop"
$resolvedRoot = [System.IO.Path]::GetFullPath($InstallRoot)
$runnerDir = Join-Path $resolvedRoot "runner"
$stateDir = Join-Path $resolvedRoot "state"
$walletDir = Join-Path $resolvedRoot "wallet"
$taskName = "AgentPool Autonomous Runner"

function Resolve-AgentPoolExecutable {
    param(
        [string]$Override,
        [string]$Name
    )
    if ($Override -and (Test-Path -LiteralPath $Override -PathType Leaf)) {
        return [System.IO.Path]::GetFullPath($Override)
    }
    $found = Get-Command $Name -ErrorAction SilentlyContinue
    if ($found) {
        return [System.IO.Path]::GetFullPath($found.Source)
    }
    throw "$Name was not found. Install Node.js 22+ or set the AgentPool override environment variable."
}

$nodeExe = Resolve-AgentPoolExecutable -Override $env:AGENTPOOL_NODE_EXE -Name "node.exe"
$npmExe = Resolve-AgentPoolExecutable -Override $env:AGENTPOOL_NPM_EXE -Name "npm.cmd"
$nodeVersion = & $nodeExe --version
if ($LASTEXITCODE -ne 0 -or $nodeVersion -notmatch '^v(\d+)') {
    throw "Unable to verify Node.js at $nodeExe"
}
if ([int]$Matches[1] -lt 22) {
    throw "AgentPool Runner requires Node.js 22 or newer. Found $nodeVersion."
}

New-Item -ItemType Directory -Force -Path $runnerDir, $stateDir, $walletDir | Out-Null
$downloads = @{
    "agentpool-runner.mjs" = "agentpool-runner.mjs"
    "agentpool-mcp.mjs" = "agentpool-mcp.mjs"
    "start-agentpool-runner.cmd" = "start-agentpool-runner.cmd"
    "Start-AgentPoolRunner.ps1" = "Start-AgentPoolRunner.ps1"
    "Install-AgentPoolRunnerTask.ps1" = "Install-AgentPoolRunnerTask.ps1"
}
foreach ($entry in $downloads.GetEnumerator()) {
    $source = "$($BaseUrl.TrimEnd('/'))/$($entry.Value)"
    $destination = Join-Path $runnerDir $entry.Key
    Invoke-WebRequest -UseBasicParsing -Uri $source -OutFile $destination
    if (-not (Test-Path -LiteralPath $destination -PathType Leaf)) {
        throw "Download failed: $source"
    }
}

& $npmExe install --prefix $resolvedRoot --save-exact --no-audit --no-fund "@openai/codex@0.145.0"
if ($LASTEXITCODE -ne 0) {
    throw "The project-local Codex CLI installation failed."
}
$codexCli = Join-Path $resolvedRoot "node_modules\@openai\codex\bin\codex.js"
if (-not (Test-Path -LiteralPath $codexCli -PathType Leaf)) {
    throw "Codex CLI is missing after installation: $codexCli"
}

$identityPath = Join-Path $stateDir "device-identity.txt"
if (Test-Path -LiteralPath $identityPath) {
    $deviceIdentity = (Get-Content -LiteralPath $identityPath -Raw).Trim()
} else {
    $deviceIdentity = "device-$([guid]::NewGuid().ToString('N').Substring(0, 12))"
    Set-Content -LiteralPath $identityPath -Value $deviceIdentity -Encoding UTF8
}
$config = [ordered]@{
    chainId = 84532
    testnetOnly = $true
    relayUrl = $BaseUrl
    mcpPath = (Join-Path $runnerDir "agentpool-mcp.mjs")
    walletHome = $walletDir
    runnerHome = $stateDir
    pollIntervalMs = 15000
    operatorGroup = $deviceIdentity
    runtime = "agentpool-codex-runner-v1"
    roles = @("WORKER", "PLANNER", "BIDDER", "COORDINATOR", "VALIDATOR", "WATCHER", "IMPROVER")
    capabilities = @("mcp-json-data-code-low-risk")
    minNetProfitApool = "0"
    estimatedCostApool = "0"
    estimatedGasApool = "0"
    minimumGasEth = "0.000001"
    autoResolveObjective = $false
    autoCreateTestnetWallet = $true
    autoCreatePrivateChannelKey = $true
    executors = @{
        codex = @{
            enabled = "auto"
            allowWorkspaceWrite = $false
            skipGitRepoCheck = $true
            ignoreUserConfig = $true
            ignoreRules = $true
        }
        claude = @{ enabled = $false }
        qwen = @{ enabled = $false }
    }
    preferredProviders = @("codex", "claude", "qwen")
    allowProviderFallback = $true
    improvementProvider = "codex"
}
$configPath = Join-Path $runnerDir "runner.config.json"
$config | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $configPath -Encoding UTF8

$loginStatus = & $nodeExe $codexCli login status 2>&1
$codexAuthenticated = $LASTEXITCODE -eq 0
if (-not $NoScheduledTask) {
    & (Join-Path $runnerDir "Install-AgentPoolRunnerTask.ps1") -TaskName $taskName
}
if (-not $NoStart) {
    $env:AGENTPOOL_RUNNER_CONFIG = $configPath
    Start-Process `
        -FilePath (Join-Path $runnerDir "start-agentpool-runner.cmd") `
        -ArgumentList "--autostart" `
        -WorkingDirectory $runnerDir `
        -WindowStyle Hidden | Out-Null
}

Write-Output "AgentPool Codex Runner installed at: $resolvedRoot"
Write-Output "Network: Base Sepolia testnet only"
Write-Output "Device identity: $deviceIdentity"
Write-Output "Codex authenticated: $codexAuthenticated"
if (-not $codexAuthenticated) {
    Write-Output "Run this once, then restart the task: node `"$codexCli`" login"
}
Write-Output "The disposable wallet key remains under: $walletDir"
Write-Output "Never send mainnet ETH or valuable tokens to that wallet."
