#Requires -Version 5.1
[CmdletBinding()]
param(
    [ValidateSet('open', 'unlock', 'all')]
    [string]$Variant = 'all'
)

$ErrorActionPreference = 'Stop'
$previousPath = $env:PATH
$outDir = 'C:\Users\admin\OneDrive\Desktop\H bot 安装包'

function Clear-BundledCredit {
    $src = Join-Path $PSScriptRoot 'app\src'
    foreach ($name in @('bundled-credit-envelope.json', 'bundled-credit-open-wrap.json')) {
        $p = Join-Path $src $name
        if (Test-Path -LiteralPath $p) { Remove-Item -LiteralPath $p -Force }
    }
}

function Invoke-Pack([string]$Name) {
    $config = if ($Name -eq 'open') { 'electron-builder.open.yml' } else { 'electron-builder.unlock.yml' }
    Clear-BundledCredit
    Push-Location (Join-Path $PSScriptRoot 'app')
    try {
        & node $script:builder --win nsis --x64 --publish never --config $config --config.electronDist=node_modules/electron/dist
        if ($LASTEXITCODE -ne 0) { throw "EXE build failed for $Name ($LASTEXITCODE)." }
        $dist = Join-Path (Get-Location) 'dist-pack'
        & node (Join-Path $PSScriptRoot 'app/scripts/check-packed-ssh.mjs') (Join-Path $dist 'win-unpacked')
        if ($LASTEXITCODE -ne 0) { throw "Packed SSH dependencies are incomplete for $Name." }
        $version = (Get-Content -LiteralPath (Join-Path $PSScriptRoot 'app/package.json') -Raw | ConvertFrom-Json).version
        $fileName = if ($Name -eq 'open') { "H-bot-$version-win-x64.exe" } else { "H-bot-$version-校验版-win-x64.exe" }
        $exe = Get-Item -LiteralPath (Join-Path $dist $fileName)
        New-Item -ItemType Directory -Force -Path $outDir | Out-Null
        $destination = Join-Path $outDir $exe.Name
        Copy-Item -LiteralPath $exe.FullName -Destination $destination -Force
        if ((Get-FileHash -LiteralPath $exe.FullName).Hash -ne (Get-FileHash -LiteralPath $destination).Hash) {
            throw 'Installer copy verification failed; keeping previous installers.'
        }
        if ($Name -eq 'open') {
            # Keep the previous installer until the new copy has passed its integrity check.
            Get-ChildItem -LiteralPath $outDir -File | Where-Object {
                $_.Name -match '^H-bot-.+-win-x64\.exe$' -and $_.FullName -ne $destination
            } | ForEach-Object { Remove-Item -LiteralPath $_.FullName -Force }
        }
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
    Clear-BundledCredit
} finally { $env:PATH = $previousPath }
