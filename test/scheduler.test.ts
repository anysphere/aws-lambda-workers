import { describe, expect, it } from "vitest";
import { loadPlannerSettings, poolConfigFingerprint } from "../src/config.js";
import { emptySlotStore, memoryStore } from "../src/slot-state.js";
import { tickOnce } from "../src/scheduler.js";
import type { MicroVmClient } from "../src/microvm.js";

describe("tickOnce", () => {
  it("plans serve then warm and persists slot + request cooldown", async () => {
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
    const settings = loadPlannerSettings({
      POOLS: JSON.stringify([{ name: "default", repos: ["https://github.com/acme/app"], minWorkers: 0 }]),
      MIN_WORKERS_PER_POOL: "0",
    });
    const store = memoryStore({
      ...emptySlotStore(),
      poolConfigFingerprint: poolConfigFingerprint(settings.pools),
    });
    const result = await tickOnce({
      nowMs: () => 50_000,
      loadStore: store.load,
      saveStore: store.save,
      listPending: async () => [
        { id: "bc-1", repoUrl: "https://github.com/acme/app", labels: [], createdAtMs: 1 },
      ],
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
    expect(result.launched).toEqual([
      expect.objectContaining({ microvmId: "m-1", action: "launch", mode: "serve" }),
    ]);
    expect(launched).toEqual(["launch"]);
    const persisted = await store.load();
    expect(persisted.slots[0]?.microvmId).toBe("m-1");
    expect(persisted.slots[0]?.containerName).toBe("pool=default/slot=0");
    expect(persisted.requestLaunchTimes["bc-1"]).toBe(50_000);
  });

  it("broadcasts once when the pool fingerprint changes", async () => {
    const modes: string[] = [];
    const microvms: MicroVmClient = {
      async launch(spec) {
        const payload = JSON.parse(spec.runHookPayload) as { worker: { mode: string } };
        modes.push(payload.worker.mode);
        return { microvmId: `m-${modes.length}` };
      },
      async resume() {},
      async suspend() {},
      async terminate() {},
    };
    const settings = loadPlannerSettings({
      POOLS: JSON.stringify([{ name: "default", repos: ["https://github.com/acme/app"], minWorkers: 0 }]),
      MIN_WORKERS_PER_POOL: "0",
    });
    const store = memoryStore(emptySlotStore());
    const result = await tickOnce({
      nowMs: () => 1,
      loadStore: store.load,
      saveStore: store.save,
      listPending: async () => [],
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
    expect(result.fingerprintChanged).toBe(true);
    expect(modes).toEqual(["broadcast"]);
    const persisted = await store.load();
    expect(persisted.poolConfigFingerprint).toBe(poolConfigFingerprint(settings.pools));
    expect(persisted.slots[0]?.containerName).toBe("pool=default/broadcast");
  });
});
