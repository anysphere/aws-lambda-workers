#!/usr/bin/env bash
# Bundle the controller, package cloudformation.yaml, and deploy it.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${ROOT}"

STACK_NAME="${STACK_NAME:-cursor-lambda-workers}"
npm run bundle

REGION_ARG=()
if [[ -n "${AWS_REGION:-}" ]]; then
  REGION_ARG=(--region "${AWS_REGION}")
fi

ACCOUNT="$(aws sts get-caller-identity --query Account --output text "${REGION_ARG[@]}")"
REGION="${AWS_REGION:-$(aws configure get region)}"
BUCKET="${PACKAGE_BUCKET:-cursor-lambda-workers-cfn-${ACCOUNT}-${REGION}}"

aws s3 mb "s3://${BUCKET}" "${REGION_ARG[@]}" 2>/dev/null || true

aws cloudformation package \
  --template-file cloudformation.yaml \
  --s3-bucket "${BUCKET}" \
  --output-template-file packaged.yaml \
  "${REGION_ARG[@]}"

aws cloudformation deploy \
  --template-file packaged.yaml \
  --stack-name "${STACK_NAME}" \
  --capabilities CAPABILITY_NAMED_IAM \
  "${REGION_ARG[@]}" \
  "$@"
