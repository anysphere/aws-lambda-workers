#!/usr/bin/env bash
# Build the controller image, deploy cloudformation.yaml, build the MicroVM image.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "${ROOT}"

STACK_NAME="${STACK_NAME:-cursor-lambda-workers}"
REGION="${AWS_REGION:-$(aws configure get region)}"
REGION_ARG=(--region "${REGION}")
ACCOUNT="$(aws sts get-caller-identity --query Account --output text "${REGION_ARG[@]}")"
REPO="${CONTROLLER_ECR_REPO:-cursor-lambda-workers-controller}"
TAG="${CONTROLLER_IMAGE_TAG:-$(git rev-parse --short HEAD 2>/dev/null || date +%Y%m%d%H%M%S)}"
URI="${ACCOUNT}.dkr.ecr.${REGION}.amazonaws.com/${REPO}:${TAG}"
IMAGE_NAME="${IMAGE_NAME:-cursor-pool-worker}"
POOL_NAME="${POOL_NAME:-default}"
CURSOR_API_KEY_PARAM_NAME="${CURSOR_API_KEY_PARAM_NAME:-/cursor-lambda-workers/cursor-api-key}"

aws ecr describe-repositories --repository-names "${REPO}" "${REGION_ARG[@]}" >/dev/null 2>&1 || \
  aws ecr create-repository --repository-name "${REPO}" "${REGION_ARG[@]}" >/dev/null
aws ecr get-login-password "${REGION_ARG[@]}" | docker login --username AWS --password-stdin "${ACCOUNT}.dkr.ecr.${REGION}.amazonaws.com"
docker build --platform linux/arm64 -f controller/Dockerfile -t "${URI}" "${ROOT}"
docker push "${URI}"

aws cloudformation deploy \
  --template-file cloudformation.yaml \
  --stack-name "${STACK_NAME}" \
  --capabilities CAPABILITY_NAMED_IAM \
  --parameter-overrides \
    "ControllerImageUri=${URI}" \
    "PoolName=${POOL_NAME}" \
    "CursorApiKeyParamName=${CURSOR_API_KEY_PARAM_NAME}" \
    "MicroVmImageIdentifier=${IMAGE_NAME}" \
  "${REGION_ARG[@]}"

BUCKET="$(aws cloudformation describe-stacks --stack-name "${STACK_NAME}" \
  --query "Stacks[0].Outputs[?OutputKey=='ArtifactBucketName'].OutputValue" --output text "${REGION_ARG[@]}")"
BUILD_ROLE_ARN="$(aws cloudformation describe-stacks --stack-name "${STACK_NAME}" \
  --query "Stacks[0].Outputs[?OutputKey=='BuildRoleArn'].OutputValue" --output text "${REGION_ARG[@]}")"
BASE_IMAGE_ARN="${BASE_IMAGE_ARN:-$(aws lambda-microvms list-managed-microvm-images \
  --query "items[0].imageArn" --output text "${REGION_ARG[@]}")}"
S3_KEY="deployments/app-$(date +%Y%m%d-%H%M%S).zip"
TMP_ZIP="$(mktemp)"
( cd "${ROOT}/microvm-image" && zip -r -q "${TMP_ZIP}" . )
aws s3 cp "${TMP_ZIP}" "s3://${BUCKET}/${S3_KEY}" "${REGION_ARG[@]}"
rm -f "${TMP_ZIP}"

ENV_VARS="POOL_NAME=${POOL_NAME},CURSOR_API_KEY_PARAM_NAME=${CURSOR_API_KEY_PARAM_NAME}"
aws lambda-microvms create-microvm-image \
  --code-artifact "uri=s3://${BUCKET}/${S3_KEY}" \
  --name "${IMAGE_NAME}" \
  --base-image-arn "${BASE_IMAGE_ARN}" \
  --build-role-arn "${BUILD_ROLE_ARN}" \
  --environment-variables "${ENV_VARS}" \
  "${REGION_ARG[@]}"

echo "Stack ${STACK_NAME} deployed. MicroVM image build started (${IMAGE_NAME})."
echo "Start an agent from cursor.com/agents against pool ${POOL_NAME}."
