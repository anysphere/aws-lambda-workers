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

# Claim metadata plus the API key. Do not forward CURSOR_API_ENDPOINT /
# CURSOR_API_URL from the controller Lambda — those point at api.cursor.com,
# which is the public REST host, not the worker auth exchange.
PAYLOAD="$(python3 -c 'import json,os
skip={"CURSOR_API_ENDPOINT","CURSOR_API_URL","CURSOR_API_KEY_PARAM_NAME"}
print(json.dumps({k:v for k,v in os.environ.items() if k.startswith("CURSOR_") and k not in skip}))')"

# Outbound-only workers never hit the HTTPS ingress, so a short default idle
# policy would suspend the VM before the agent connects. Guest logs go to
# /aws/lambda/microvms/cursor-pool-worker (execution role already allows it).
exec aws lambda-microvms run-microvm \
  --region "${REGION}" \
  --image-identifier "${IMAGE}" \
  --execution-role-arn "${MICROVM_EXECUTION_ROLE_ARN}" \
  --ingress-network-connectors "arn:aws:lambda:${REGION}:aws:network-connector:aws-network-connector:ALL_INGRESS" \
  --egress-network-connectors "arn:aws:lambda:${REGION}:aws:network-connector:aws-network-connector:INTERNET_EGRESS" \
  --maximum-duration-in-seconds 28800 \
  --idle-policy '{"autoResumeEnabled":false,"maxIdleDurationSeconds":28800,"suspendedDurationSeconds":28800}' \
  --logging '{"cloudWatch":{"logGroup":"/aws/lambda/microvms/cursor-pool-worker"}}' \
  --run-hook-payload "${PAYLOAD}"
