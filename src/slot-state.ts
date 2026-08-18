/**
 * In-memory slot / cooldown store. DynamoDB is one adapter; tests use this
 * object directly so planning logic stays platform-free.
 */

import { applyLaunchCooldowns, expireCooldowns } from "./matching.js";
import type { CooldownState, LaunchIntent, SlotSnapshot, SlotStatus } from "./types.js";

export interface PoolMeta {
  hasServedWork: boolean;
  lastServedRepos: string[];
}

export interface SlotStore {
  slots: SlotSnapshot[];
  cooldowns: CooldownState;
  poolMeta: Record<string, PoolMeta>;
}

export function emptySlotStore(): SlotStore {
  return {
    slots: [],
    cooldowns: { requestUntilMs: {}, poolLaunchAtMs: {} },
    poolMeta: {},
  };
}

export function upsertSlot(store: SlotStore, slot: SlotSnapshot): SlotStore {
  const slots = store.slots.filter(
    (existing) => !(existing.poolName === slot.poolName && existing.workerName === slot.workerName),
  );
  slots.push(slot);
  return { ...store, slots };
}

export function markSlotStatus(
  store: SlotStore,
  poolName: string,
  workerName: string,
  status: SlotStatus,
  extras: Partial<SlotSnapshot> = {},
): SlotStore {
  const existing = store.slots.find((slot) => slot.poolName === poolName && slot.workerName === workerName);
  if (!existing) {
    return store;
  }
  return upsertSlot(store, { ...existing, ...extras, status });
}

export function removeSlot(store: SlotStore, poolName: string, workerName: string): SlotStore {
  return {
    ...store,
    slots: store.slots.filter((slot) => !(slot.poolName === poolName && slot.workerName === workerName)),
  };
}

export function recordLaunches(
  store: SlotStore,
  intents: LaunchIntent[],
  nowMs: number,
  launchCooldownMs: number,
  launched: Array<{ intent: LaunchIntent; microvmId?: string }> = [],
): SlotStore {
  let next: SlotStore = {
    ...store,
    cooldowns: applyLaunchCooldowns(store.cooldowns, intents, nowMs, launchCooldownMs),
  };
  for (const { intent, microvmId } of launched.length > 0
    ? launched
    : intents.map((intent) => ({ intent, microvmId: undefined }))) {
    next = upsertSlot(next, {
      poolName: intent.poolName,
      workerName: intent.workerName,
      status: "launching",
      requestId: intent.requestId,
      repoUrls: intent.repoUrls,
      launchedAtMs: nowMs,
      microvmId,
    });
    if (intent.mode === "serve" && intent.repoUrls.length > 0) {
      next = {
        ...next,
        poolMeta: {
          ...next.poolMeta,
          [intent.poolName]: {
            hasServedWork: true,
            lastServedRepos: intent.repoUrls,
          },
        },
      };
    }
  }
  return next;
}

export function gcSlots(store: SlotStore, nowMs: number, maxAgeMs: number): SlotStore {
  return {
    ...store,
    slots: store.slots.filter((slot) => {
      if (slot.status === "stopping") {
        return nowMs - slot.launchedAtMs < maxAgeMs;
      }
      return true;
    }),
    cooldowns: expireCooldowns(store.cooldowns, nowMs),
  };
}

export function servedRecord(store: SlotStore): Record<string, PoolMeta> {
  return store.poolMeta;
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
