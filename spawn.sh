#!/usr/bin/env bash
# Executed by `agent worker controller --spawn ./spawn.sh`
# (or `cursor-agent worker controller --spawn ./spawn.sh`).
# Submits one Lambda MicroVM and returns immediately.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export PATH="${ROOT}/node_modules/.bin:${PATH}"
if command -v tsx >/dev/null 2>&1; then
  exec tsx "${ROOT}/src/spawn.ts"
fi
exec npx --yes tsx "${ROOT}/src/spawn.ts"
