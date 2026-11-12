#Requires -Version 5.1
[CmdletBinding()]
param(
    [ValidateSet('open', 'unlock', 'all')]
    [string]$Variant = 'all'
)

$ErrorActionPreference = 'Stop'
$previousPath = $env:PATH
$keyFile = $env:HBOT_OPENAI_KEY_FILE
if (-not $keyFile) { $keyFile = 'C:\Users\admin\agent-tools\hbot-credit\secrets\openai-key.txt' }
$codesFile = $env:HBOT_UNLOCK_CODES_FILE
if (-not $codesFile) { $codesFile = 'C:\Users\admin\agent-tools\hbot-credit\secrets\unlock-codes.txt' }
$outDir = 'C:\Users\admin\OneDrive\Desktop\H bot 安装包'

function Invoke-Pack([string]$Name) {
    $config = if ($Name -eq 'open') { 'electron-builder.open.yml' } else { 'electron-builder.unlock.yml' }
    $seal = Join-Path $PSScriptRoot 'app\scripts\seal-bundled-credit.mjs'
    if ($Name -eq 'open') {
        & node $seal open $keyFile
    } else {
        & node $seal unlock $keyFile $codesFile
    }
    if ($LASTEXITCODE -ne 0) { throw "Sealing $Name credit failed ($LASTEXITCODE)." }
    Push-Location (Join-Path $PSScriptRoot 'app')
    try {
        & node $script:builder --win nsis --x64 --publish never --config $config --config.electronDist=node_modules/electron/dist
        if ($LASTEXITCODE -ne 0) { throw "EXE build failed for $Name ($LASTEXITCODE)." }
        $dist = Join-Path (Get-Location) 'dist-pack'
        $pattern = if ($Name -eq 'open') { 'H-bot-*-开放版-win-x64.exe' } else { 'H-bot-*-校验版-win-x64.exe' }
        $exe = Get-ChildItem -LiteralPath $dist -Filter $pattern | Sort-Object LastWriteTime -Descending | Select-Object -First 1
        if (-not $exe) { throw "Packed $Name installer was not found in $dist" }
        New-Item -ItemType Directory -Force -Path $outDir | Out-Null
        Copy-Item -LiteralPath $exe.FullName -Destination (Join-Path $outDir $exe.Name) -Force
        Write-Host "copied $($exe.Name) to $outDir"
    } finally { Pop-Location }
}

try {
    $localNode = Join-Path $PSScriptRoot '.tools/node'
    if (Test-Path -LiteralPath (Join-Path $localNode 'node.exe')) {
        $env:PATH = $localNode + [IO.Path]::PathSeparator + $env:PATH
    }
    & (Join-Path $PSScriptRoot 'dev.ps1') -PrepareOnly
    $script:builder = Join-Path $PSScriptRoot 'app/node_modules/electron-builder/out/cli/cli.js'
    $names = if ($Variant -eq 'all') { @('open', 'unlock') } else { @($Variant) }
    foreach ($name in $names) { Invoke-Pack $name }
    $seal = Join-Path $PSScriptRoot 'app\scripts\seal-bundled-credit.mjs'
    & node $seal unlock $keyFile $codesFile
    if ($LASTEXITCODE -ne 0) { throw "Restoring the unlock envelope in source failed ($LASTEXITCODE)." }
} finally { $env:PATH = $previousPath }
