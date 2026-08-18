import { describe, expect, it } from "vitest";
import {
  assertNoSecrets,
  buildLaunchSpec,
  buildRunHookPayload,
  internetEgressArn,
  runMicrovmParams,
} from "../src/launch-spec.js";
import type { LaunchSpec } from "../src/types.js";
import type { AwsSlot } from "../src/slot-state.js";

const spec: LaunchSpec = {
  mode: "serve",
  poolName: "gpu",
  workerName: "aws-gpu-0",
  requestId: "bc-1",
  repoUrls: ["https://github.com/acme/app"],
};

const base = {
  spec,
  imageIdentifier: "arn:aws:lambda:us-east-1:123:microvm-image:cursor-worker",
  executionRoleArn: "arn:aws:iam::123:role/microvm",
  cursorApiKeyParamName: "/cursor-lambda-workers/cursor-api-key",
  gitTokenParamName: "/cursor-lambda-workers/git-token",
  cursorApiUrl: "https://api.cursor.com",
  cursorAgentEndpoint: "https://api2.cursor.sh",
  idleReleaseTimeoutSeconds: 300,
  awsRegion: "us-east-1",
};

describe("buildRunHookPayload", () => {
  it("passes parameter names, never a raw API key", () => {
    const payload = buildRunHookPayload(base);
    expect(payload.version).toBe("1");
    expect(payload.worker.cursorApiKeyParamName).toBe("/cursor-lambda-workers/cursor-api-key");
    expect(payload.worker.workerId).toBe("aws-gpu-0");
    expect(JSON.stringify(payload)).not.toMatch(/sk-[a-zA-Z0-9]{8,}/);
    expect(() => assertNoSecrets(payload)).not.toThrow();
  });
});

describe("buildLaunchSpec", () => {
  it("builds a RunMicrovm launch with internet egress", () => {
    const built = buildLaunchSpec(base);
    expect(built.action).toBe("launch");
    expect(built.egressNetworkConnectors).toContain(internetEgressArn("us-east-1"));
    expect(built.maximumDurationInSeconds).toBe(28_800);
    const params = runMicrovmParams(built);
    expect(params.imageIdentifier).toBe(base.imageIdentifier);
    expect(params.runHookPayload).toContain("cursorApiKeyParamName");
    expect(params.maximumDurationInSeconds).toBe(28_800);
  });

  it("resumes a stopped MicroVM on the same slot index", () => {
    const slots: AwsSlot[] = [
      {
        poolName: "gpu",
        slotIndex: 0,
        containerName: "pool=gpu/slot=0",
        workerName: "aws-gpu-0",
        running: false,
        status: "stopped",
        repoUrls: ["https://github.com/acme/app"],
        lastLaunchAtMs: 1,
        microvmId: "microvm-123",
      },
    ];
    const built = buildLaunchSpec(base, slots, 0);
    expect(built.action).toBe("resume");
    expect(built.microvmId).toBe("microvm-123");
  });
});
