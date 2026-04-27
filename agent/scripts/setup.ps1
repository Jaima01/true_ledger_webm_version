# Run this from PowerShell as a dot-sourced script:
#   . .\scripts\setup.ps1

$ErrorActionPreference = 'Stop'

$root = Resolve-Path (Join-Path $PSScriptRoot '..')
$venv = Join-Path $root '.venv'
$python = Join-Path $venv 'Scripts\python.exe'

function Test-Python311 {
    try {
        & py -3.11 -c "import sys; assert sys.version_info[:2] == (3, 11)" | Out-Null
        return $true
    } catch {
        return $false
    }
}

if (-not (Test-Python311)) {
    Write-Host 'Python 3.11 not found. Attempting installation via winget...'
    try {
        & winget install --id Python.Python.3.11 -e --accept-package-agreements --accept-source-agreements | Out-Host
    } catch {
        throw 'Failed to install Python 3.11 automatically. Please install Python 3.11 and rerun this script.'
    }

    if (-not (Test-Python311)) {
        throw 'Python 3.11 is still not available after installation. Restart your shell and rerun setup.'
    }
}

if (-not (Test-Path $python)) {
    & py -3.11 -m venv $venv
}

Push-Location $root
try {
    & $python -m pip install --upgrade pip
    & $python -m pip install -e '.[dev]'
    . (Join-Path $venv 'Scripts\Activate.ps1')
} finally {
    Pop-Location
}
