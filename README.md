# Cursor pool workers on AWS Lambda MicroVMs

This template runs Cursor self-hosted pool workers inside Lambda MicroVMs (`aws lambda-microvms run-microvm`). It is not a 15-minute Lambda function.

## Deploy

Put the service-account API key in SSM, then apply `cloudformation.yaml` (artifact bucket, image build role, MicroVM execution role, spawn role):

```bash
aws ssm put-parameter --type SecureString \
  --name /cursor-lambda-workers/cursor-api-key \
  --value "YOUR_SERVICE_ACCOUNT_KEY"

aws cloudformation deploy \
  --template-file cloudformation.yaml \
  --stack-name cursor-lambda-workers \
  --capabilities CAPABILITY_NAMED_IAM
```

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

`spawn.sh` calls [`aws lambda-microvms run-microvm`](https://docs.aws.amazon.com/cli/latest/reference/lambda-microvms/run-microvm.html) and returns. `--run-hook-payload` forwards `CURSOR_*` into the guest. The image ENTRYPOINT runs `cursor-agent worker start --pool`.

## Alternative: run the controller locally

After the stack and image exist, you can drive `spawn.sh` directly, instead of through a lambda:

```bash
export MICROVM_IMAGE_IDENTIFIER=arn:aws:lambda:REGION:ACCOUNT:microvm-image:cursor-pool-worker
export MICROVM_EXECUTION_ROLE_ARN=arn:aws:iam::ACCOUNT:role/cursor-lambda-workers-microvm-execution-role
export CURSOR_API_KEY=YOUR_SERVICE_ACCOUNT_KEY

agent worker controller --spawn ./spawn.sh --pool default 
```

(`cursor-agent worker controller --spawn ./spawn.sh --pool default` is the same CLI.) `--pool` is required (or `--all-pools`). Assume `SpawnRoleArn` so `spawn.sh` can call `run-microvm`.
