#!/usr/bin/env bash
# Clone if needed, then exec cursor-agent worker start --pool.
set -euo pipefail
export GIT_TERMINAL_PROMPT=0
export HOME="${HOME:-/root}"
export NODE_COMPILE_CACHE="${NODE_COMPILE_CACHE:-/tmp/cursor-compile-cache}"
export PATH="/root/.cursor/bin:/root/.local/bin:/usr/local/bin:${PATH}"

if [[ -z "${CURSOR_API_KEY:-}" && -n "${CURSOR_API_KEY_PARAM_NAME:-}" ]]; then
  CURSOR_API_KEY="$(aws ssm get-parameter --name "${CURSOR_API_KEY_PARAM_NAME}" --with-decryption --query Parameter.Value --output text)"
  export CURSOR_API_KEY
fi
if [[ -z "${CURSOR_API_KEY:-}" ]]; then
  echo "FATAL: set CURSOR_API_KEY or CURSOR_API_KEY_PARAM_NAME" >&2
  exit 1
fi
# Controller Lambda sets these to https://api.cursor.com (public REST).
# `worker start` uses --endpoint for /auth/exchange_user_api_key, which lives
# on the default CLI host (api2.cursor.sh). Forwarding api.cursor.com makes
# every service-account key look invalid.
unset CURSOR_API_ENDPOINT CURSOR_API_URL

POOL_NAME="${POOL_NAME:-${CURSOR_POOL:-default}}"
IDLE_RELEASE_TIMEOUT_SECONDS="${IDLE_RELEASE_TIMEOUT_SECONDS:-300}"
WORKSPACES="${WORKSPACES:-/opt/cursor/workspaces}"
REPO_URL="${REPO_URL:-${CURSOR_REPO_URL:-}}"
# Pending-requests emits sanitized host/path (no scheme). git treats that as a
# local path and fails: repository 'github.com/org/repo' does not exist.
if [[ -n "${REPO_URL}" && "${REPO_URL}" != *://* && "${REPO_URL}" != git@* ]]; then
  REPO_URL="https://${REPO_URL}"
fi
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
echo "entrypoint: pool=${POOL_NAME} dest=${dest} worker_id=${CURSOR_AGENT_WORKER_ID:-} agent=${AGENT_BIN} uname=$(uname -m)" >&2
NAME_ARGS=()
if [[ -n "${CURSOR_WORKER_NAME:-}" ]]; then
  NAME_ARGS=(--name "${CURSOR_WORKER_NAME}")
fi
WORKER_ID_ARGS=()
if [[ -n "${CURSOR_AGENT_WORKER_ID:-}" ]]; then
  WORKER_ID_ARGS=(--worker-id "${CURSOR_AGENT_WORKER_ID}")
fi
# Flags belong on `worker` (parent). `start` only accepts --verbose.
exec "${AGENT_BIN}" worker --pool "${POOL_NAME}" --worker-dir "${dest}" \
  --idle-release-timeout "${IDLE_RELEASE_TIMEOUT_SECONDS}" \
  "${WORKER_ID_ARGS[@]}" "${NAME_ARGS[@]}" start --verbose
