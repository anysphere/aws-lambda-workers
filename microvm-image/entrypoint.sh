#!/usr/bin/env bash
# Clone if needed, then exec cursor-agent worker start --pool.
set -euo pipefail
export GIT_TERMINAL_PROMPT=0
export PATH="/root/.cursor/bin:/root/.local/bin:/usr/local/bin:${PATH}"

if [[ -z "${CURSOR_API_KEY:-}" && -n "${CURSOR_API_KEY_PARAM_NAME:-}" ]]; then
  CURSOR_API_KEY="$(aws ssm get-parameter --name "${CURSOR_API_KEY_PARAM_NAME}" --with-decryption --query Parameter.Value --output text)"
  export CURSOR_API_KEY
fi
if [[ -z "${CURSOR_API_KEY:-}" ]]; then
  echo "FATAL: set CURSOR_API_KEY or CURSOR_API_KEY_PARAM_NAME" >&2
  exit 1
fi

POOL_NAME="${POOL_NAME:-${CURSOR_POOL:-default}}"
IDLE_RELEASE_TIMEOUT_SECONDS="${IDLE_RELEASE_TIMEOUT_SECONDS:-300}"
WORKSPACES="${WORKSPACES:-/opt/cursor/workspaces}"
REPO_URL="${REPO_URL:-${CURSOR_REPO_URL:-}}"
mkdir -p "${WORKSPACES}"
dest="${WORKSPACES}/workspace"

if [[ -n "${REPO_URL}" ]]; then
  dest="${WORKSPACES}/$(basename "${REPO_URL}" .git)"
  if [[ -d "${dest}/.git" ]]; then
    git -C "${dest}" fetch --all --prune --tags || true
  else
    git clone --filter=blob:none --single-branch "${REPO_URL}" "${dest}"
  fi
elif [[ ! -d "${dest}/.git" ]]; then
  mkdir -p "${dest}"
  git -C "${dest}" init
  git -C "${dest}" config user.email "worker@local"
  git -C "${dest}" config user.name "cursor-worker"
  git -C "${dest}" commit --allow-empty -m "workspace"
fi

cd "${dest}"
AGENT_BIN="$(command -v cursor-agent || command -v agent)"
NAME_ARGS=()
if [[ -n "${CURSOR_WORKER_NAME:-}" ]]; then
  NAME_ARGS=(--name "${CURSOR_WORKER_NAME}")
fi
exec "${AGENT_BIN}" worker start --pool "${POOL_NAME}" --worker-dir "${dest}" \
  --idle-release-timeout "${IDLE_RELEASE_TIMEOUT_SECONDS}" "${NAME_ARGS[@]}"
