@echo off
setlocal enabledelayedexpansion

set "ROOT=%~dp0.."
set "VENV=%ROOT%\.venv"
set "PYTHON=%VENV%\Scripts\python.exe"

py -3.11 -c "import sys; assert sys.version_info[:2] == (3, 11)" >nul 2>nul
if errorlevel 1 (
  echo Python 3.11 not found. Attempting installation via winget...
  winget install --id Python.Python.3.11 -e --accept-package-agreements --accept-source-agreements
  if errorlevel 1 (
    echo Failed to install Python 3.11 automatically. Install Python 3.11 and rerun this script.
    exit /b 1
  )

  py -3.11 -c "import sys; assert sys.version_info[:2] == (3, 11)" >nul 2>nul
  if errorlevel 1 (
    echo Python 3.11 is still not available after installation. Restart shell and rerun setup.
    exit /b 1
  )
)

if not exist "%PYTHON%" (
  py -3.11 -m venv "%VENV%"
)

pushd "%ROOT%"
"%PYTHON%" -m pip install --upgrade pip
"%PYTHON%" -m pip install -e ".[dev]"
call "%VENV%\Scripts\activate.bat"
popd
