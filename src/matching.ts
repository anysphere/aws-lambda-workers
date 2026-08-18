/**
 * Shared matching / planning for Cursor private-worker pools.
 *
 * This module is intentionally free of AWS and Cloudflare imports so the
 * same functions can be unit-tested under plain node/vitest.
 */

import type { LaunchSpec, PendingRequest, PlannedLaunch, PoolConfig, SlotState } from "./types.js";
import { canonicalizeUrl } from "./url.js";

/** Pending requests with no `pool` label target this pool. */
export const DEFAULT_POOL_NAME = "default";

/** Per-slot and per-request cooldown after a launch. */
export const LAUNCH_COOLDOWN_MS = 120_000;

/** How long a requestLaunchTimes entry is kept for cooldown / GC. */
export const REQUEST_RECORD_TTL_MS = 15 * 60 * 1000;

const POOL_LABEL_KEY = "pool";

export function repoKeyFromOwnerName(owner: string, name: string): string {
  return `${owner.trim().toLowerCase()}/${name.trim().toLowerCase()}`;
}

/**
 * Identity used for matching: lowercase owner/name, or GitLab nested
 * groups (`group/sub/repo`). Host is ignored so ssh / https / git@ of the
 * same path compare equal.
 */
export function repoKeyFromUrl(raw: string | undefined): string | undefined {
  if (!raw) {
    return undefined;
  }
  const trimmed = raw.trim();
  if (!trimmed) {
    return undefined;
  }

  const scp = /^[\w.-]+@([^:/]+):(.+)$/.exec(trimmed);
  if (scp) {
    return pathToRepoKey(scp[2]);
  }

  try {
    return pathToRepoKey(canonicalizeUrl(trimmed).pathname);
  } catch {
    if (trimmed.includes("/") && !/\s/.test(trimmed)) {
      return pathToRepoKey(trimmed);
    }
    return undefined;
  }
}

function pathToRepoKey(path: string): string | undefined {
  let normalized = path.replace(/^\/+/, "").replace(/\/+$/, "");
  if (normalized.toLowerCase().endsWith(".git")) {
    normalized = normalized.slice(0, -4);
  }
  const parts = normalized.split("/").filter(Boolean);
  if (parts.length < 2) {
    return undefined;
  }
  return parts.map((part) => part.toLowerCase()).join("/");
}

export function requestRepoKey(request: PendingRequest): string | undefined {
  const fromUrl = repoKeyFromUrl(request.repoUrl);
  if (fromUrl) {
    return fromUrl;
  }
  if (request.repoOwner && request.repoName) {
    return repoKeyFromOwnerName(request.repoOwner, request.repoName);
  }
  return undefined;
}

export function poolNameFromRequest(request: PendingRequest): string {
  const label = request.labels.find((entry) => entry.key === POOL_LABEL_KEY)?.value?.trim();
  return label || DEFAULT_POOL_NAME;
}

/**
 * A request matches a pool only when the pool label agrees and a repo
 * identity can be resolved. An empty `pool.repos` ("any repo") still
 * requires `request.repoUrl` so the worker has something to clone.
 */
export function requestMatchesPool(request: PendingRequest, pool: PoolConfig): boolean {
  if (poolNameFromRequest(request) !== pool.name) {
    return false;
  }
  const key = requestRepoKey(request);
  if (!key) {
    return false;
  }
  if (pool.repos.length === 0) {
    return Boolean(request.repoUrl && repoKeyFromUrl(request.repoUrl));
  }
  return pool.repos.some((repo) => repoKeyFromUrl(repo) === key);
}

/** Clone the pool's full repo list when configured, else the request repo. */
export function repoUrlsForLaunch(request: PendingRequest, pool: PoolConfig): string[] {
  if (pool.repos.length > 0) {
    return [...pool.repos];
  }
  return request.repoUrl ? [request.repoUrl] : [];
}

export function containerNameForSlot(poolName: string, slotIndex: number): string {
  return `pool=${poolName}/slot=${slotIndex}`;
}

export function containerNameForBroadcast(poolName: string): string {
  return `pool=${poolName}/broadcast`;
}

export function workerNameForSlot(poolName: string, slotIndex: number): string {
  return `aws-${poolName}-${slotIndex}`;
}

export function workerNameForBroadcast(poolName: string): string {
  return `aws-${poolName}-broadcast`;
}

export function slotOnCooldown(slot: SlotState, nowMs: number): boolean {
  return typeof slot.lastLaunchAtMs === "number" && nowMs - slot.lastLaunchAtMs < LAUNCH_COOLDOWN_MS;
}

export function requestOnCooldown(
  requestLaunchTimes: Readonly<Record<string, number>>,
  requestId: string,
  nowMs: number,
): boolean {
  const last = requestLaunchTimes[requestId];
  return typeof last === "number" && nowMs - last < LAUNCH_COOLDOWN_MS;
}

export function isSlotFree(slot: SlotState, nowMs: number): boolean {
  return slot.running !== true && !slotOnCooldown(slot, nowMs);
}

export function materializeSlots(existing: readonly SlotState[] | undefined, maxWorkers: number): SlotState[] {
  const byIndex = new Map((existing ?? []).map((slot) => [slot.slotIndex, slot]));
  const slots: SlotState[] = [];
  for (let slotIndex = 0; slotIndex < maxWorkers; slotIndex += 1) {
    slots.push(byIndex.get(slotIndex) ?? { slotIndex, running: false });
  }
  return slots;
}

