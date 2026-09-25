$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$tempRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath())
$dataDir = Join-Path $tempRoot ('mcpex-restart-test-' + [guid]::NewGuid().ToString('N'))
$previousDataDir = $env:MCPEX_DATA_DIR
$previousPort = $env:MCPEX_PORT
$previousUrl = $env:MCPEX_URL
$owners = @()

try {
    New-Item -ItemType Directory -Path $dataDir | Out-Null
    $listener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, 0)
    $listener.Start()
    $port = ([Net.IPEndPoint]$listener.LocalEndpoint).Port
    $listener.Stop()
    $env:MCPEX_DATA_DIR = $dataDir
    $env:MCPEX_PORT = [string]$port
    Remove-Item Env:MCPEX_URL -ErrorAction SilentlyContinue

    foreach ($attempt in 1..2) {
        & (Join-Path $root 'MCPex Restart.bat')
        if ($LASTEXITCODE -ne 0) { throw "Restart attempt $attempt failed." }
        $owner = Get-Content -LiteralPath (Join-Path $dataDir 'service.lock') -Raw | ConvertFrom-Json
        $owners += $owner
        $health = Invoke-RestMethod -Uri "http://127.0.0.1:$port/health" -TimeoutSec 5
        if ($health.service -ne 'mcpex' -or $health.status -ne 'ok') { throw "Health check $attempt failed." }
    }
    if ($owners[0].pid -eq $owners[1].pid) { throw 'Service PID did not change.' }
    Write-Host "Restart smoke test passed: $($owners[0].pid) -> $($owners[1].pid)."
} finally {
    foreach ($owner in $owners) {
        $process = Get-Process -Id $owner.pid -ErrorAction SilentlyContinue
        if ($process -and [Math]::Abs(($process.StartTime.ToUniversalTime() - [DateTimeOffset]::Parse($owner.processStartedAt).UtcDateTime).TotalSeconds) -le 2) {
            Stop-Process -Id $owner.pid -ErrorAction SilentlyContinue
        }
    }
    $deadline = (Get-Date).AddSeconds(10)
    while (($owners | Where-Object { Get-Process -Id $_.pid -ErrorAction SilentlyContinue }) -and (Get-Date) -lt $deadline) {
        Start-Sleep -Milliseconds 200
    }
    if ([IO.Path]::GetFullPath($dataDir).StartsWith($tempRoot, [StringComparison]::OrdinalIgnoreCase) -and (Test-Path -LiteralPath $dataDir)) {
        Remove-Item -LiteralPath $dataDir -Recurse -Force
    }
    $env:MCPEX_DATA_DIR = $previousDataDir
    $env:MCPEX_PORT = $previousPort
    $env:MCPEX_URL = $previousUrl
}
