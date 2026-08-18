import { describe, expect, it } from "vitest";
import {
  assertNoSecrets,
  buildLaunchSpec,
  buildRunHookPayload,
  internetEgressArn,
  runMicrovmParams,
} from "../src/launch-spec.js";
import type { LaunchIntent, SlotSnapshot } from "../src/types.js";

const intent: LaunchIntent = {
  mode: "serve",
  poolName: "gpu",
  workerName: "pw_abc",
  requestId: "bc-1",
  repoUrls: ["https://github.com/acme/app"],
  reason: "test",
};

const base = {
  intent,
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
    expect(payload.worker.workerId).toBe("pw_abc");
    expect(JSON.stringify(payload)).not.toMatch(/sk-[a-zA-Z0-9]{8,}/);
    expect(() => assertNoSecrets(payload)).not.toThrow();
  });
});

describe("buildLaunchSpec", () => {
  it("builds a RunMicrovm launch with internet egress", () => {
    const spec = buildLaunchSpec(base);
    expect(spec.action).toBe("launch");
    expect(spec.egressNetworkConnectors).toContain(internetEgressArn("us-east-1"));
    expect(spec.maximumDurationInSeconds).toBe(28_800);
    const params = runMicrovmParams(spec);
    expect(params.imageIdentifier).toBe(base.imageIdentifier);
    expect(params.runHookPayload).toContain("cursorApiKeyParamName");
    expect(params.maximumDurationInSeconds).toBe(28_800);
  });

  it("prefers resuming a free suspended slot over a new launch", () => {
    const slots: SlotSnapshot[] = [
      {
        poolName: "gpu",
        workerName: "pw_old",
        status: "suspended",
        repoUrls: ["https://github.com/acme/app"],
        launchedAtMs: 1,
        microvmId: "microvm-123",
      },
    ];
    const spec = buildLaunchSpec(base, slots);
    expect(spec.action).toBe("resume");
    expect(spec.microvmId).toBe("microvm-123");
  });
});
