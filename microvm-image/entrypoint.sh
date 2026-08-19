#!/usr/bin/env bash
# Clone the workspace if needed, then exec cursor-agent as a pool worker.
set -euo pipefail

export GIT_TERMINAL_PROMPT=0
export PATH="/root/.cursor/bin:/root/.local/bin:/usr/local/bin:${PATH}"

log() { echo "cursor-worker: $*"; }

if [[ -z "${CURSOR_API_KEY:-}" && -n "${CURSOR_API_KEY_PARAM_NAME:-}" ]]; then
  CURSOR_API_KEY="$(aws ssm get-parameter \
    --name "${CURSOR_API_KEY_PARAM_NAME}" \
    --with-decryption \
    --query Parameter.Value \
    --output text)"
  export CURSOR_API_KEY
fi

if [[ -z "${CURSOR_API_KEY:-}" ]]; then
  echo "FATAL: CURSOR_API_KEY or CURSOR_API_KEY_PARAM_NAME is required" >&2
  exit 1
fi

POOL_NAME="${POOL_NAME:-${CURSOR_POOL:-default}}"
WORKER_NAME="${WORKER_NAME:-${CURSOR_AGENT_WORKER_ID:-${CURSOR_WORKER_NAME:-pw_$(date +%s)_$RANDOM}}}"
export CURSOR_AGENT_WORKER_ID="${CURSOR_AGENT_WORKER_ID:-${WORKER_NAME}}"
IDLE_RELEASE_TIMEOUT_SECONDS="${IDLE_RELEASE_TIMEOUT_SECONDS:-300}"
WORKSPACES="${WORKSPACES:-/opt/cursor/workspaces}"
REPO_URL="${REPO_URL:-${CURSOR_REPO_URL:-}}"

mkdir -p "${WORKSPACES}"

if [[ -n "${GIT_TOKEN:-}" ]]; then
  GIT_USERNAME="${GIT_USERNAME:-oauth2}"
  git config --global --unset-all credential.helper || true
  git config --global credential.helper \
    "!f() { echo username=${GIT_USERNAME}; echo password=${GIT_TOKEN}; }; f"
  git config --global credential.UseHttpPath true
fi

dest="${WORKSPACES}/workspace"
if [[ -n "${REPO_URL}" ]]; then
  name="$(basename "${REPO_URL}")"
  dest="${WORKSPACES}/${name%.git}"
  if [[ -d "${dest}/.git" ]]; then
    log "refreshing ${dest}"
    git -C "${dest}" remote set-url origin "${REPO_URL}" || true
    git -C "${dest}" fetch --all --prune --tags || log "fetch failed; using existing clone"
  else
    log "cloning ${REPO_URL} -> ${dest}"
    git clone --filter=blob:none --single-branch "${REPO_URL}" "${dest}"
  fi
elif [[ ! -d "${dest}/.git" ]]; then
  log "initializing empty git workspace at ${dest}"
  mkdir -p "${dest}"
  git -C "${dest}" init
  git -C "${dest}" config user.email "worker@local"
  git -C "${dest}" config user.name "cursor-worker"
  git -C "${dest}" commit --allow-empty -m "workspace"
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
