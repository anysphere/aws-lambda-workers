#!/usr/bin/env bash
# Build the controller Lambda image and deploy cloudformation.yaml.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${ROOT}"

STACK_NAME="${STACK_NAME:-cursor-lambda-workers}"
IMAGE_URI="$(./scripts/build-controller.sh)"

REGION_ARG=()
if [[ -n "${AWS_REGION:-}" ]]; then
  REGION_ARG=(--region "${AWS_REGION}")
fi

aws cloudformation deploy \
  --template-file cloudformation.yaml \
  --stack-name "${STACK_NAME}" \
  --capabilities CAPABILITY_NAMED_IAM \
  --parameter-overrides "ControllerImageUri=${IMAGE_URI}" \
  "${REGION_ARG[@]}" \
  "$@"
