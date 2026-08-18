/**
 * Shared planner types. This file must stay free of AWS (and Cloudflare)
 * imports so the same matching tests can run in vitest.
 */

export type LaunchMode = "serve" | "broadcast" | "warm";

export type SlotStatus = "launching" | "running" | "suspended" | "stopping";

export interface PoolConfig {
  name: string;
  repos: string[];
  maxWorkers?: number;
  minWorkers?: number;
}

export interface ResolvedPool extends PoolConfig {
  maxWorkers: number;
  minWorkers: number;
  /** True after this pool has successfully served at least one repo-backed request. */
  hasServedWork: boolean;
  /** Repos cloned during the last successful serve; used for later broadcast/warm. */
  lastServedRepos: string[];
}

export interface Label {
  key: string;
  value: string;
}

export interface PendingRequest {
  id: string;
  userId?: number | string;
  serviceAccountId?: string;
  repoOwner?: string;
  repoName?: string;
  repoUrl?: string;
  labels?: Label[];
  createdAtMs?: number;
}

export interface SlotSnapshot {
  poolName: string;
  workerName: string;
  status: SlotStatus;
  requestId?: string;
  repoUrls: string[];
  launchedAtMs: number;
  microvmId?: string;
}

export interface CooldownState {
  /** requestId -> cooldown-until epoch ms */
  requestUntilMs: Record<string, number>;
  /** poolName -> last launch epoch ms */
  poolLaunchAtMs: Record<string, number>;
}

export interface LaunchIntent {
  mode: LaunchMode;
  poolName: string;
  workerName: string;
  requestId?: string;
  repoUrls: string[];
  reason: string;
}

export interface SkipReason {
  requestId?: string;
  poolName?: string;
  reason: string;
}

export interface PlanInput {
  pools: ResolvedPool[];
  pending: PendingRequest[];
  slots: SlotSnapshot[];
  cooldowns: CooldownState;
  nowMs: number;
  launchCooldownMs: number;
  poolLaunchCooldownMs: number;
  /** Injected so tests can assert worker names. */
  createWorkerName?: (mode: LaunchMode, poolName: string, requestId?: string) => string;
}

export interface PlanResult {
  intents: LaunchIntent[];
  skipped: SkipReason[];
}

export interface PlannerSettings {
  pools: PoolConfig[];
  maxWorkersPerPool: number;
  minWorkersPerPool: number;
  workerIdleReleaseTimeoutSeconds: number;
  pollIntervalSeconds: number;
  cursorApiUrl: string;
  cursorAgentEndpoint: string;
  launchCooldownMs: number;
  poolLaunchCooldownMs: number;
}

export interface ClaimResult {
  bcId: string;
  workerId: string;
}

export interface PendingRequestsPage {
  requests: PendingRequest[];
  nextPageToken?: string;
  totalCount?: number;
}
