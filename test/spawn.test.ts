import { describe, expect, it } from "vitest";
import { buildLaunchSpec, buildRunHookPayload } from "../src/launch-spec.js";
import { LaunchMicroVmError, type MicroVmClient } from "../src/microvm.js";
import {
  EXIT_NON_RETRYABLE,
  EXIT_OK,
  EXIT_RETRYABLE,
  readSpawnRequest,
  spawnMicrovm,
} from "../src/spawn.js";

const baseEnv = {
  CURSOR_WORKER_NAME: "aws-default-abc",
  CURSOR_API_KEY: "test-key",
  CURSOR_REPO_URL: "https://github.com/acme/app",
  CURSOR_POOL: "gpu",
  CURSOR_REQUEST_ID: "bc-1",
  CURSOR_USER_EMAIL: "dev@example.com",
  MICROVM_IMAGE_IDENTIFIER: "arn:aws:lambda:us-east-1:1:microvm-image:cursor-worker",
  MICROVM_EXECUTION_ROLE_ARN: "arn:aws:iam::1:role/microvm",
  AWS_REGION: "us-east-1",
};

describe("readSpawnRequest", () => {
  it("maps CLI spawn env onto a one-shot RunMicrovm identity", () => {
    const parsed = readSpawnRequest(baseEnv);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.request.workerName).toBe("aws-default-abc");
    expect(parsed.request.poolName).toBe("gpu");
    expect(parsed.request.repoUrls).toEqual(["https://github.com/acme/app"]);
    expect(parsed.request.requestId).toBe("bc-1");
    expect(parsed.request.userEmail).toBe("dev@example.com");
    const payload = buildRunHookPayload(parsed.request);
    expect(payload.worker.workerId).toBe("aws-default-abc");
    expect(payload.worker.workerName).toBe("aws-default-abc");
  });

  it("builds a GitHub HTTPS URL from owner/name", () => {
    const parsed = readSpawnRequest({
      ...baseEnv,
      CURSOR_REPO_URL: undefined,
      CURSOR_REPO_OWNER: "Acme",
      CURSOR_REPO_NAME: "App",
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.request.repoUrls[0]).toMatch(/github.com\/Acme\/App/i);
  });

  it("prefers an SSM param name over putting the raw key in the payload", () => {
    const parsed = readSpawnRequest({
      ...baseEnv,
      CURSOR_API_KEY_PARAM_NAME: "/cursor/api-key",
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const payload = buildRunHookPayload(parsed.request);
    expect(payload.worker.cursorApiKeyParamName).toBe("/cursor/api-key");
    expect(payload.worker.cursorApiKey).toBeUndefined();
  });

  it("rejects missing worker name, API key, or repo", () => {
    expect(readSpawnRequest({ ...baseEnv, CURSOR_WORKER_NAME: "" }).ok).toBe(false);
    expect(readSpawnRequest({ ...baseEnv, CURSOR_API_KEY: "" }).ok).toBe(false);
    expect(readSpawnRequest({ ...baseEnv, CURSOR_REPO_URL: "" }).ok).toBe(false);
  });
});

describe("spawnMicrovm", () => {
  it("submits RunMicrovm and returns immediately (exit 0)", async () => {
    let submitted: { action?: string; runHookPayload?: string } | undefined;
    const launch = async (spec: { action: string; runHookPayload: string }) => {
      submitted = spec;
      return { microvmId: "m-1" };
    };
    const result = await spawnMicrovm(baseEnv, () => ({ launch }) as MicroVmClient);
    expect(result).toEqual({ exitCode: EXIT_OK, message: "submitted m-1", microvmId: "m-1" });
    expect(submitted?.action).toBe("launch");
    expect(JSON.parse(submitted?.runHookPayload ?? "{}").worker.workerName).toBe("aws-default-abc");
  });

  it("returns 2 for missing env without calling RunMicrovm", async () => {
    let called = false;
    const result = await spawnMicrovm({ AWS_REGION: "us-east-1" }, () => ({
      async launch() {
        called = true;
        return { microvmId: "nope" };
      },
    }));
    expect(result.exitCode).toBe(EXIT_NON_RETRYABLE);
    expect(called).toBe(false);
  });

  it("returns 1 for retryable RunMicrovm failures", async () => {
    const result = await spawnMicrovm(
      baseEnv,
      () =>
        ({
          async launch() {
            throw new LaunchMicroVmError("throttled", { status: 429 });
          },
        }) as MicroVmClient,
    );
    expect(result.exitCode).toBe(EXIT_RETRYABLE);
  });

  it("returns 2 for non-retryable RunMicrovm failures", async () => {
    const result = await spawnMicrovm(
      baseEnv,
      () =>
        ({
          async launch() {
            throw new LaunchMicroVmError("forbidden", { status: 403 });
          },
        }) as MicroVmClient,
    );
    expect(result.exitCode).toBe(EXIT_NON_RETRYABLE);
  });
});

describe("buildLaunchSpec", () => {
  it("is a one-shot launch, not a planner tick", () => {
    const parsed = readSpawnRequest(baseEnv);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const spec = buildLaunchSpec(parsed.request);
    expect(spec.action).toBe("launch");
    expect(spec.imageIdentifier).toBe(baseEnv.MICROVM_IMAGE_IDENTIFIER);
    expect(spec.executionRoleArn).toBe(baseEnv.MICROVM_EXECUTION_ROLE_ARN);
  });
});
