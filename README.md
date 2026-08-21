# Cursor pool workers on AWS Lambda MicroVMs

This template runs Cursor self-hosted pool workers inside Lambda MicroVMs (`aws lambda-microvms run-microvm`).

A scheduled Lambda keeps `agent worker controller --spawn ./spawn.sh` running. Each invoke polls for **5 minutes** (the SSE window), then exits. EventBridge `rate(1 minute)` starts the next invoke as soon as the function is free. `ReservedConcurrentExecutions: 1` prevents two controllers from overlapping (extra ticks are throttled and dropped). If an invoke crashes, the DLQ records it and the next schedule starts a new process.

## Deploy

Put the service-account API key in SSM, then build the controller image and apply `cloudformation.yaml`:

```bash
aws ssm put-parameter --type SecureString \
  --name /cursor-lambda-workers/cursor-api-key \
  --value "YOUR_SERVICE_ACCOUNT_KEY"

./deploy.sh
```

`deploy.sh` logs into ECR in a temporary Docker config (so macOS keychain does not fail with -25299), pushes `controller/Dockerfile` (published `agent` CLI + `spawn.sh`), deploys the stack, and asynchronously invokes the controller so it does not wait for the first EventBridge tick.

Build the worker image from `microvm-image/` (needs the stack outputs):

```bash
BUCKET=$(aws cloudformation describe-stacks --stack-name cursor-lambda-workers \
  --query "Stacks[0].Outputs[?OutputKey=='ArtifactBucketName'].OutputValue" --output text)
BUILD_ROLE=$(aws cloudformation describe-stacks --stack-name cursor-lambda-workers \
  --query "Stacks[0].Outputs[?OutputKey=='BuildRoleArn'].OutputValue" --output text)
BASE=$(aws lambda-microvms list-managed-microvm-images --query "items[0].imageArn" --output text)
( cd microvm-image && zip -r /tmp/app.zip . )
aws s3 cp /tmp/app.zip "s3://${BUCKET}/app.zip"
aws lambda-microvms create-microvm-image \
  --code-artifact "uri=s3://${BUCKET}/app.zip" \
  --name cursor-pool-worker \
  --base-image-arn "${BASE}" \
  --build-role-arn "${BUILD_ROLE}" \
  --environment-variables "POOL_NAME=default,CURSOR_API_KEY_PARAM_NAME=/cursor-lambda-workers/cursor-api-key" \
  --hooks '{"port":9000,"microvmImageHooks":{"ready":"ENABLED","readyTimeoutInSeconds":60},"microvmHooks":{"run":"ENABLED","runTimeoutInSeconds":60}}'
```

Then start an agent from [cursor.com/agents](https://cursor.com/agents) against the pool.

## How it works

EventBridge `rate(1 minute)` invokes the controller Lambda. The handler runs `agent worker controller --spawn ./spawn.sh --pool default` for 300 seconds, SIGTERMs the CLI, and returns success so the expected restart is not a Lambda timeout. Timeout on the function is 360 seconds (window plus shutdown). Overlapping ticks hit reserved concurrency 1 and are dropped; the next free minute starts a new poll loop.

`spawn.sh` calls [`aws lambda-microvms run-microvm`](https://docs.aws.amazon.com/cli/latest/reference/lambda-microvms/run-microvm.html) and returns. `--run-hook-payload` forwards `CURSOR_*` into the guest. The image ENTRYPOINT runs `cursor-agent worker start --pool`.

A true always-on daemon would be a Lambda MicroVM (8h) or ECS with restart running the same CLI. This stack uses a 15-minute-max function on a 5-minute SSE cadence instead.

## Alternative: run the controller locally

After the stack and image exist, you can drive `spawn.sh` directly, instead of through the scheduled Lambda:

```bash
export MICROVM_IMAGE_IDENTIFIER=arn:aws:lambda:REGION:ACCOUNT:microvm-image:cursor-pool-worker
export MICROVM_EXECUTION_ROLE_ARN=arn:aws:iam::ACCOUNT:role/cursor-lambda-workers-microvm-execution-role
export CURSOR_API_KEY=YOUR_SERVICE_ACCOUNT_KEY

agent worker controller --spawn ./spawn.sh --pool default
```

(`cursor-agent worker controller --spawn ./spawn.sh --pool default` is the same CLI.) `--pool` is required (or `--all-pools`). Assume `SpawnRoleArn` so `spawn.sh` can call `run-microvm`.
