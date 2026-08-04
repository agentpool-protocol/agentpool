[CmdletBinding()]
param(
    [switch]$Once,
    [switch]$Autostart,
    [switch]$LauncherSmoke
)

$ErrorActionPreference = "Stop"
$runnerDir = $PSScriptRoot
$projectRoot = [System.IO.Path]::GetFullPath((Join-Path $runnerDir ".."))
$runnerScript = Join-Path $runnerDir "agentpool-runner.mjs"
$runnerHome = if ($env:AGENTPOOL_RUNNER_HOME) {
    [System.IO.Path]::GetFullPath($env:AGENTPOOL_RUNNER_HOME)
} else {
    Join-Path $env:LOCALAPPDATA "AgentPool\Runner"
}
$logDir = Join-Path $runnerHome "logs"
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$stdoutLog = Join-Path $logDir "runner.stdout.log"
$stderrLog = Join-Path $logDir "runner.stderr.log"

function Resolve-AgentPoolNode {
    $candidates = @()
    if ($env:AGENTPOOL_NODE_EXE) {
        $candidates += $env:AGENTPOOL_NODE_EXE
    }
    $candidates += (Join-Path $projectRoot "tools\node\node.exe")
    $candidates += (Join-Path (Split-Path $projectRoot -Parent) "tools\node\node.exe")
    $pathNode = Get-Command node.exe -ErrorAction SilentlyContinue
    if ($pathNode) {
        $candidates += $pathNode.Source
    }
    $registryRoots = @(
        "HKLM:\SOFTWARE\Node.js",
        "HKLM:\SOFTWARE\WOW6432Node\Node.js"
    )
    foreach ($registryRoot in $registryRoots) {
        if (Test-Path -LiteralPath $registryRoot) {
            $installPath = (Get-ItemProperty -LiteralPath $registryRoot).InstallPath
            if ($installPath) {
                $candidates += (Join-Path $installPath "node.exe")
            }
        }
    }
    foreach ($candidate in $candidates) {
        if ($candidate -and (Test-Path -LiteralPath $candidate -PathType Leaf)) {
            return [System.IO.Path]::GetFullPath($candidate)
        }
    }
    throw "Node.js was not found. Set AGENTPOOL_NODE_EXE or install Node.js 22+."
}

$nodeExe = Resolve-AgentPoolNode
$nodeVersion = & $nodeExe --version
if ($LASTEXITCODE -ne 0 -or $nodeVersion -notmatch '^v(\d+)') {
    throw "Unable to verify Node.js at $nodeExe"
}
if ([int]$Matches[1] -lt 22) {
    throw "AgentPool Runner requires Node.js 22 or newer. Found $nodeVersion."
}
if (-not (Test-Path -LiteralPath $runnerScript -PathType Leaf)) {
    throw "Runner entrypoint is missing: $runnerScript"
}

if ($LauncherSmoke) {
    $arguments = @(Join-Path $runnerDir "launcher-smoke.mjs")
} else {
    $arguments = @($runnerScript)
    if ($Once) {
        $arguments += "--once"
    }
}

$process = Start-Process `
    -FilePath $nodeExe `
    -ArgumentList $arguments `
    -WorkingDirectory $projectRoot `
    -RedirectStandardOutput $stdoutLog `
    -RedirectStandardError $stderrLog `
    -WindowStyle Hidden `
    -PassThru

Start-Sleep -Milliseconds 1500
if ($process.HasExited) {
    $process.WaitForExit()
    if ($Once -and $process.ExitCode -eq 0) {
        Write-Output "AgentPool Runner completed one cycle successfully."
        Write-Output "stdout: $stdoutLog"
        Write-Output "stderr: $stderrLog"
        exit 0
    }
    $tail = if (Test-Path -LiteralPath $stderrLog) {
        (Get-Content -LiteralPath $stderrLog -Tail 20) -join [Environment]::NewLine
    } else {
        "(no stderr log)"
    }
    throw "Runner exited during startup with code $($process.ExitCode).`n$tail`nLog: $stderrLog"
}

Write-Output "AgentPool Runner started. PID=$($process.Id)"
Write-Output "stdout: $stdoutLog"
Write-Output "stderr: $stderrLog"

if ($LauncherSmoke) {
    Stop-Process -Id $process.Id
    $process.WaitForExit()
    exit 0
}

$process.WaitForExit()
exit $process.ExitCode
