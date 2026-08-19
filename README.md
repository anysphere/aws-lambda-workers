# Cursor pool workers on AWS Lambda MicroVMs

Apply this CloudFormation template, then start an agent from [cursor.com/agents](https://cursor.com/agents) against the pool.

The stack runs a scheduled Lambda that execs:

```bash
cursor-agent worker controller --spawn ./spawn.mjs
```

`spawn.mjs` calls **RunMicrovm**. The guest `ENTRYPOINT` execs `cursor-agent worker start --pool`. Do not run the CLI on your laptop.

## Deploy

Store the service-account API key in SSM:

```bash
aws ssm put-parameter --type SecureString \
  --name /cursor-lambda-workers/cursor-api-key \
  --value "YOUR_SERVICE_ACCOUNT_KEY"
```

Then:

```bash
./deploy.sh
```

That builds `controller/Dockerfile` (the published CLI plus `handler.mjs` / `spawn.mjs`), deploys `cloudformation.yaml`, and starts a MicroVM image build from `microvm-image/`. Equivalent:

```bash
aws cloudformation deploy \
  --template-file cloudformation.yaml \
  --stack-name cursor-lambda-workers \
  --capabilities CAPABILITY_NAMED_IAM \
  --parameter-overrides \
    ControllerImageUri=ACCOUNT.dkr.ecr.REGION.amazonaws.com/cursor-lambda-workers-controller:TAG \
    PoolName=default \
    CursorApiKeyParamName=/cursor-lambda-workers/cursor-api-key \
    MicroVmImageIdentifier=cursor-pool-worker
```

After the MicroVM image is `SUCCESSFUL`, start an agent from cursor.com/agents against `PoolName`.

## Layout

- `cloudformation.yaml` — customer artifact
- `handler.mjs` — exec the CLI
- `spawn.mjs` — RunMicrovm
- `controller/Dockerfile` — Lambda image that holds `cursor-agent`
- `microvm-image/` — guest image (`cursor-agent worker start --pool`)
