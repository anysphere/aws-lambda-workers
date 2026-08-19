#!/usr/bin/env bash
# Best-effort CloudFormation template + tree-shape checks.
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
assert b"PackageType: Image" in data
assert b"SlotTable" not in data
assert b"SpawnRole" not in data
print("cloudformation.yaml: checks passed")
PY

test ! -f src/controller.ts
test ! -f src/cursor-api.ts
test ! -f src/matching.ts
test ! -f src/dynamo.ts
test ! -f src/lease.ts
test ! -f spawn.sh
test ! -f microvm-image/hook.mjs
test ! -f microvm-image/hooks.mjs
if grep -R -n "listPendingRequests\|planLaunches\|SpawnLease" src >/dev/null; then
  echo "custom controller symbols found under src/" >&2
  exit 1
fi
echo "tree: no custom poll/claim/matching controller"

if aws sts get-caller-identity >/dev/null 2>&1; then
  aws cloudformation validate-template --template-body file://cloudformation.yaml >/dev/null
  echo "cloudformation validate-template: ok"
fi
