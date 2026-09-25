$ErrorActionPreference = 'Stop'

try {
    $root = Split-Path -Parent $PSScriptRoot
    $cli = Join-Path $root 'apps\cli\dist\src\index.js'
    if (-not (Test-Path -LiteralPath $cli -PathType Leaf)) {
        throw 'Build MCPex first: npm run build'
    }
    $node = (Get-Command node.exe -ErrorAction Stop).Source
    $port = if ($env:MCPEX_PORT) { [int]::Parse($env:MCPEX_PORT) } else { 47831 }
    if ($env:MCPEX_URL) {
        $url = [Uri]$env:MCPEX_URL
        if ($url.Scheme -ne 'http' -or $url.Host -notin @('127.0.0.1', 'localhost') -or
            $url.Port -ne $port -or $url.AbsolutePath -ne '/' -or $url.Query -or $url.Fragment) {
            throw 'Restart supports only the configured local MCPex service. No process was stopped.'
        }
    }
    $dataDir = if ($env:MCPEX_DATA_DIR) { $env:MCPEX_DATA_DIR } else { Join-Path $env:LOCALAPPDATA 'MCPex' }
    $lock = Join-Path $dataDir 'service.lock'
    $listeners = @(netstat -ano -p TCP | Where-Object { $_ -match "^\s*TCP\s+127\.0\.0\.1:${port}\s+\S+\s+LISTENING\s+(\d+)\s*$" } | ForEach-Object { [int]([regex]::Match($_, '(\d+)\s*$').Groups[1].Value) })

    if (Test-Path -LiteralPath $lock -PathType Leaf) {
        $owner = Get-Content -LiteralPath $lock -Raw | ConvertFrom-Json
        if ($owner.version -ne 1 -or -not $owner.pid -or -not $owner.processStartedAt -or -not $owner.executable -or -not $owner.token) {
            throw 'Service lock has an unknown format. No process was stopped.'
        }
        $service = Get-Process -Id $owner.pid -ErrorAction SilentlyContinue
        if ($service) {
            $expectedStart = [DateTimeOffset]::Parse($owner.processStartedAt).UtcDateTime
            $actualStart = $service.StartTime.ToUniversalTime()
            $sameStart = [Math]::Abs(($actualStart - $expectedStart).TotalSeconds) -le 2
            $sameExecutable = $service.Path -and [string]::Equals(
                [IO.Path]::GetFullPath($service.Path),
                [IO.Path]::GetFullPath($owner.executable),
                [StringComparison]::OrdinalIgnoreCase
            )
            if ($sameStart -and $sameExecutable) {
                if ($listeners.Count -ne 1 -or $listeners[0] -ne $owner.pid) {
                    throw 'Service lock owner does not own the local MCPex port. No process was stopped.'
                }
                $health = Invoke-RestMethod -Uri "http://127.0.0.1:$port/health" -TimeoutSec 3
                if ($health.service -ne 'mcpex' -or $health.status -ne 'ok') { throw 'Local port is not a ready MCPex service. No process was stopped.' }
                Stop-Process -Id $owner.pid -ErrorAction Stop
                $stopDeadline = (Get-Date).AddSeconds(20)
                do {
                    $remaining = Get-Process -Id $owner.pid -ErrorAction SilentlyContinue
                    if (-not $remaining -or [Math]::Abs(($remaining.StartTime.ToUniversalTime() - $expectedStart).TotalSeconds) -gt 2) { break }
                    Start-Sleep -Milliseconds 200
                } while ((Get-Date) -lt $stopDeadline)
                if ($remaining -and [Math]::Abs(($remaining.StartTime.ToUniversalTime() - $expectedStart).TotalSeconds) -le 2) {
                    throw 'MCPex service did not stop. No new service was started.'
                }
            }
        }
    } elseif ($listeners.Count -gt 0) {
        throw 'A service is using the MCPex port without a matching lock. No process was stopped.'
    }

    $started = Start-Process -FilePath $node -ArgumentList @("`"$cli`"", 'serve') -WindowStyle Hidden -PassThru
    $deadline = (Get-Date).AddSeconds(20)
    do {
        if ($started.HasExited) { throw "MCPex service exited during startup (exit $($started.ExitCode))." }
        try {
            $health = Invoke-RestMethod -Uri "http://127.0.0.1:$port/health" -TimeoutSec 2
            $newOwner = Get-Content -LiteralPath $lock -Raw | ConvertFrom-Json
            if ($health.service -eq 'mcpex' -and $health.status -eq 'ok' -and $newOwner.pid -eq $started.Id) {
                Write-Host "MCPex service ready (PID $($started.Id))."
                exit 0
            }
        } catch {}
        Start-Sleep -Milliseconds 200
    } while ((Get-Date) -lt $deadline)
    throw 'MCPex service did not become ready within 20 seconds.'
} catch {
    Write-Host "MCPex restart failed: $($_.Exception.Message)" -ForegroundColor Red
    exit 1
}
