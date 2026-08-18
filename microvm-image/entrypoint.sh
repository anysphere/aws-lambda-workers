#!/usr/bin/env bash
# Restore-or-clone pool repos and start cursor-agent as a pool worker.
#
# Secrets and unique IDs arrive via the environment at run/resume time.
# The git credential helper prints tokens to stdout and never writes them
# to disk. Optional S3 tarball cache is a fallback for large repos that
# change independently of the MicroVM snapshot.
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

WORKER_NAME="${WORKER_NAME:-${CURSOR_AGENT_WORKER_ID:-pw_$(date +%s)_$RANDOM}}"
export CURSOR_AGENT_WORKER_ID="${CURSOR_AGENT_WORKER_ID:-${WORKER_NAME}}"
IDLE_RELEASE_TIMEOUT_SECONDS="${IDLE_RELEASE_TIMEOUT_SECONDS:-300}"
WORKSPACES="${WORKSPACES:-/opt/cursor/workspaces}"
CACHE_DIR="${CACHE_DIR:-/opt/cursor/cache}"
REPO_URLS="${REPO_URLS:-}"

mkdir -p "${WORKSPACES}" "${CACHE_DIR}"

# In-memory credential helper: never writes a netrc or git-credentials file.
if [[ -n "${GIT_TOKEN:-}" ]]; then
  GIT_USERNAME="${GIT_USERNAME:-oauth2}"
  git config --global --unset-all credential.helper || true
  git config --global credential.helper \
    "!f() { echo username=${GIT_USERNAME}; echo password=${GIT_TOKEN}; }; f"
  git config --global credential.UseHttpPath true
fi

repo_name() {
  local url="$1"
  local base
  base="$(basename "${url}")"
  echo "${base%.git}"
}

restore_or_clone() {
  local url="$1"
  local name dest tarball
  name="$(repo_name "${url}")"
  dest="${WORKSPACES}/${name}"
  tarball="${CACHE_DIR}/${name}.tar"

  if [[ -d "${dest}/.git" ]]; then
    log "refreshing ${name} (already cloned; snapshot or prior run)"
    git -C "${dest}" remote set-url origin "${url}" || true
    git -C "${dest}" fetch --all --prune --tags || log "fetch failed for ${name}; using snapshot copy"
    return
  fi

  if [[ -f "${tarball}" ]]; then
    log "extracting local tarball cache for ${name}"
    mkdir -p "${dest}"
    tar -xf "${tarball}" -C "${dest}"
    if [[ -d "${dest}/.git" ]]; then
      git -C "${dest}" remote set-url origin "${url}" || true
      git -C "${dest}" fetch --all --prune --tags || true
      return
    fi
    rm -rf "${dest}"
  fi

  if [[ -n "${REPO_CACHE_BUCKET:-}" ]]; then
    local key="s3://${REPO_CACHE_BUCKET}/repo-cache/${name}.tar"
    log "trying optional S3 cache ${key}"
    if command -v aws >/dev/null 2>&1 && aws s3 cp "${key}" "${tarball}" 2>/dev/null; then
      mkdir -p "${dest}"
      tar -xf "${tarball}" -C "${dest}"
      if [[ -d "${dest}/.git" ]]; then
        git -C "${dest}" remote set-url origin "${url}" || true
        return
      fi
      rm -rf "${dest}"
    fi
  fi

  log "cloning ${url} -> ${dest}"
  git clone --filter=blob:none --single-branch "${url}" "${dest}"
}

trim() {
  local value="$1"
  value="${value#"${value%%[![:space:]]*}"}"
  value="${value%"${value##*[![:space:]]}"}"
  printf '%s' "${value}"
}

IFS=',' read -r -a REPO_LIST <<< "${REPO_URLS}"
PRIMARY=""
for raw in "${REPO_LIST[@]}"; do
  url="$(trim "${raw}")"
  [[ -z "${url}" ]] && continue
  restore_or_clone "${url}"
  if [[ -z "${PRIMARY}" ]]; then
    PRIMARY="${WORKSPACES}/$(repo_name "${url}")"
  fi
done

if [[ -z "${PRIMARY}" || ! -d "${PRIMARY}/.git" ]]; then
  echo "FATAL: released cursor-agent requires --worker-dir to be a git clone. No repo available." >&2
  exit 1
fi

cd "${PRIMARY}"

AGENT_BIN="$(command -v cursor-agent || command -v agent || true)"
if [[ -z "${AGENT_BIN}" ]]; then
  echo "FATAL: cursor-agent / agent binary not found on PATH" >&2
  exit 1
fi

log "starting ${AGENT_BIN} pool=${POOL_NAME} worker=${CURSOR_AGENT_WORKER_ID} dir=${PRIMARY}"
exec "${AGENT_BIN}" worker start \
  --pool "${POOL_NAME}" \
  --worker-dir "${PRIMARY}" \
  --idle-release-timeout "${IDLE_RELEASE_TIMEOUT_SECONDS}"
