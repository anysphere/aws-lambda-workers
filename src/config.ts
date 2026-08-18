/**
 * Pool config + planner knobs. Platform-free (no AWS / Cloudflare imports).
 */

import type { PoolConfig } from "./types.js";

export const DEFAULT_MAX_WORKERS_PER_POOL = 3;
export const DEFAULT_MIN_WORKERS_PER_POOL = 1;
export const DEFAULT_POLL_INTERVAL_SECONDS = 20;
export const DEFAULT_WORKER_IDLE_RELEASE_TIMEOUT_SECONDS = 300;
export const DEFAULT_CURSOR_API_URL = "https://api.cursor.com";
export const DEFAULT_CURSOR_AGENT_ENDPOINT = "https://api2.cursor.sh";
export const MAX_RUN_LIFETIME_SECONDS = 28_800;

export interface EnvLike {
  [key: string]: string | undefined;
}

export interface PlannerSettings {
  pools: PoolConfig[];
  maxWorkersPerPool: number;
  minWorkersPerPool: number;
  workerIdleReleaseTimeoutSeconds: number;
  pollIntervalSeconds: number;
  cursorApiUrl: string;
  cursorAgentEndpoint: string;
}

export function parsePositiveInt(raw: string | undefined, label: string, fallback: number): number {
  if (raw === undefined || raw === "") {
    return fallback;
  }
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`${label} must be a positive integer`);
  }
  return parsed;
}

export function parseNonNegativeInt(raw: string | undefined, label: string, fallback: number): number {
  if (raw === undefined || raw === "") {
    return fallback;
  }
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`${label} must be a non-negative integer`);
  }
  return parsed;
}

/**
 * Parse the POOLS JSON array. Missing / blank input is an error — same as
 * Cloudflare requiring the var, with the SAM parameter / env var named.
 */
export function parsePoolsConfig(raw: string | undefined): PoolConfig[] {
  if (!raw || raw.trim() === "") {
    throw new Error(
      "POOLS is required. Set the SAM Pools parameter or the POOLS environment variable to a JSON array of { name, repos, maxWorkers?, minWorkers? }.",
    );
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
  const repos = (value.repos as string[]).map((repo) => repo.trim()).filter(Boolean);
  const maxWorkers =
    value.maxWorkers === undefined || value.maxWorkers === null || value.maxWorkers === ""
      ? undefined
      : parsePositiveInt(String(value.maxWorkers), `POOLS[${index}].maxWorkers`, 1);
  const minWorkers =
    value.minWorkers === undefined || value.minWorkers === null || value.minWorkers === ""
      ? undefined
      : parseNonNegativeInt(String(value.minWorkers), `POOLS[${index}].minWorkers`, 0);
  if (maxWorkers !== undefined && minWorkers !== undefined && minWorkers > maxWorkers) {
    throw new Error(`POOLS[${index}]: minWorkers (${minWorkers}) cannot exceed maxWorkers (${maxWorkers})`);
  }
  return { name, repos, maxWorkers, minWorkers };
}

/** Stable fingerprint of pool names + clone URLs. A change triggers broadcast. */
export function poolConfigFingerprint(pools: readonly PoolConfig[]): string {
  const normalized = [...pools]
    .map((pool) => ({
      name: pool.name,
      repos: [...pool.repos],
      maxWorkers: pool.maxWorkers ?? null,
      minWorkers: pool.minWorkers ?? null,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
  return JSON.stringify(normalized);
}

export function loadPlannerSettings(env: EnvLike): PlannerSettings {
  const maxWorkersPerPool = parsePositiveInt(env.MAX_WORKERS_PER_POOL, "MAX_WORKERS_PER_POOL", DEFAULT_MAX_WORKERS_PER_POOL);
  const minWorkersPerPool = parseNonNegativeInt(
    env.MIN_WORKERS_PER_POOL,
    "MIN_WORKERS_PER_POOL",
    DEFAULT_MIN_WORKERS_PER_POOL,
  );
  if (minWorkersPerPool > maxWorkersPerPool) {
    throw new Error("MIN_WORKERS_PER_POOL cannot exceed MAX_WORKERS_PER_POOL");
  }
  return {
    pools: parsePoolsConfig(env.POOLS),
    maxWorkersPerPool,
    minWorkersPerPool,
    workerIdleReleaseTimeoutSeconds: parsePositiveInt(
      env.WORKER_IDLE_RELEASE_TIMEOUT_SECONDS,
      "WORKER_IDLE_RELEASE_TIMEOUT_SECONDS",
      DEFAULT_WORKER_IDLE_RELEASE_TIMEOUT_SECONDS,
    ),
    pollIntervalSeconds: parsePositiveInt(
      env.POLL_INTERVAL_SECONDS,
      "POLL_INTERVAL_SECONDS",
      DEFAULT_POLL_INTERVAL_SECONDS,
    ),
    cursorApiUrl: (env.CURSOR_API_URL || DEFAULT_CURSOR_API_URL).replace(/\/+$/, ""),
    cursorAgentEndpoint: env.CURSOR_AGENT_ENDPOINT || DEFAULT_CURSOR_AGENT_ENDPOINT,
  };
}

export function resolvedMaxWorkers(pool: PoolConfig, maxWorkersPerPool: number): number {
  return pool.maxWorkers ?? maxWorkersPerPool;
}

export function resolvedMinWorkers(pool: PoolConfig, minWorkersPerPool: number, maxWorkersPerPool: number): number {
  return Math.min(pool.minWorkers ?? minWorkersPerPool, resolvedMaxWorkers(pool, maxWorkersPerPool));
}
