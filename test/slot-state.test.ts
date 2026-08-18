import { describe, expect, it } from "vitest";
import { emptySlotStore, gcSlots, recordLaunches, removeSlot } from "../src/slot-state.js";
import type { LaunchIntent } from "../src/types.js";

const intent: LaunchIntent = {
  mode: "serve",
  poolName: "default",
  workerName: "pw_1",
  requestId: "bc-1",
  repoUrls: ["https://github.com/acme/app"],
  reason: "test",
};

describe("recordLaunches", () => {
  it("inserts launching slots, request cooldown, and served-work metadata", () => {
    const next = recordLaunches(emptySlotStore(), [intent], 10_000, 60_000, [
      { intent, microvmId: "m-1" },
    ]);
    expect(next.slots).toEqual([
      expect.objectContaining({
        workerName: "pw_1",
        status: "launching",
        microvmId: "m-1",
        requestId: "bc-1",
      }),
    ]);
    expect(next.cooldowns.requestUntilMs["bc-1"]).toBe(70_000);
    expect(next.poolMeta.default).toEqual({
      hasServedWork: true,
      lastServedRepos: ["https://github.com/acme/app"],
    });
  });

  it("does not mark broadcast/warm as served work", () => {
    const warm: LaunchIntent = { ...intent, mode: "warm", requestId: undefined };
    const next = recordLaunches(emptySlotStore(), [warm], 10_000, 60_000);
    expect(next.poolMeta.default).toBeUndefined();
  });
});

describe("gcSlots", () => {
  it("expires request cooldowns and drops aged stopping slots", () => {
    let store = recordLaunches(emptySlotStore(), [intent], 10_000, 60_000);
    store = removeSlot(store, "default", "pw_1");
    store = {
      ...store,
      slots: [
        {
          poolName: "default",
          workerName: "old",
          status: "stopping",
          repoUrls: [],
          launchedAtMs: 1,
        },
      ],
    };
    const cleaned = gcSlots(store, 100_000, 1_000);
    expect(cleaned.slots).toEqual([]);
    expect(cleaned.cooldowns.requestUntilMs["bc-1"]).toBeUndefined();
  });
});
