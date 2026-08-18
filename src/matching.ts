import { cloneReposForPool } from "./config.js";
import { repoIdentityFromUrl, repoUrlsEqual } from "./url.js";
import type {
  CooldownState,
  LaunchIntent,
  LaunchMode,
  PendingRequest,
  PlanInput,
  PlanResult,
  ResolvedPool,
  SkipReason,
  SlotSnapshot,
} from "./types.js";

const ACTIVE_STATUSES = new Set(["launching", "running", "suspended"]);

export function labelValue(request: PendingRequest, key: string): string | undefined {
  return request.labels?.find((label) => label.key === key)?.value;
}

export function requestRepoUrl(request: PendingRequest): string | undefined {
  if (request.repoUrl) {
    return request.repoUrl;
  }
  const fromLabel = labelValue(request, "repo");
  if (fromLabel && fromLabel.includes("://")) {
    return fromLabel;
  }
  if (request.repoOwner && request.repoName) {
    return `https://github.com/${request.repoOwner}/${request.repoName}`;
  }
  if (fromLabel && fromLabel.includes("/")) {
    return `https://github.com/${fromLabel}`;
  }
  return undefined;
}

export function requestHasRepo(request: PendingRequest): boolean {
  return Boolean(requestRepoUrl(request));
}

export function requestPoolName(request: PendingRequest): string | undefined {
  return labelValue(request, "pool");
}

export function poolMatchesRequest(pool: ResolvedPool, request: PendingRequest): boolean {
  const requestedPool = requestPoolName(request);
  if (requestedPool && requestedPool !== pool.name) {
    return false;
  }
  const repoUrl = requestRepoUrl(request);
  if (!repoUrl) {
    // Repo-less demand is pool-label scoped only. Broadcast still refuses
    // until the pool has served work and has a clone.
    return true;
  }
  if (pool.repos.length === 0) {
    // Repo-less pool config: accept any repo-backed request (first serve seeds later broadcast).
    return true;
  }
  return pool.repos.some((repo) => repoUrlsEqual(repo, repoUrl));
}

export function matchingPools(pools: ResolvedPool[], request: PendingRequest): ResolvedPool[] {
  return pools.filter((pool) => poolMatchesRequest(pool, request));
}

export function isActiveSlot(slot: SlotSnapshot): boolean {
  return ACTIVE_STATUSES.has(slot.status);
}

export function slotsForPool(slots: SlotSnapshot[], poolName: string): SlotSnapshot[] {
  return slots.filter((slot) => slot.poolName === poolName && isActiveSlot(slot));
}

export function slotCoversRequest(slot: SlotSnapshot, request: PendingRequest): boolean {
  if (slot.requestId && slot.requestId === request.id) {
    return true;
  }
  const repoUrl = requestRepoUrl(request);
  if (!repoUrl || slot.status === "launching") {
    return slot.requestId === request.id;
  }
  return false;
}

function defaultWorkerName(mode: LaunchMode, poolName: string, requestId?: string): string {
  const suffix = Math.random().toString(16).slice(2, 10);
  if (requestId) {
    const short = requestId.replace(/^bc-/, "").slice(0, 8);
    return `pw_${mode}_${short}_${suffix}`;
  }
  return `pw_${mode}_${poolName}_${suffix}`;
}

function cooldownActive(untilMs: number | undefined, nowMs: number): boolean {
  return typeof untilMs === "number" && untilMs > nowMs;
}

function poolOnLaunchCooldown(cooldowns: CooldownState, poolName: string, nowMs: number, windowMs: number): boolean {
  const last = cooldowns.poolLaunchAtMs[poolName];
  return typeof last === "number" && nowMs - last < windowMs;
}

/**
 * Plan serve / broadcast / warm launches.
 *
 * Serve: one worker per repo-backed pending request that matches a pool
 * with a free slot. Released cursor-agent requires `--worker-dir` to be a
 * git clone, so repo-less requests are never served directly.
 *
 * Broadcast: leftover demand (typically repo-less pending) on a pool that
 * has already served work and therefore has a clone to advertise.
 *
 * Warm: fill minWorkers when the pool already has repos it can clone.
 */
