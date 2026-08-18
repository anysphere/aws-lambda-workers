import { describe, expect, it } from "vitest";
import { loadPlannerSettings } from "../src/config.js";
import { emptySlotStore, memoryStore } from "../src/slot-state.js";
import { tickOnce } from "../src/scheduler.js";
import type { MicroVmClient } from "../src/microvm.js";

describe("tickOnce", () => {
  it("launches a serve intent and persists the slot", async () => {
    const launched: string[] = [];
    const microvms: MicroVmClient = {
      async launch(spec) {
        launched.push(spec.action);
        return { microvmId: "m-1", endpoint: "https://example.invalid" };
      },
      async resume() {},
      async suspend() {},
      async terminate() {},
    };
    const store = memoryStore(emptySlotStore());
    const settings = loadPlannerSettings({
      POOLS: JSON.stringify([{ name: "default", repos: ["https://github.com/acme/app"], minWorkers: 0 }]),
      MIN_WORKERS_PER_POOL: "0",
    });
    const result = await tickOnce({
      nowMs: () => 50_000,
      loadStore: store.load,
      saveStore: store.save,
      listPending: async () => [{ id: "bc-1", repoUrl: "https://github.com/acme/app" }],
      microvms,
      settings,
      launchSpecBase: {
        imageIdentifier: "arn:aws:lambda:us-east-1:1:microvm-image:cursor-worker",
        executionRoleArn: "arn:aws:iam::1:role/x",
        cursorApiKeyParamName: "/cursor/api-key",
        cursorApiUrl: settings.cursorApiUrl,
        cursorAgentEndpoint: settings.cursorAgentEndpoint,
        idleReleaseTimeoutSeconds: 300,
        awsRegion: "us-east-1",
      },
    });
    expect(result.launched).toEqual([expect.objectContaining({ microvmId: "m-1", action: "launch" })]);
    expect(launched).toEqual(["launch"]);
    const persisted = await store.load();
    expect(persisted.slots[0]?.microvmId).toBe("m-1");
    expect(persisted.poolMeta.default?.hasServedWork).toBe(true);
  });
});
