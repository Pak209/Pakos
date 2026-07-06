#!/bin/zsh
# PakOS launchd entrypoint. Resolves node via nvm (launchd has a bare PATH),
# then execs the server so launchd tracks the real PID.
set -euo pipefail

PROJECT_DIR="${PAKOS_DIR:-$HOME/Projects/PakOS}"
cd "$PROJECT_DIR"

export NVM_DIR="$HOME/.nvm"
if [ -s "$NVM_DIR/nvm.sh" ]; then
  source "$NVM_DIR/nvm.sh" --no-use
  nvm use default >/dev/null 2>&1 || nvm use node >/dev/null 2>&1
fi

if ! command -v node >/dev/null; then
  echo "FATAL: node not found (checked nvm at $NVM_DIR and PATH)" >&2
  exit 1
fi

echo "[run_pakos] $(date -Iseconds) starting with $(node --version) at $(command -v node)"
exec node server.js
