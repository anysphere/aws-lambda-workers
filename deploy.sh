#!/usr/bin/env bash
# Build the controller Lambda image and deploy cloudformation.yaml.
# EventBridge then keeps `agent worker controller --spawn ./spawn.sh` running
# in 5-minute windows (SSE poll). Build the MicroVM image separately after.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "${ROOT}"

STACK_NAME="${STACK_NAME:-cursor-lambda-workers}"
REGION="${AWS_REGION:-${AWS_DEFAULT_REGION:-$(aws configure get region 2>/dev/null || true)}}"
REGION="${REGION:-us-east-1}"
REGION_ARG=(--region "${REGION}")
ACCOUNT="$(aws sts get-caller-identity --query Account --output text "${REGION_ARG[@]}")"
REPO="${CONTROLLER_ECR_REPO:-cursor-lambda-workers-controller}"
TAG="${CONTROLLER_IMAGE_TAG:-$(git rev-parse --short HEAD 2>/dev/null || echo local)-$(date +%Y%m%d%H%M%S)}"
URI="${ACCOUNT}.dkr.ecr.${REGION}.amazonaws.com/${REPO}:${TAG}"
POOL_NAMES="${POOL_NAMES:-${POOL_NAME:-}}"
ALL_POOLS="${ALL_POOLS:-false}"
case "${ALL_POOLS}" in
  1|true|TRUE|yes|YES|on|ON) ALL_POOLS=true ;;
  *) ALL_POOLS=false ;;
esac
REPOSITORY_URLS="${REPOSITORY_URLS:-}"
CURSOR_API_KEY_PARAM_NAME="${CURSOR_API_KEY_PARAM_NAME:-/cursor-lambda-workers/cursor-api-key}"
MICROVM_IMAGE_IDENTIFIER="${MICROVM_IMAGE_IDENTIFIER:-cursor-pool-worker}"

if [[ -z "${POOL_NAMES}" && "${ALL_POOLS}" != "true" && -z "${REPOSITORY_URLS}" ]]; then
  echo "Set POOL_NAMES (comma-separated), ALL_POOLS=true, and/or REPOSITORY_URLS so the controller knows what to serve." >&2
  echo "Example: POOL_NAMES=default ./deploy.sh" >&2
  exit 1
fi

if ! command -v docker >/dev/null 2>&1; then
  echo "docker is required to build the controller Lambda image." >&2
  exit 1
fi

# OrbStack (and Docker Desktop) keep the daemon socket in a named context.
# A temporary DOCKER_CONFIG drops currentContext, so pin DOCKER_HOST first.
if [[ -z "${DOCKER_HOST:-}" ]]; then
  DOCKER_HOST="$(docker context inspect -f '{{.Endpoints.docker.Host}}' 2>/dev/null || true)"
  if [[ -n "${DOCKER_HOST}" ]]; then
    export DOCKER_HOST
  fi
fi

# Isolated Docker config with inline auths (no credsStore, no `docker login`).
# Avoids macOS keychain -25299 and BuildKit attaching a private-ECR token to
# public.ecr.aws (403). The Lambda Python base image is pulled from Docker Hub.
DOCKER_CONFIG="$(mktemp -d "${TMPDIR:-/tmp}/cursor-lambda-docker.XXXXXX")"
export DOCKER_CONFIG
trap 'rm -rf "${DOCKER_CONFIG}"' EXIT
ECR_REGISTRY="${ACCOUNT}.dkr.ecr.${REGION}.amazonaws.com"
ECR_PASSWORD="$(aws ecr get-login-password "${REGION_ARG[@]}")"
python3 - "${DOCKER_CONFIG}/config.json" "${ECR_REGISTRY}" "${ECR_PASSWORD}" <<'PY'
import base64, json, pathlib, sys
path, registry, password = sys.argv[1], sys.argv[2], sys.argv[3]
auth = base64.b64encode(f"AWS:{password}".encode()).decode()
pathlib.Path(path).write_text(json.dumps({"auths": {registry: {"auth": auth}}}))
PY
unset ECR_PASSWORD

aws ecr describe-repositories --repository-names "${REPO}" "${REGION_ARG[@]}" >/dev/null 2>&1 || \
  aws ecr create-repository --repository-name "${REPO}" "${REGION_ARG[@]}" >/dev/null
aws ecr set-repository-policy --repository-name "${REPO}" --policy-text '{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "LambdaECRImageRetrievalPolicy",
      "Effect": "Allow",
      "Principal": { "Service": "lambda.amazonaws.com" },
      "Action": ["ecr:BatchGetImage", "ecr:GetDownloadUrlForLayer"]
    }
  ]
}' "${REGION_ARG[@]}" >/dev/null
docker build --platform linux/amd64 -f controller/Dockerfile -t "${URI}" "${ROOT}"
docker push "${URI}"

aws cloudformation deploy \
  --template-file cloudformation.yaml \
  --stack-name "${STACK_NAME}" \
  --capabilities CAPABILITY_NAMED_IAM \
  --parameter-overrides \
    "ControllerImageUri=${URI}" \
    "PoolNames=${POOL_NAMES}" \
    "AllPools=${ALL_POOLS}" \
    "RepositoryUrls=${REPOSITORY_URLS}" \
    "CursorApiKeyParamName=${CURSOR_API_KEY_PARAM_NAME}" \
    "MicroVmImageIdentifier=${MICROVM_IMAGE_IDENTIFIER}" \
  "${REGION_ARG[@]}"

FUNC="$(aws cloudformation describe-stacks --stack-name "${STACK_NAME}" \
  --query "Stacks[0].Outputs[?OutputKey=='ControllerFunctionName'].OutputValue" --output text "${REGION_ARG[@]}")"
aws lambda invoke \
  --function-name "${FUNC}" \
  --invocation-type Event \
  "${TMPDIR:-/tmp}/${STACK_NAME}-controller-invoke.json" \
  "${REGION_ARG[@]}" >/dev/null

echo "Stack ${STACK_NAME} deployed. Controller ${FUNC} is running (5-minute SSE window; EventBridge rate(1 minute) restarts it)."
if [[ "${ALL_POOLS}" == "true" ]]; then
  echo "Serving all pools${REPOSITORY_URLS:+, repositories ${REPOSITORY_URLS}}."
else
  echo "Serving pools ${POOL_NAMES:-none}${REPOSITORY_URLS:+, repositories ${REPOSITORY_URLS}}."
fi
echo "Build the MicroVM image next (enable ready+validate hooks; POOL_NAME should match a pool this controller serves), then start an agent from cursor.com/agents."
