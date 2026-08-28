# Run Cursor cloud agents on AWS Lambda MicroVMs

This template runs Cursor self-hosted pool workers in Lambda MicroVMs you control. Cursor hosts the agent loop. Each worker runs in a Firecracker-isolated MicroVM in your AWS account, started from a snapshot, for up to 8 hours.

You choose the image, network access, and IAM role. Start and watch runs at [cursor.com/agents](https://cursor.com/agents). Tool execution stays in your account.

## How it works

A controller launches one MicroVM per pending pool request:

1. You start a cloud agent at [cursor.com/agents](https://cursor.com/agents) against a self-hosted pool. The request stays pending until a worker claims it.
2. The controller (`agent worker controller --spawn ./spawn.sh`) sees that request and runs [`spawn.sh`](spawn.sh).
3. `spawn.sh` calls [`aws lambda-microvms run-microvm`](https://docs.aws.amazon.com/cli/latest/reference/lambda-microvms/run-microvm.html) (`RunMicrovm`) and returns. `--run-hook-payload` forwards claim `CURSOR_*` into the guest (not `CURSOR_API_ENDPOINT` / `CURSOR_API_URL`; those point at the public REST host and make `worker start` treat the service-account key as invalid).
4. The MicroVM `/run` hook ([`hook.py`](microvm-image/hook.py)) applies that payload and starts [`entrypoint.sh`](microvm-image/entrypoint.sh), which runs `cursor-agent worker --pool --worker-dir start`. The worker executes tool calls in your account.
5. When the session is idle, the worker releases and the MicroVM can terminate.

Image create also POSTs `/ready` (before the snapshot: hook listener up and `/run` bits on disk) and `/validate` (after a test run from the snapshot: cheap agent `--version`/`--help`, no `worker start`). Partners must **rebuild the MicroVM image** after this change so `/ready` and `/validate` are in the snapshot path.

## Key properties

| Property | Benefit |
| --- | --- |
| Firecracker isolation | Hardware-virtualized boundary per session |
| Snapshot boot | Lambda restores the guest from a Firecracker snapshot of your image |
| IAM | Guest uses short-lived credentials from `MicroVmExecutionRoleArn` |
| Duration | Each MicroVM can run up to 8 hours (`--maximum-duration-in-seconds 28800` in `spawn.sh`) |
| Pay-per-session | You pay for that MicroVM’s runtime, not for idle pool capacity |

## Pool and repo modes

Product semantics: [Self-hosted pools](https://cursor.com/docs/cloud-agent/self-hosted-guides/pool.md) ([repo-less / Any repo](https://cursor.com/docs/cloud-agent/self-hosted-guides/pool.md#repo-less-pools), [pool names](https://cursor.com/docs/cloud-agent/self-hosted-guides/pool.md#pool-names), [multiple repo roots](https://cursor.com/docs/cloud-agent/self-hosted-guides/pool.md#register-multiple-repo-roots)). `repo` and `pool` labels are reserved; the worker derives `repo=` from a git remote when one exists.

**This template’s default:** the controller Lambda runs `agent worker controller --spawn ./spawn.sh --pool default` (`PoolNames` / `POOL_NAMES` in [`cloudformation.yaml`](cloudformation.yaml) and [`deploy.sh`](deploy.sh)). The guest image is built with `POOL_NAME=default`. [`hook.py`](microvm-image/hook.py) does not clone. [`entrypoint.sh`](microvm-image/entrypoint.sh) starts the worker from `/opt/cursor/workspaces/workspace` (a `git init` with **no remote** unless `CURSOR_REPO_URL` / `REPO_URL` is set). Keep stack `PoolNames` and image `POOL_NAME` the same. Pass `ALL_POOLS=true` or `REPOSITORY_URLS=...` instead of (or with) `POOL_NAMES` when you need `--all-pools` or `--repository`.

### Any-repo mode

Dashboard: **Any repo**. Docs: [repo-less pools](https://cursor.com/docs/cloud-agent/self-hosted-guides/pool.md#repo-less-pools). Routing is by **pool name**, not by git remote. Users must specify the pool name(s) when starting an agent: the dashboard **Any repo** group, `pool=<name>` on Slack/GitHub/Linear, or the API with `env.type: "pool"` and `env.name`, omitting `repos`. Those starts omit `repo=` labels. Do not assume every pool request includes `repo=`.

Controller — dedicated any-repo fleet:

```bash
agent worker controller --spawn ./spawn.sh --pool <name>
```

Repeat `--pool` for several names. `--all-pools` is not the right default for a dedicated any-repo fleet. On the scheduled Lambda, extra controller flags (including another `--pool`) go in `CURSOR_WORKER_CONTROLLER_ARGS`.

Guest:

```bash
agent worker --pool <name> --worker-dir <dir> start
```

`<dir>` must have **no git remote**, so the worker omits `repo=` labels. `--pool` on the guest must match the controller pool name. This image passes `--pool` from `POOL_NAME` (then `CURSOR_POOL`). The public CLI also reads `CURSOR_WORKER_POOL_NAME` when you run `agent worker --pool start` with no name; this entrypoint always passes `--pool` explicitly.

Today, with `CURSOR_REPO_URL` unset, the entrypoint `git init`s `/opt/cursor/workspaces/workspace` with no remote and starts the worker there. That is any-repo routing (no `repo=` labels).

Optional: at MicroVM start, clone the repo(s) on the pending request so the agent has files. The controller injects `CURSOR_REPO_URL`, `CURSOR_REPO_OWNER`, and `CURSOR_REPO_NAME`; [`spawn.sh`](spawn.sh) forwards them via `--run-hook-payload`. If `CURSOR_REPO_URL` is set, the entrypoint already `git clone`s it. If you then start the worker from that clone (this template does), **this session becomes repo-bound** to that repo. For a worker that stays any-repo, keep `--worker-dir` as a directory with no git remote and let the agent or your scripts clone into it.

Sample: `CURSOR_REPO_URL=https://github.com/octocat/Hello-World` (`octocat/Hello-World`). This is a public sample so you can clone without configuring git credentials. Replace it with your real repository before you run real work. Private repos need git auth (HTTPS token or SSH) on the worker.

### Repo-bound mode

The worker serves one or more specific git remotes. Clone the repo into the MicroVM **image/snapshot** (bake it into [`microvm-image/`](microvm-image/) so Firecracker snapshot boot has the tree) **or** clone on MicroVM start from `CURSOR_REPO_URL` (the entrypoint already does this when that variable is set). Then point the worker at that root (`cd` or `--worker-dir`). The worker derives `repo=octocat/Hello-World` from the git remote. Do not set `repo=` labels by hand.

Sample: `CURSOR_REPO_URL=https://github.com/octocat/Hello-World` (`octocat/Hello-World`). This is a public sample so you can clone without configuring git credentials. Replace it with your real repository before you run real work. Private repos need git auth (HTTPS token or SSH) on the worker.

Multi-root: repeat `--worker-dir` (up to 20). The first root is primary. This template’s entrypoint passes a single `--worker-dir`. To register more roots, repeat the flag on `worker start` in [`entrypoint.sh`](microvm-image/entrypoint.sh).

Users pick `octocat/Hello-World` in the dashboard (the pool appears under that repo). Replace that public sample with your real repository before you run real work. The pool name is optional extra routing, not a substitute for the clone.

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
   POOL_NAMES=default ./deploy.sh
   # POOL_NAMES=gpu,default ./deploy.sh
   # REPOSITORY_URLS=https://github.com/octocat/Hello-World ./deploy.sh
   # ALL_POOLS=true ./deploy.sh
   ```

   `https://github.com/octocat/Hello-World` (`octocat/Hello-World`) is a public sample so you can clone without configuring git credentials. Replace it with your real repository before you run real work. Private repos need git auth (HTTPS token or SSH) on the worker.

3. Build the worker image from [`microvm-image/`](microvm-image/) (needs the stack outputs). Enable both `ready` and `validate` image hooks. After this template change, **rebuild the MicroVM image** so those hooks are in the snapshot path. The stock Dockerfile starts from `public.ecr.aws/lambda/microvms:al2023-minimal`. To start from an application image you already publish to ECR, see [Bring your own ECR image](#bring-your-own-ecr-image).

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
     --hooks '{"port":9000,"microvmImageHooks":{"ready":"ENABLED","readyTimeoutInSeconds":60,"validate":"ENABLED","validateTimeoutInSeconds":60},"microvmHooks":{"run":"ENABLED","runTimeoutInSeconds":60}}'
   ```

4. Start an agent from [cursor.com/agents](https://cursor.com/agents) against the pool, or against `octocat/Hello-World` for the repo-bound walkthrough. That GitHub repo is a public sample so you can clone without configuring git credentials. Replace it with your real repository before you run real work.

## Bring your own ECR image

`create-microvm-image` still takes `--code-artifact uri=s3://.../app.zip` (a zip whose root contains a `Dockerfile` plus app artifacts) and `--base-image-arn` (a Lambda-managed MicroVM OS from `list-managed-microvm-images`). Your ECR image is the **container** base via `FROM` in that Dockerfile, not an argument to `--code-artifact` or `--base-image-arn`. Lambda builds the Dockerfile inside the managed OS, then snapshots the result. Official docs: [Container base images / Using a private ECR image](https://docs.aws.amazon.com/lambda/latest/dg/microvms-images.html).

Keep publishing the application image from CI/CD as you already do (deps, toolchain, repo-specific packages). The MicroVM zip is thin: a Dockerfile that `FROM`s that image (tag or digest) plus this repo’s Cursor worker files. Rebuilding the MicroVM image is what picks up a new CI image. `run-microvm` still uses the MicroVM image name or ARN (`cursor-pool-worker` here), not the ECR URI.

### Dockerfile

Use [`microvm-image/Dockerfile.ecr`](microvm-image/Dockerfile.ecr). Set `FROM` to your image, then layer the same worker bits the stock image installs. Do not drop them: snapshot and smoke-test still POST `/ready` and `/validate` on port 9000.

```dockerfile
FROM 123456789012.dkr.ecr.us-east-1.amazonaws.com/my-ci-image:tag
# linux/arm64 (this template’s guests are aarch64). Linux, snapshot-compatible.
# Image must be reachable from Lambda build (public internet or ECR in this account).
# Ensure git, python3, curl, tar, and awscli if the CI image does not already
# have them (package manager depends on FROM).

COPY cursor-agent-version /tmp/cursor-agent-version
# install cursor-agent for linux/arm64 (same RUN as the stock Dockerfile)

COPY entrypoint.sh hook.py /opt/cursor/
RUN chmod +x /opt/cursor/entrypoint.sh /opt/cursor/hook.py && mkdir -p /opt/cursor/workspaces
ENV HOOK_PORT=9000
ENTRYPOINT ["python3", "/opt/cursor/hook.py"]
```

The guest still needs:

- Cursor agent CLI (`cursor-agent` / `agent worker … start`)
- git (repo-bound clone in [`entrypoint.sh`](microvm-image/entrypoint.sh))
- `/run`, `/ready`, `/validate` on port 9000 ([`hook.py`](microvm-image/hook.py))
- entrypoint that starts the worker with `CURSOR_*` on `/run`

Zip `Dockerfile.ecr` as `Dockerfile` so you do not overwrite the stock quickstart:

```bash
rm -f /tmp/app.zip
TMP=$(mktemp -d)
cp microvm-image/entrypoint.sh microvm-image/hook.py microvm-image/cursor-agent-version "$TMP/"
cp microvm-image/Dockerfile.ecr "$TMP/Dockerfile"
( cd "$TMP" && zip -r /tmp/app.zip . )
aws s3 cp /tmp/app.zip "s3://${BUCKET}/app.zip"
```

Then the same `create-microvm-image` as Deploy step 3: same `--base-image-arn` from `list-managed-microvm-images`, `--build-role-arn`, and `--hooks` with `ready` and `validate` **ENABLED**. Keep those hooks; BYO ECR does not change the snapshot path.

### IAM (private ECR)

The MicroVM **build role** must pull `FROM`. [`cloudformation.yaml`](cloudformation.yaml) `BuildRole` includes:

- `ecr:GetAuthorizationToken` (`Resource: *` — that action does not support resource-level IAM)
- `ecr:BatchCheckLayerAvailability`, `ecr:GetDownloadUrlForLayer`, `ecr:BatchGetImage` on this account’s ECR repositories

Redeploy the stack so those statements exist before the first BYO build. Cross-account ECR needs extra policy on the role and a repository policy on the other account; this template does not add that.

### Architecture

This template’s MicroVM guests are **aarch64**. The ECR image must be `linux/arm64`. An amd64-only CI image fails the MicroVM build or fails at runtime (`Exec format error` on `node`). Publish an arm64 or multi-arch tag from CI.

## Run a cloud agent

Open [cursor.com/agents](https://cursor.com/agents). Choose **Self-hosted**.

- **Any-repo mode:** pick the **Any repo** group and the pool name (`default` unless you overrode `PoolNames`).
- **Repo-bound mode:** pick `octocat/Hello-World` (`https://github.com/octocat/Hello-World`). This is a public sample so you can clone without configuring git credentials. Replace it with your real repository before you run real work. Private repos need git auth (HTTPS token or SSH) on the worker. The pool appears under that repo.

## Alternative: run the controller locally

After the stack and image exist, you can drive `spawn.sh` from your machine instead of from the controller the stack deploys:

```bash
export MICROVM_IMAGE_IDENTIFIER=arn:aws:lambda:REGION:ACCOUNT:microvm-image:cursor-pool-worker
export MICROVM_EXECUTION_ROLE_ARN=arn:aws:iam::ACCOUNT:role/cursor-lambda-workers-microvm-execution-role
export CURSOR_API_KEY=YOUR_SERVICE_ACCOUNT_KEY

agent worker controller --spawn ./spawn.sh --pool default
```

`--pool` is required. Repeat it for several names. `--all-pools` exists but is not the right default for a dedicated any-repo fleet. `cursor-agent worker controller --spawn ./spawn.sh --pool default` is the same CLI. Install the CLI from [cursor.com/install](https://cursor.com/install).

Assume stack output `SpawnRoleArn` so `spawn.sh` can call `run-microvm`. `MICROVM_EXECUTION_ROLE_ARN` is stack output `MicroVmExecutionRoleArn`.

## Monitoring

Guest logs go to CloudWatch log group `/aws/lambda/microvms/cursor-pool-worker`. Controller logs are `/aws/lambda/cursor-lambda-workers-controller`.

List running MicroVMs:

```bash
aws lambda-microvms list-microvms --image-identifier cursor-pool-worker
```

## Troubleshooting

| Symptom | What to check |
| --- | --- |
| Image build fails (S3 or IAM) | Confirm stack outputs `ArtifactBucketName` and `BuildRoleArn`. The zip must land in that bucket, and the build role must be able to read it. |
| Image build fails pulling `FROM` (ECR) | Do not pass an ECR URI to `--code-artifact` or `--base-image-arn`. Put the URI in the zip’s `Dockerfile` `FROM`. Redeploy so `BuildRole` can pull private ECR. Image must be Linux `linux/arm64`, snapshot-compatible, and in this account (or public). |
| Image built before `/ready`+`/validate` | Rebuild the MicroVM image so those hooks are in the snapshot path. Existing snapshots were taken without them. |
| No MicroVM | Confirm the controller is running and can call `run-microvm`. For a local controller, assume `SpawnRoleArn`. Confirm image `cursor-pool-worker` exists. |
| Worker dies immediately | The guest needs `CURSOR_API_KEY` (SSM `/cursor-lambda-workers/cursor-api-key`). Confirm the `/run` hook started `cursor-agent worker --pool … start`. If logs show `Exec format error` on `node`, the image installed the wrong CLI arch (MicroVMs here are aarch64). If auth says the API key is invalid, do not set `CURSOR_API_ENDPOINT` to `https://api.cursor.com`. |
| CLI too old for `controller` | Install the current CLI from [cursor.com/install](https://cursor.com/install) and rebuild the MicroVM image and the controller image. |

## Related resources

- [AWS Lambda MicroVMs](https://docs.aws.amazon.com/lambda/latest/dg/lambda-microvms-guide.html)
- [MicroVM images (container base / private ECR)](https://docs.aws.amazon.com/lambda/latest/dg/microvms-images.html)
- [Cursor self-hosted pools](https://cursor.com/docs/cloud-agent/self-hosted-guides/pool.md) ([Any repo / repo-less](https://cursor.com/docs/cloud-agent/self-hosted-guides/pool.md#repo-less-pools), [pool names](https://cursor.com/docs/cloud-agent/self-hosted-guides/pool.md#pool-names), [multiple repo roots](https://cursor.com/docs/cloud-agent/self-hosted-guides/pool.md#register-multiple-repo-roots))
- This repo: [`spawn.sh`](spawn.sh), [`cloudformation.yaml`](cloudformation.yaml), [`microvm-image/`](microvm-image/)

## License

First-party code in this repository is licensed under the **Apache License, Version 2.0** — see [`LICENSE`](LICENSE).

## Trademarks

This license does not grant permission to use the trade names, trademarks, service marks, or product names of SpaceXAI, Anysphere, Cursor, or Grok, except as required for reasonable and customary use in describing the origin of the Work.

AWS and Amazon Web Services are trademarks of Amazon.com, Inc. or its affiliates. All other trademarks are the property of their respective owners.

## Disclaimer

Unless required by applicable law or agreed to in writing, software distributed under the License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied. See the License for the specific language governing permissions and limitations under the License.
