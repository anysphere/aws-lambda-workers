#!/usr/bin/env bash
# Best-effort SAM / CloudFormation template validation.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${ROOT}"

if command -v sam >/dev/null 2>&1; then
  sam validate --lint --template template.yaml
  exit 0
fi

if command -v aws >/dev/null 2>&1; then
  aws cloudformation validate-template --template-body file://template.yaml >/dev/null
  echo "cloudformation validate-template: ok"
  exit 0
fi

python3 - <<'PY'
import sys
try:
    import yaml
except ImportError:
    print("PyYAML not installed; checking that template.yaml is non-empty UTF-8", file=sys.stderr)
    data = open("template.yaml", "rb").read()
    data.decode("utf-8")
    assert b"AWS::Serverless-2016-10-31" in data
    print("template.yaml: basic checks passed (install SAM CLI for full validate)")
    sys.exit(0)
doc = yaml.safe_load(open("template.yaml"))
assert doc["Transform"] == "AWS::Serverless-2016-10-31"
assert "SchedulerFunction" in doc["Resources"]
assert "SlotTable" in doc["Resources"]
assert "MicroVmExecutionRole" in doc["Resources"]
print("template.yaml: YAML structure ok")
PY
