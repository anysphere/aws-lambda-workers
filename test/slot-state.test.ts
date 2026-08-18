import { describe, expect, it } from "vitest";
import { emptySlotStore, gcSlots, plannerSlotsByPool, recordLaunches, runningFromMicrovmStatus } from "../src/slot-state.js";
import { containerNameForSlot, REQUEST_RECORD_TTL_MS } from "../src/matching.js";
import type { PlannedLaunch } from "../src/types.js";

const launch: PlannedLaunch = {
  containerName: containerNameForSlot("default", 0),
  slotIndex: 0,
  spec: {
    mode: "serve",
    poolName: "default",
    workerName: "aws-default-0",
    requestId: "bc-1",
    repoUrls: ["https://github.com/acme/app"],
  },
};

describe("recordLaunches", () => {
  it("inserts a slot, request launch time, and planner running flag", () => {
    const next = recordLaunches(emptySlotStore(), [launch], 10_000, [
      { launch, microvmId: "m-1" },
    ]);
    expect(next.slots).toEqual([
      expect.objectContaining({
        workerName: "aws-default-0",
        containerName: "pool=default/slot=0",
        slotIndex: 0,
        running: true,
        status: "launching",
        microvmId: "m-1",
        requestId: "bc-1",
      }),
    ]);
    expect(next.requestLaunchTimes["bc-1"]).toBe(10_000);
    expect(plannerSlotsByPool(next).default?.[0]).toEqual({
      slotIndex: 0,
      running: true,
      lastLaunchAtMs: 10_000,
    });
  });

  it("maps suspended MicroVMs as running for the warm floor", () => {
    expect(runningFromMicrovmStatus("suspended")).toBe(true);
    expect(runningFromMicrovmStatus("running")).toBe(true);
    expect(runningFromMicrovmStatus("stopped")).toBe(false);
  });
});

describe("gcSlots", () => {
  it("expires request launch times older than REQUEST_RECORD_TTL_MS", () => {
    let store = recordLaunches(emptySlotStore(), [launch], 10_000);
    store = {
      ...store,
      slots: [{ ...store.slots[0]!, status: "stopped", running: false }],
    };
    const cleaned = gcSlots(store, 10_000 + REQUEST_RECORD_TTL_MS + 1);
    expect(cleaned.slots).toEqual([]);
    expect(cleaned.requestLaunchTimes["bc-1"]).toBeUndefined();
  });
});
