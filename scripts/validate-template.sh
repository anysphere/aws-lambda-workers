#!/usr/bin/env bash
# Best-effort CloudFormation template validation.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${ROOT}"

python3 - <<'PY'
from pathlib import Path
data = Path("cloudformation.yaml").read_bytes()
data.decode("utf-8")
assert b"AWS::Serverless-2016-10-31" not in data
assert b"Transform:" not in data
assert b"AWS::Lambda::Function" in data
assert b"AWS::Events::Rule" in data
assert b"ControllerFunction" in data
assert b"PollRule" in data
assert b"MicroVmExecutionRole" in data
assert b"SlotTable" not in data
assert b"SpawnRole" not in data
assert b"SchedulerFunction" not in data
print("cloudformation.yaml: checks passed")
PY

if aws sts get-caller-identity >/dev/null 2>&1; then
  aws cloudformation validate-template --template-body file://cloudformation.yaml >/dev/null
  echo "cloudformation validate-template: ok"
fi
