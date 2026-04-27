#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VENV_DIR="$ROOT_DIR/.venv"
PYTHON_BIN="$VENV_DIR/bin/python"
PYTHON311_BIN=""
EXTENSION_DIR="$ROOT_DIR/extension"

resolve_python311() {
  if command -v python3.11 >/dev/null 2>&1; then
    command -v python3.11
    return 0
  fi

  if [[ "$OSTYPE" == darwin* ]] && command -v brew >/dev/null 2>&1; then
    local brew_python
    brew_python="$(brew --prefix python@3.11 2>/dev/null || true)"
    if [[ -n "$brew_python" && -x "$brew_python/bin/python3.11" ]]; then
      printf '%s\n' "$brew_python/bin/python3.11"
      return 0
    fi
  fi

  return 1
}

ensure_python311() {
  if command -v python3.11 >/dev/null 2>&1; then
    return 0
  fi

  echo "Python 3.11 not found. Attempting auto-install..."
  if [[ "$OSTYPE" == darwin* ]]; then
    if command -v brew >/dev/null 2>&1; then
      brew install python@3.11
      return 0
    fi
    echo "Homebrew is required to auto-install Python 3.11 on macOS." >&2
    return 1
  fi

  if command -v apt-get >/dev/null 2>&1; then
    sudo apt-get update
    sudo apt-get install -y python3.11 python3.11-venv
    return 0
  fi

  if command -v dnf >/dev/null 2>&1; then
    sudo dnf install -y python3.11
    return 0
  fi

  if command -v yum >/dev/null 2>&1; then
    sudo yum install -y python3.11
    return 0
  fi

  echo "Unsupported Linux package manager for auto-install." >&2
  return 1
}

if ! ensure_python311; then
  echo "Install Python 3.11 manually, then rerun this script." >&2
  exit 1
fi

PYTHON311_BIN="$(resolve_python311 || true)"
if [[ -z "$PYTHON311_BIN" ]]; then
  echo "Python 3.11 is not available on PATH after installation." >&2
  exit 1
fi

if [[ ! -x "$PYTHON_BIN" ]]; then
  "$PYTHON311_BIN" -m venv "$VENV_DIR"
fi

"$PYTHON_BIN" -m pip install --upgrade pip
"$PYTHON_BIN" -m pip install -e "$ROOT_DIR/agent[dev]"

if [[ -f "$EXTENSION_DIR/package.json" ]]; then
  if ! command -v npm >/dev/null 2>&1; then
    echo "npm is required to install extension dependencies. Install Node.js and rerun setup." >&2
    exit 1
  fi
  pushd "$EXTENSION_DIR" >/dev/null
  if [[ -f "package-lock.json" ]]; then
    npm ci
  else
    npm install
  fi
  npm run build
  popd >/dev/null
fi

# shellcheck disable=SC1091
source "$VENV_DIR/bin/activate"
