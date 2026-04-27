@echo off
setlocal enabledelayedexpansion

set "ROOT=%~dp0.."
set "VENV=%ROOT%\.venv"
set "PYTHON=%VENV%\Scripts\python.exe"
set "AGENT=%ROOT%\agent"
set "EXTENSION=%ROOT%\extension"

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
"%PYTHON%" -m pip install -e "%AGENT%[dev]"

if exist "%EXTENSION%\package.json" (
  where npm >nul 2>nul
  if errorlevel 1 (
    echo npm is required to install extension dependencies. Install Node.js and rerun setup.
    popd
    exit /b 1
  )

  pushd "%EXTENSION%"
  if exist "package-lock.json" (
    call npm ci
  ) else (
    call npm install
  )
  if errorlevel 1 (
    popd
    popd
    exit /b 1
  )
  call npm run build
  if errorlevel 1 (
    popd
    popd
    exit /b 1
  )
  popd
)

call "%VENV%\Scripts\activate.bat"
popd
