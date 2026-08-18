import { describe, expect, it } from "vitest";
import {
  DEFAULT_MAX_WORKERS_PER_POOL,
  DEFAULT_MIN_WORKERS_PER_POOL,
  DEFAULT_POLL_INTERVAL_SECONDS,
  DEFAULT_WORKER_IDLE_RELEASE_TIMEOUT_SECONDS,
  loadPlannerSettings,
  parseNonNegativeInt,
  parsePoolsConfig,
  parsePositiveInt,
  poolConfigFingerprint,
} from "../src/config.js";

describe("parsePoolsConfig", () => {
  it("throws when POOLS is missing (SAM parameter / env var)", () => {
    expect(() => parsePoolsConfig(undefined)).toThrow(/SAM Pools parameter|POOLS environment variable/);
    expect(() => parsePoolsConfig("")).toThrow(/SAM Pools parameter|POOLS environment variable/);
  });

  it("parses pool name, repos, and optional caps without rewriting clone URLs", () => {
    const pools = parsePoolsConfig(
      JSON.stringify([
        { name: "gpu", repos: ["https://github.com/Acme/Repo.git"], maxWorkers: 5, minWorkers: 2 },
      ]),
    );
    expect(pools).toEqual([
      {
        name: "gpu",
        repos: ["https://github.com/Acme/Repo.git"],
        maxWorkers: 5,
        minWorkers: 2,
      },
    ]);
  });

  it("rejects invalid JSON and malformed entries", () => {
    expect(() => parsePoolsConfig("{")).toThrow(/not valid JSON/);
    expect(() => parsePoolsConfig("{}")).toThrow(/JSON array/);
    expect(() => parsePoolsConfig(JSON.stringify([{ repos: [] }]))).toThrow(/name is required/);
    expect(() => parsePoolsConfig(JSON.stringify([{ name: "p", repos: "nope" }]))).toThrow(/repos must be an array/);
    expect(() =>
      parsePoolsConfig(JSON.stringify([{ name: "p", repos: [], maxWorkers: 1, minWorkers: 2 }])),
    ).toThrow(/cannot exceed maxWorkers/);
  });
});

describe("parsePositiveInt / parseNonNegativeInt", () => {
  it("applies fallbacks and rejects bad values", () => {
    expect(parsePositiveInt(undefined, "X", 3)).toBe(3);
    expect(parseNonNegativeInt(undefined, "Y", 0)).toBe(0);
    expect(() => parsePositiveInt("0", "X", 3)).toThrow(/positive/);
    expect(() => parseNonNegativeInt("-1", "Y", 0)).toThrow(/non-negative/);
  });
});

describe("poolConfigFingerprint", () => {
  it("changes when a pool's repo list changes", () => {
    const a = poolConfigFingerprint([{ name: "default", repos: ["https://github.com/acme/app"] }]);
    const b = poolConfigFingerprint([{ name: "default", repos: ["https://github.com/acme/app", "https://github.com/acme/lib"] }]);
    expect(a).not.toBe(b);
    expect(a).toBe(poolConfigFingerprint([{ name: "default", repos: ["https://github.com/acme/app"] }]));
  });
});

describe("loadPlannerSettings", () => {
  it("applies Cloudflare-compatible defaults (MAX 3, MIN 1, POLL 20, IDLE 300)", () => {
    const settings = loadPlannerSettings({
      POOLS: JSON.stringify([{ name: "default", repos: ["https://github.com/acme/app"] }]),
    });
    expect(settings.maxWorkersPerPool).toBe(DEFAULT_MAX_WORKERS_PER_POOL);
    expect(settings.minWorkersPerPool).toBe(DEFAULT_MIN_WORKERS_PER_POOL);
    expect(settings.workerIdleReleaseTimeoutSeconds).toBe(DEFAULT_WORKER_IDLE_RELEASE_TIMEOUT_SECONDS);
    expect(settings.pollIntervalSeconds).toBe(DEFAULT_POLL_INTERVAL_SECONDS);
    expect(DEFAULT_MAX_WORKERS_PER_POOL).toBe(3);
    expect(DEFAULT_MIN_WORKERS_PER_POOL).toBe(1);
    expect(DEFAULT_POLL_INTERVAL_SECONDS).toBe(20);
    expect(DEFAULT_WORKER_IDLE_RELEASE_TIMEOUT_SECONDS).toBe(300);
    expect(settings.cursorApiUrl).toBe("https://api.cursor.com");
    expect(settings.pools).toHaveLength(1);
  });

  it("rejects inverted global min/max", () => {
    expect(() =>
      loadPlannerSettings({
        POOLS: "[]",
        MAX_WORKERS_PER_POOL: "1",
        MIN_WORKERS_PER_POOL: "3",
      }),
    ).toThrow(/cannot exceed/);
  });
});
