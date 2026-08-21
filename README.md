# Run Cursor cloud agents on AWS Lambda MicroVMs

This template runs Cursor self-hosted pool workers in Lambda MicroVMs you control. Cursor hosts the agent loop. Each worker runs in a Firecracker-isolated MicroVM in your AWS account, started from a snapshot, for up to 8 hours.

You choose the image, network access, and IAM role. Start and watch runs at [cursor.com/agents](https://cursor.com/agents). Tool execution stays in your account.

## How it works

A controller launches one MicroVM per pending pool request:

1. You start a cloud agent at [cursor.com/agents](https://cursor.com/agents) against a self-hosted pool. The request stays pending until a worker claims it.
2. The controller (`agent worker controller --spawn ./spawn.sh`) sees that request and runs [`spawn.sh`](spawn.sh).
3. `spawn.sh` calls [`aws lambda-microvms run-microvm`](https://docs.aws.amazon.com/cli/latest/reference/lambda-microvms/run-microvm.html) (`RunMicrovm`) and returns. `--run-hook-payload` forwards `CURSOR_*` into the guest.
4. The MicroVM `/run` hook starts `cursor-agent worker start --pool`. The worker executes tool calls in your account.
5. When the session is idle, the worker releases and the MicroVM can terminate.

## Key properties

| Property | Benefit |
| --- | --- |
| Firecracker isolation | Hardware-virtualized boundary per session |
| Snapshot boot | Lambda restores the guest from a Firecracker snapshot of your image |
| IAM | Guest uses short-lived credentials from `MicroVmExecutionRoleArn` |
| Duration | Each MicroVM can run up to 8 hours (`--maximum-duration-in-seconds 28800` in `spawn.sh`) |
| Pay-per-session | You pay for that MicroVM’s runtime, not for idle pool capacity |

## Prerequisites

- An AWS account with Lambda MicroVMs enabled, plus permission to use Amazon S3, IAM, AWS CloudFormation, and Systems Manager Parameter Store
- A Cursor team with self-hosted pools enabled
- A [service account API key](https://cursor.com/docs/account/enterprise/service-accounts) for pool workers
- The [AWS CLI](https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html) (and Docker, which [`deploy.sh`](deploy.sh) uses to build the controller image)

## Deploy

1. Store the service-account API key in SSM:

   ```bash
   aws ssm put-parameter --type SecureString \
     --name /cursor-lambda-workers/cursor-api-key \
     --value "YOUR_SERVICE_ACCOUNT_KEY"
   ```

2. Deploy the stack. `./deploy.sh` builds the controller image and runs `aws cloudformation deploy` on [`cloudformation.yaml`](cloudformation.yaml):

   ```bash
   ./deploy.sh
   ```

3. Build the worker image from [`microvm-image/`](microvm-image/) (needs the stack outputs):

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

4. Start an agent from [cursor.com/agents](https://cursor.com/agents) against the pool.

## Pin a CLI version

Optional. To test a CLI off `main`, put a lab version (`YYYY.MM.DD-<sha7>`) in [`microvm-image/cursor-agent-version`](microvm-image/cursor-agent-version) and rebuild the MicroVM image **and** the controller image.

Lab builds: [cursor.com/install?channel=lab](https://cursor.com/install?channel=lab), the `agent-cli.yml` GitHub Action on `main`, or `https://downloads.cursor.com/lab/<version>/linux/x64/agent-cli-package.tar.gz`.

Leave the file empty (comments only) to use the prod installer at [cursor.com/install](https://cursor.com/install).

## Run a cloud agent

Open [cursor.com/agents](https://cursor.com/agents). Choose **Self-hosted** and the pool name (`default` unless you overrode `PoolName`).

## Alternative: run the controller locally

After the stack and image exist, you can drive `spawn.sh` from your machine instead of from the controller the stack deploys:

```bash
export MICROVM_IMAGE_IDENTIFIER=arn:aws:lambda:REGION:ACCOUNT:microvm-image:cursor-pool-worker
export MICROVM_EXECUTION_ROLE_ARN=arn:aws:iam::ACCOUNT:role/cursor-lambda-workers-microvm-execution-role
export CURSOR_API_KEY=YOUR_SERVICE_ACCOUNT_KEY

agent worker controller --spawn ./spawn.sh --pool default
```

`--pool` is required (or use `--all-pools`). `cursor-agent worker controller --spawn ./spawn.sh --pool default` is the same CLI. If `controller` is missing from the prod CLI, install a [lab build](https://cursor.com/install?channel=lab).

Assume stack output `SpawnRoleArn` so `spawn.sh` can call `run-microvm`. `MICROVM_EXECUTION_ROLE_ARN` is stack output `MicroVmExecutionRoleArn`.

## Monitoring

Application logs go to CloudWatch under the MicroVM image name (`cursor-pool-worker`).

List running MicroVMs:

```bash
aws lambda-microvms list-microvms --image-identifier cursor-pool-worker
```

## Troubleshooting

| Symptom | What to check |
| --- | --- |
| Image build fails (S3 or IAM) | Confirm stack outputs `ArtifactBucketName` and `BuildRoleArn`. The zip must land in that bucket, and the build role must be able to read it. |
| No MicroVM | Confirm the controller is running and can call `run-microvm`. For a local controller, assume `SpawnRoleArn`. Confirm image `cursor-pool-worker` exists. |
| Worker dies immediately | The guest needs `CURSOR_API_KEY` (SSM `/cursor-lambda-workers/cursor-api-key`). Confirm the `/run` hook started `cursor-agent worker start --pool`. |
| CLI too old for `controller` | Pin a lab version in `microvm-image/cursor-agent-version` and rebuild the MicroVM image and the controller image. |

## Related resources

- [AWS Lambda MicroVMs](https://docs.aws.amazon.com/lambda/latest/dg/lambda-microvms-guide.html)
- [Cursor self-hosted pools](https://cursor.com/docs/cloud-agent/self-hosted-pool)
- This repo: [`spawn.sh`](spawn.sh), [`cloudformation.yaml`](cloudformation.yaml), [`microvm-image/`](microvm-image/)