function makeLaunch(input: {
  poolName: string;
  slotIndex: number;
  spec: LaunchSpec;
}): PlannedLaunch {
  return {
    containerName: containerNameForSlot(input.poolName, input.slotIndex),
    slotIndex: input.slotIndex,
    spec: input.spec,
  };
}

export interface PlanLaunchesInput {
  readonly pools: readonly PoolConfig[];
  readonly pending: readonly PendingRequest[];
  readonly slotsByPool: Readonly<Record<string, readonly SlotState[]>>;
  readonly requestLaunchTimes: Readonly<Record<string, number>>;
  readonly nowMs: number;
  readonly maxWorkersPerPool: number;
}

/**
 * Serve launches: oldest pending request wins. Each request takes the first
 * matching pool that still has a free slot (not running, not in cooldown).
 * There is no per-pool "one launch per window" lock.
 */
export function planLaunches(input: PlanLaunchesInput): PlannedLaunch[] {
  const reserved = new Set<string>();
  const launches: PlannedLaunch[] = [];
  const pending = [...input.pending].sort((a, b) => a.createdAtMs - b.createdAtMs);

  for (const request of pending) {
    if (requestOnCooldown(input.requestLaunchTimes, request.id, input.nowMs)) {
      continue;
    }
    for (const pool of input.pools) {
      if (!requestMatchesPool(request, pool)) {
        continue;
      }
      const maxWorkers = pool.maxWorkers ?? input.maxWorkersPerPool;
      const slots = materializeSlots(input.slotsByPool[pool.name], maxWorkers);
      const free = slots.find((slot) => {
        const name = containerNameForSlot(pool.name, slot.slotIndex);
        return !reserved.has(name) && isSlotFree(slot, input.nowMs);
      });
      if (!free) {
        continue;
      }
      const repoUrls = repoUrlsForLaunch(request, pool);
      if (repoUrls.length === 0) {
        continue;
      }
      const containerName = containerNameForSlot(pool.name, free.slotIndex);
      reserved.add(containerName);
      launches.push(
        makeLaunch({
          poolName: pool.name,
          slotIndex: free.slotIndex,
          spec: {
            mode: "serve",
            poolName: pool.name,
            repoUrls,
            workerName: workerNameForSlot(pool.name, free.slotIndex),
            requestId: request.id,
          },
        }),
      );
      break;
    }
  }

  return launches;
}

export interface PlanWarmLaunchesInput {
  readonly pools: readonly PoolConfig[];
  readonly slotsByPool: Readonly<Record<string, readonly SlotState[]>>;
  readonly reservedContainerNames: ReadonlySet<string>;
  readonly nowMs: number;
  readonly minWorkersPerPool: number;
  readonly maxWorkersPerPool: number;
}

/**
 * Warm floor: only pools that already have clone URLs. `running` includes a
 * live MicroVM or a suspended one we are keeping as the floor. Slots reserved
 * by serve this tick count toward minWorkers and are not launched as warm.
 */
export function planWarmLaunches(input: PlanWarmLaunchesInput): PlannedLaunch[] {
  const reserved = new Set(input.reservedContainerNames);
  const launches: PlannedLaunch[] = [];

  for (const pool of input.pools) {
    if (pool.repos.length === 0) {
      continue;
    }
    const maxWorkers = pool.maxWorkers ?? input.maxWorkersPerPool;
    const minWorkers = pool.minWorkers ?? input.minWorkersPerPool;
    const slots = materializeSlots(input.slotsByPool[pool.name], maxWorkers);
    const occupied = slots.filter((slot) => {
      const name = containerNameForSlot(pool.name, slot.slotIndex);
      return slot.running === true || reserved.has(name);
    }).length;
    let need = Math.max(0, minWorkers - occupied);
    if (need === 0) {
      continue;
    }
    for (const slot of slots) {
      if (need <= 0) {
        break;
      }
      const containerName = containerNameForSlot(pool.name, slot.slotIndex);
      if (reserved.has(containerName) || !isSlotFree(slot, input.nowMs)) {
        continue;
      }
      reserved.add(containerName);
      launches.push(
        makeLaunch({
          poolName: pool.name,
          slotIndex: slot.slotIndex,
          spec: {
            mode: "warm",
            poolName: pool.name,
            repoUrls: [...pool.repos],
            workerName: workerNameForSlot(pool.name, slot.slotIndex),
          },
        }),
      );
      need -= 1;
    }
  }

  return launches;
}

export function planBroadcastLaunch(pool: PoolConfig): PlannedLaunch {
  return {
    containerName: containerNameForBroadcast(pool.name),
    slotIndex: -1,
    spec: {
      mode: "broadcast",
      poolName: pool.name,
      repoUrls: [...pool.repos],
      workerName: workerNameForBroadcast(pool.name),
    },
  };
}

export function pruneRequestLaunchTimes(
  requestLaunchTimes: Readonly<Record<string, number>>,
  nowMs: number,
): Record<string, number> {
  const next: Record<string, number> = {};
  for (const [id, atMs] of Object.entries(requestLaunchTimes)) {
    if (nowMs - atMs < REQUEST_RECORD_TTL_MS) {
      next[id] = atMs;
    }
  }
  return next;
}

export function reservedContainerNames(launches: readonly PlannedLaunch[]): Set<string> {
  return new Set(launches.map((launch) => launch.containerName));
}
