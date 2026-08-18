import { describe, expect, it } from "vitest";
import {
  DEFAULT_MAX_WORKERS_PER_POOL,
  DEFAULT_MIN_WORKERS_PER_POOL,
  loadPlannerSettings,
  parsePoolsJson,
  resolvePools,
} from "../src/config.js";

describe("parsePoolsJson", () => {
  it("returns an empty list for missing or blank input", () => {
    expect(parsePoolsJson(undefined)).toEqual([]);
    expect(parsePoolsJson("")).toEqual([]);
    expect(parsePoolsJson("   ")).toEqual([]);
  });

  it("parses pool name, repos, and optional caps", () => {
    const pools = parsePoolsJson(
      JSON.stringify([
        { name: "gpu", repos: ["https://github.com/Acme/Repo.git"], maxWorkers: 5, minWorkers: 2 },
      ]),
    );
    expect(pools).toEqual([
      {
        name: "gpu",
        repos: ["https://github.com/acme/repo"],
        maxWorkers: 5,
        minWorkers: 2,
      },
    ]);
  });

  it("rejects invalid JSON and malformed entries", () => {
    expect(() => parsePoolsJson("{")).toThrow(/not valid JSON/);
    expect(() => parsePoolsJson("{}")).toThrow(/JSON array/);
    expect(() => parsePoolsJson(JSON.stringify([{ repos: [] }]))).toThrow(/name is required/);
    expect(() => parsePoolsJson(JSON.stringify([{ name: "p", repos: "nope" }]))).toThrow(/repos must be an array/);
    expect(() =>
      parsePoolsJson(JSON.stringify([{ name: "p", repos: [], maxWorkers: 1, minWorkers: 2 }])),
    ).toThrow(/cannot exceed maxWorkers/);
  });
});

describe("loadPlannerSettings", () => {
  it("applies Cloudflare-compatible defaults", () => {
    const settings = loadPlannerSettings({
      POOLS: JSON.stringify([{ name: "default", repos: ["https://github.com/acme/app"] }]),
    });
    expect(settings.maxWorkersPerPool).toBe(DEFAULT_MAX_WORKERS_PER_POOL);
    expect(settings.minWorkersPerPool).toBe(DEFAULT_MIN_WORKERS_PER_POOL);
    expect(settings.workerIdleReleaseTimeoutSeconds).toBe(300);
    expect(settings.pollIntervalSeconds).toBe(60);
    expect(settings.cursorApiUrl).toBe("https://api.cursor.com");
    expect(settings.pools).toHaveLength(1);
  });

  it("rejects inverted global min/max", () => {
    expect(() =>
      loadPlannerSettings({
        MAX_WORKERS_PER_POOL: "1",
        MIN_WORKERS_PER_POOL: "3",
      }),
    ).toThrow(/cannot exceed/);
  });
});

describe("resolvePools", () => {
  it("fills defaults and served-work metadata", () => {
    const settings = loadPlannerSettings({
      POOLS: JSON.stringify([{ name: "sandbox", repos: [] }]),
      MAX_WORKERS_PER_POOL: "4",
      MIN_WORKERS_PER_POOL: "2",
    });
    const resolved = resolvePools(settings, {
      sandbox: { hasServedWork: true, lastServedRepos: ["https://github.com/acme/app"] },
    });
    expect(resolved[0]).toMatchObject({
      name: "sandbox",
      maxWorkers: 4,
      minWorkers: 2,
      hasServedWork: true,
      lastServedRepos: ["https://github.com/acme/app"],
    });
  });
});
