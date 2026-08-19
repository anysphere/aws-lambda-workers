#!/usr/bin/env bash
# Bundle spawn.mjs + the Lambda wrapper and push the controller image to ECR.
# Prints the image URI on stdout (last line).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${ROOT}"

npm run bundle

REGION_ARG=()
if [[ -n "${AWS_REGION:-}" ]]; then
  REGION_ARG=(--region "${AWS_REGION}")
fi

ACCOUNT="$(aws sts get-caller-identity --query Account --output text "${REGION_ARG[@]}")"
REGION="${AWS_REGION:-$(aws configure get region)}"
REPO="${CONTROLLER_ECR_REPO:-cursor-lambda-workers-controller}"
TAG="${CONTROLLER_IMAGE_TAG:-$(git rev-parse --short HEAD 2>/dev/null || date +%Y%m%d%H%M%S)}"
URI="${ACCOUNT}.dkr.ecr.${REGION}.amazonaws.com/${REPO}:${TAG}"

if ! command -v docker >/dev/null 2>&1; then
  echo "docker is required to build the controller Lambda image." >&2
  exit 1
fi

aws ecr describe-repositories --repository-names "${REPO}" "${REGION_ARG[@]}" >/dev/null 2>&1 || \
  aws ecr create-repository --repository-name "${REPO}" "${REGION_ARG[@]}" >/dev/null

aws ecr get-login-password "${REGION_ARG[@]}" | \
  docker login --username AWS --password-stdin "${ACCOUNT}.dkr.ecr.${REGION}.amazonaws.com"

docker build --platform linux/arm64 -f controller/Dockerfile -t "${URI}" "${ROOT}"
docker push "${URI}"

echo "${URI}"
