/**
 * In-memory slot / request-cooldown store. DynamoDB is one adapter; tests
 * use this object directly so planning logic stays platform-free.
 */

import {
  containerNameForSlot,
  pruneRequestLaunchTimes,
  REQUEST_RECORD_TTL_MS,
} from "./matching.js";
import type { LaunchMode, PlannedLaunch, SlotState } from "./types.js";

export type AwsSlotStatus = "launching" | "running" | "suspended" | "stopped";

export interface AwsSlot {
  poolName: string;
  slotIndex: number;
  containerName: string;
  workerName: string;
  /**
   * Planner `running` flag. True for a live MicroVM or a suspended one we
   * keep as the warm floor.
   */
  running: boolean;
  status: AwsSlotStatus;
  lastLaunchAtMs?: number;
  microvmId?: string;
  requestId?: string;
  repoUrls: string[];
  mode?: LaunchMode;
}

export interface SlotStore {
  slots: AwsSlot[];
  requestLaunchTimes: Record<string, number>;
  poolConfigFingerprint?: string;
}

export function emptySlotStore(): SlotStore {
  return {
    slots: [],
    requestLaunchTimes: {},
  };
}

export function plannerSlotsByPool(store: SlotStore): Record<string, SlotState[]> {
  const byPool: Record<string, SlotState[]> = {};
  for (const slot of store.slots) {
    if (slot.slotIndex < 0) {
      continue;
    }
    const list = byPool[slot.poolName] ?? [];
    list.push({
      slotIndex: slot.slotIndex,
      running: slot.running,
      lastLaunchAtMs: slot.lastLaunchAtMs,
    });
    byPool[slot.poolName] = list;
  }
  return byPool;
}

/** Live or suspended MicroVMs occupy the warm floor. */
export function runningFromMicrovmStatus(status: AwsSlotStatus): boolean {
  return status === "launching" || status === "running" || status === "suspended";
}

export function upsertSlot(store: SlotStore, slot: AwsSlot): SlotStore {
  const slots = store.slots.filter(
    (existing) =>
      !(existing.poolName === slot.poolName && existing.containerName === slot.containerName),
  );
  slots.push(slot);
  return { ...store, slots };
}

export function recordLaunches(
  store: SlotStore,
  launches: readonly PlannedLaunch[],
  nowMs: number,
  launched: Array<{ launch: PlannedLaunch; microvmId?: string; status?: AwsSlotStatus }> = [],
): SlotStore {
  let next: SlotStore = {
    ...store,
    requestLaunchTimes: { ...store.requestLaunchTimes },
  };
  const applied: Array<{ launch: PlannedLaunch; microvmId?: string; status?: AwsSlotStatus }> =
    launched.length > 0 ? launched : launches.map((item) => ({ launch: item }));
  for (const { launch, microvmId, status } of applied) {
    const slotStatus = status ?? "launching";
    next = upsertSlot(next, {
      poolName: launch.spec.poolName,
      slotIndex: launch.slotIndex,
      containerName: launch.containerName,
      workerName: launch.spec.workerName,
      running: runningFromMicrovmStatus(slotStatus),
      status: slotStatus,
      lastLaunchAtMs: nowMs,
      microvmId,
      requestId: launch.spec.requestId,
      repoUrls: [...launch.spec.repoUrls],
      mode: launch.spec.mode,
    });
    if (launch.spec.requestId) {
      next.requestLaunchTimes[launch.spec.requestId] = nowMs;
    }
  }
  return next;
}

export function gcSlots(store: SlotStore, nowMs: number): SlotStore {
  return {
    ...store,
    slots: store.slots.filter((slot) => slot.status !== "stopped"),
    requestLaunchTimes: pruneRequestLaunchTimes(store.requestLaunchTimes, nowMs),
  };
}

export function findSlot(store: SlotStore, poolName: string, slotIndex: number): AwsSlot | undefined {
  const containerName = containerNameForSlot(poolName, slotIndex);
  return store.slots.find((slot) => slot.poolName === poolName && slot.containerName === containerName);
}

export function memoryStore(initial?: SlotStore): {
  load: () => Promise<SlotStore>;
  save: (store: SlotStore) => Promise<void>;
} {
  let current = initial ?? emptySlotStore();
  return {
    async load() {
      return current;
    },
    async save(store) {
      current = store;
    },
  };
}

export { REQUEST_RECORD_TTL_MS };
