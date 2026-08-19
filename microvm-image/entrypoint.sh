#!/usr/bin/env bash
# Clone the request repo and exec cursor-agent as a pool worker.
set -euo pipefail

export GIT_TERMINAL_PROMPT=0
export PATH="/root/.cursor/bin:/root/.local/bin:/usr/local/bin:${PATH}"

log() { echo "cursor-worker: $*"; }

require() {
  local name="$1"
  if [[ -z "${!name:-}" ]]; then
    echo "FATAL: ${name} is required" >&2
    exit 1
  fi
}

require CURSOR_API_KEY
require POOL_NAME
require REPO_URL

WORKER_NAME="${WORKER_NAME:-${CURSOR_AGENT_WORKER_ID:-pw_$(date +%s)_$RANDOM}}"
export CURSOR_AGENT_WORKER_ID="${CURSOR_AGENT_WORKER_ID:-${WORKER_NAME}}"
IDLE_RELEASE_TIMEOUT_SECONDS="${IDLE_RELEASE_TIMEOUT_SECONDS:-300}"
WORKSPACES="${WORKSPACES:-/opt/cursor/workspaces}"

mkdir -p "${WORKSPACES}"

if [[ -n "${GIT_TOKEN:-}" ]]; then
  GIT_USERNAME="${GIT_USERNAME:-oauth2}"
  git config --global --unset-all credential.helper || true
  git config --global credential.helper \
    "!f() { echo username=${GIT_USERNAME}; echo password=${GIT_TOKEN}; }; f"
  git config --global credential.UseHttpPath true
fi

name="$(basename "${REPO_URL}")"
name="${name%.git}"
dest="${WORKSPACES}/${name}"

if [[ -d "${dest}/.git" ]]; then
  log "refreshing ${name}"
  git -C "${dest}" remote set-url origin "${REPO_URL}" || true
  git -C "${dest}" fetch --all --prune --tags || log "fetch failed; using existing clone"
else
  log "cloning ${REPO_URL} -> ${dest}"
  git clone --filter=blob:none --single-branch "${REPO_URL}" "${dest}"
fi

if [[ ! -d "${dest}/.git" ]]; then
  echo "FATAL: cursor-agent requires --worker-dir to be a git clone." >&2
  exit 1
fi

cd "${dest}"

AGENT_BIN="$(command -v cursor-agent || command -v agent || true)"
if [[ -z "${AGENT_BIN}" ]]; then
  echo "FATAL: cursor-agent / agent binary not found on PATH" >&2
  exit 1
fi

log "starting ${AGENT_BIN} pool=${POOL_NAME} worker=${CURSOR_AGENT_WORKER_ID} dir=${dest}"
exec "${AGENT_BIN}" worker start \
  --pool "${POOL_NAME}" \
  --worker-dir "${dest}" \
  --idle-release-timeout "${IDLE_RELEASE_TIMEOUT_SECONDS}"
