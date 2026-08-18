import { canonicalizeRepoUrl } from "./url.js";
import type { PlannerSettings, PoolConfig, ResolvedPool } from "./types.js";

export const DEFAULT_MAX_WORKERS_PER_POOL = 3;
export const DEFAULT_MIN_WORKERS_PER_POOL = 1;
export const DEFAULT_WORKER_IDLE_RELEASE_TIMEOUT_SECONDS = 300;
export const DEFAULT_POLL_INTERVAL_SECONDS = 60;
export const DEFAULT_CURSOR_API_URL = "https://api.cursor.com";
export const DEFAULT_CURSOR_AGENT_ENDPOINT = "https://api2.cursor.sh";
export const DEFAULT_LAUNCH_COOLDOWN_MS = 60_000;
export const DEFAULT_POOL_LAUNCH_COOLDOWN_MS = 15_000;
export const MAX_RUN_LIFETIME_SECONDS = 28_800;

export interface EnvLike {
  [key: string]: string | undefined;
}

export function parsePoolsJson(raw: string | undefined): PoolConfig[] {
  if (!raw || raw.trim() === "") {
    return [];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`POOLS is not valid JSON: ${error instanceof Error ? error.message : error}`);
  }
  if (!Array.isArray(parsed)) {
    throw new Error("POOLS must be a JSON array of { name, repos, maxWorkers?, minWorkers? }");
  }
  return parsed.map((entry, index) => parsePool(entry, index));
}

function parsePool(entry: unknown, index: number): PoolConfig {
  if (!entry || typeof entry !== "object") {
    throw new Error(`POOLS[${index}] must be an object`);
  }
  const value = entry as Record<string, unknown>;
  const name = typeof value.name === "string" ? value.name.trim() : "";
  if (!name) {
    throw new Error(`POOLS[${index}].name is required`);
  }
  if (!Array.isArray(value.repos) || value.repos.some((repo) => typeof repo !== "string")) {
    throw new Error(`POOLS[${index}].repos must be an array of strings`);
  }
  const repos = (value.repos as string[])
    .map((repo) => repo.trim())
    .filter(Boolean)
    .map((repo) => canonicalizeRepoUrl(repo));
  const maxWorkers = optionalPositiveInt(value.maxWorkers, `POOLS[${index}].maxWorkers`);
  const minWorkers = optionalNonNegativeInt(value.minWorkers, `POOLS[${index}].minWorkers`);
  if (maxWorkers !== undefined && minWorkers !== undefined && minWorkers > maxWorkers) {
    throw new Error(`POOLS[${index}]: minWorkers (${minWorkers}) cannot exceed maxWorkers (${maxWorkers})`);
  }
  return { name, repos, maxWorkers, minWorkers };
}

function optionalPositiveInt(value: unknown, label: string): number | undefined {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`${label} must be a positive integer`);
  }
  return parsed;
}

function optionalNonNegativeInt(value: unknown, label: string): number | undefined {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`${label} must be a non-negative integer`);
  }
  return parsed;
}

function envInt(env: EnvLike, key: string, fallback: number): number {
  const raw = env[key];
  if (raw === undefined || raw === "") {
    return fallback;
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    throw new Error(`${key} must be a number`);
  }
  return parsed;
}

export function loadPlannerSettings(env: EnvLike): PlannerSettings {
  const maxWorkersPerPool = envInt(env, "MAX_WORKERS_PER_POOL", DEFAULT_MAX_WORKERS_PER_POOL);
  const minWorkersPerPool = envInt(env, "MIN_WORKERS_PER_POOL", DEFAULT_MIN_WORKERS_PER_POOL);
  if (maxWorkersPerPool < 1) {
    throw new Error("MAX_WORKERS_PER_POOL must be >= 1");
  }
  if (minWorkersPerPool < 0) {
    throw new Error("MIN_WORKERS_PER_POOL must be >= 0");
  }
  if (minWorkersPerPool > maxWorkersPerPool) {
    throw new Error("MIN_WORKERS_PER_POOL cannot exceed MAX_WORKERS_PER_POOL");
  }
  return {
    pools: parsePoolsJson(env.POOLS),
    maxWorkersPerPool,
    minWorkersPerPool,
    workerIdleReleaseTimeoutSeconds: envInt(
      env,
      "WORKER_IDLE_RELEASE_TIMEOUT_SECONDS",
      DEFAULT_WORKER_IDLE_RELEASE_TIMEOUT_SECONDS,
    ),
    pollIntervalSeconds: envInt(env, "POLL_INTERVAL_SECONDS", DEFAULT_POLL_INTERVAL_SECONDS),
    cursorApiUrl: (env.CURSOR_API_URL || DEFAULT_CURSOR_API_URL).replace(/\/+$/, ""),
    cursorAgentEndpoint: env.CURSOR_AGENT_ENDPOINT || DEFAULT_CURSOR_AGENT_ENDPOINT,
    launchCooldownMs: envInt(env, "LAUNCH_COOLDOWN_MS", DEFAULT_LAUNCH_COOLDOWN_MS),
    poolLaunchCooldownMs: envInt(env, "POOL_LAUNCH_COOLDOWN_MS", DEFAULT_POOL_LAUNCH_COOLDOWN_MS),
  };
}

export function resolvePools(
  settings: PlannerSettings,
  served: Record<string, { hasServedWork: boolean; lastServedRepos: string[] }> = {},
): ResolvedPool[] {
  return settings.pools.map((pool) => {
    const maxWorkers = pool.maxWorkers ?? settings.maxWorkersPerPool;
    const minWorkers = pool.minWorkers ?? settings.minWorkersPerPool;
    const record = served[pool.name];
    return {
      ...pool,
      maxWorkers,
      minWorkers: Math.min(minWorkers, maxWorkers),
      hasServedWork: record?.hasServedWork ?? false,
      lastServedRepos: record?.lastServedRepos ?? [],
    };
  });
}

export function cloneReposForPool(pool: ResolvedPool): string[] {
  if (pool.repos.length > 0) {
    return pool.repos;
  }
  return pool.lastServedRepos;
}
