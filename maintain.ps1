#Requires -Version 5.1
[CmdletBinding()]
param(
    [ValidateSet('check', 'snapshot')]
    [string]$Action = 'check'
)

$ErrorActionPreference = 'Stop'
$previousPath = $env:PATH
try {
    $maintenanceNode = Join-Path $PSScriptRoot '.tools/node/node.exe'
    if (-not (Test-Path -LiteralPath $maintenanceNode)) {
        $maintenanceNode = (Get-Command node -ErrorAction Stop).Source
    }
    $env:PATH = (Split-Path -Parent $maintenanceNode) + [IO.Path]::PathSeparator + $env:PATH
    & $maintenanceNode (Join-Path $PSScriptRoot 'scripts/local-maintenance.mjs') $Action
    if ($LASTEXITCODE -ne 0) { throw "H bot maintenance failed ($LASTEXITCODE). See the reported local log." }
} finally {
    $env:PATH = $previousPath
}