export function planLaunches(input: PlanInput): PlanResult {
  const createWorkerName = input.createWorkerName ?? defaultWorkerName;
  const intents: LaunchIntent[] = [];
  const skipped: SkipReason[] = [];
  const reservedByPool = new Map<string, number>();
  const coveredRequestIds = new Set<string>();

  const reserve = (poolName: string): void => {
    reservedByPool.set(poolName, (reservedByPool.get(poolName) ?? 0) + 1);
  };
  const used = (pool: ResolvedPool): number =>
    slotsForPool(input.slots, pool.name).length + (reservedByPool.get(pool.name) ?? 0);
  const freeSlots = (pool: ResolvedPool): number => Math.max(0, pool.maxWorkers - used(pool));

  const emit = (intent: LaunchIntent): void => {
    intents.push(intent);
    reserve(intent.poolName);
    if (intent.requestId) {
      coveredRequestIds.add(intent.requestId);
    }
  };

  // --- serve --------------------------------------------------------------
  for (const request of input.pending) {
    if (!requestHasRepo(request)) {
      skipped.push({
        requestId: request.id,
        reason: "skip_no_repo: released cursor-agent requires a git clone for --worker-dir",
      });
      continue;
    }
    if (input.slots.some((slot) => slotCoversRequest(slot, request))) {
      coveredRequestIds.add(request.id);
      skipped.push({ requestId: request.id, reason: "already_assigned" });
      continue;
    }
    if (cooldownActive(input.cooldowns.requestUntilMs[request.id], input.nowMs)) {
      skipped.push({ requestId: request.id, reason: "request_cooldown" });
      continue;
    }

    const pools = matchingPools(input.pools, request);
    if (pools.length === 0) {
      skipped.push({ requestId: request.id, reason: "no_matching_pool" });
      continue;
    }

    const pool = pools.find((candidate) => {
      if (freeSlots(candidate) <= 0) {
        return false;
      }
      return !poolOnLaunchCooldown(input.cooldowns, candidate.name, input.nowMs, input.poolLaunchCooldownMs);
    });
    if (!pool) {
      const capacityFull = pools.every((candidate) => freeSlots(candidate) <= 0);
      skipped.push({
        requestId: request.id,
        poolName: pools[0]?.name,
        reason: capacityFull ? "pool_at_capacity" : "pool_launch_cooldown",
      });
      continue;
    }

    const repoUrl = requestRepoUrl(request);
    if (!repoUrl) {
      continue;
    }
    emit({
      mode: "serve",
      poolName: pool.name,
      workerName: createWorkerName("serve", pool.name, request.id),
      requestId: request.id,
      repoUrls: [repoUrl],
      reason: `serve ${request.id} on ${pool.name}`,
    });
  }

  // --- broadcast ----------------------------------------------------------
  for (const pool of input.pools) {
    const leftover = input.pending.filter((request) => {
      if (coveredRequestIds.has(request.id)) {
        return false;
      }
      if (cooldownActive(input.cooldowns.requestUntilMs[request.id], input.nowMs)) {
        return false;
      }
      return poolMatchesRequest(pool, request);
    });
    if (leftover.length === 0) {
      continue;
    }
    if (!pool.hasServedWork) {
      skipped.push({
        poolName: pool.name,
        reason: "broadcast_blocked_until_pool_has_served_work",
      });
      continue;
    }
    const repos = cloneReposForPool(pool);
    if (repos.length === 0) {
      skipped.push({
        poolName: pool.name,
        reason: "broadcast_blocked_no_clone_repos",
      });
      continue;
    }
    if (poolOnLaunchCooldown(input.cooldowns, pool.name, input.nowMs, input.poolLaunchCooldownMs)) {
      skipped.push({ poolName: pool.name, reason: "pool_launch_cooldown" });
      continue;
    }
    const toLaunch = Math.min(leftover.length, freeSlots(pool));
    for (let i = 0; i < toLaunch; i += 1) {
      const request = leftover[i];
      emit({
        mode: "broadcast",
        poolName: pool.name,
        workerName: createWorkerName("broadcast", pool.name, request.id),
        requestId: request.id,
        repoUrls: repos,
        reason: `broadcast leftover demand on ${pool.name}`,
      });
    }
  }

  // --- warm ---------------------------------------------------------------
  for (const pool of input.pools) {
    const deficit = pool.minWorkers - used(pool);
    if (deficit <= 0) {
      continue;
    }
    const repos = cloneReposForPool(pool);
    if (repos.length === 0) {
      skipped.push({
        poolName: pool.name,
        reason: "warm_blocked_no_clone_repos",
      });
      continue;
    }
    if (poolOnLaunchCooldown(input.cooldowns, pool.name, input.nowMs, input.poolLaunchCooldownMs)) {
      skipped.push({ poolName: pool.name, reason: "pool_launch_cooldown" });
      continue;
    }
    for (let i = 0; i < deficit; i += 1) {
      emit({
        mode: "warm",
        poolName: pool.name,
        workerName: createWorkerName("warm", pool.name),
        repoUrls: repos,
        reason: `warm floor ${pool.minWorkers} on ${pool.name}`,
      });
    }
  }

  return { intents, skipped };
}

export function applyLaunchCooldowns(
  cooldowns: CooldownState,
  intents: LaunchIntent[],
  nowMs: number,
  launchCooldownMs: number,
): CooldownState {
  const next: CooldownState = {
    requestUntilMs: { ...cooldowns.requestUntilMs },
    poolLaunchAtMs: { ...cooldowns.poolLaunchAtMs },
  };
  for (const intent of intents) {
    next.poolLaunchAtMs[intent.poolName] = nowMs;
    if (intent.requestId) {
      next.requestUntilMs[intent.requestId] = nowMs + launchCooldownMs;
    }
  }
  return next;
}

export function expireCooldowns(cooldowns: CooldownState, nowMs: number): CooldownState {
  const requestUntilMs: Record<string, number> = {};
  for (const [id, until] of Object.entries(cooldowns.requestUntilMs)) {
    if (until > nowMs) {
      requestUntilMs[id] = until;
    }
  }
  return { requestUntilMs, poolLaunchAtMs: { ...cooldowns.poolLaunchAtMs } };
}

export function describeRequestRepo(request: PendingRequest): string | undefined {
  const url = requestRepoUrl(request);
  if (!url) {
    return undefined;
  }
  const identity = repoIdentityFromUrl(url);
  return identity ? `${identity.owner}/${identity.name}` : url;
}
