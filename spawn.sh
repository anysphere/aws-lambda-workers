#!/usr/bin/env bash
# Spawn hook for `agent worker controller --spawn ./spawn.sh`.
# Starts one Lambda MicroVM; does not wait for the agent.
# Forwards CURSOR_* via --run-hook-payload (the only per-run channel).
# https://docs.aws.amazon.com/cli/latest/reference/lambda-microvms/run-microvm.html
set -euo pipefail

: "${MICROVM_IMAGE_IDENTIFIER:?set MICROVM_IMAGE_IDENTIFIER to the MicroVM image ARN (or name)}"
: "${MICROVM_EXECUTION_ROLE_ARN:?set MICROVM_EXECUTION_ROLE_ARN to the guest IAM role}"

REGION="${AWS_REGION:-${AWS_DEFAULT_REGION:-us-east-1}}"
IMAGE="${MICROVM_IMAGE_IDENTIFIER}"
if [[ "${IMAGE}" != arn:* ]]; then
  ACCOUNT="$(aws sts get-caller-identity --query Account --output text --region "${REGION}")"
  IMAGE="arn:aws:lambda:${REGION}:${ACCOUNT}:microvm-image:${IMAGE}"
fi

PAYLOAD="$(python3 -c 'import json,os; print(json.dumps({k:v for k,v in os.environ.items() if k.startswith("CURSOR_")}))')"

exec aws lambda-microvms run-microvm \
  --region "${REGION}" \
  --image-identifier "${IMAGE}" \
  --execution-role-arn "${MICROVM_EXECUTION_ROLE_ARN}" \
  --ingress-network-connectors "arn:aws:lambda:${REGION}:aws:network-connector:aws-network-connector:ALL_INGRESS" \
  --egress-network-connectors "arn:aws:lambda:${REGION}:aws:network-connector:aws-network-connector:INTERNET_EGRESS" \
  --maximum-duration-in-seconds 28800 \
  --run-hook-payload "${PAYLOAD}"
