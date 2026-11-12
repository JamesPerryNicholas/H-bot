#Requires -Version 5.1
[CmdletBinding()]
param(
    [string]$DataRoot = (Join-Path $PSScriptRoot '.ds-bot-local'),
    [switch]$PrepareOnly
)

$ErrorActionPreference = 'Stop'
$previousPath = $env:PATH
$previousMirror = $env:ELECTRON_MIRROR
try {
    $localNode = Join-Path $PSScriptRoot '.tools/node'
    if (Test-Path -LiteralPath (Join-Path $localNode 'node.exe')) {
        $env:PATH = $localNode + [IO.Path]::PathSeparator + $env:PATH
    }
    $mirrorFile = Join-Path $PSScriptRoot '.tools/electron-mirror.txt'
    if (-not $env:ELECTRON_MIRROR -and (Test-Path -LiteralPath $mirrorFile)) {
        $env:ELECTRON_MIRROR = (Get-Content -LiteralPath $mirrorFile -Raw).Trim()
    }
    $versionText = & node -p 'process.versions.node'
    if ($LASTEXITCODE -ne 0 -or [version]$versionText -lt [version]'24.9.0') {
        throw 'The pinned DSH requires Node.js 24.9.0 or later. Install it before launching.'
    }
    & (Join-Path $PSScriptRoot 'start.ps1') -DataRoot $DataRoot -PrepareOnly:$PrepareOnly
} finally {
    $env:PATH = $previousPath
    if ($null -eq $previousMirror) { Remove-Item Env:ELECTRON_MIRROR -ErrorAction SilentlyContinue }
    else { $env:ELECTRON_MIRROR = $previousMirror }
}
