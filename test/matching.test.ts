import { describe, expect, it } from "vitest";
import { loadPlannerSettings, resolvePools } from "../src/config.js";
import {
  applyLaunchCooldowns,
  matchingPools,
  planLaunches,
  requestHasRepo,
  requestRepoUrl,
} from "../src/matching.js";
import type { CooldownState, PendingRequest, PlanInput, ResolvedPool, SlotSnapshot } from "../src/types.js";

function pool(overrides: Partial<ResolvedPool> = {}): ResolvedPool {
  return {
    name: "default",
    repos: ["https://github.com/acme/app"],
    maxWorkers: 3,
    minWorkers: 1,
    hasServedWork: false,
    lastServedRepos: [],
    ...overrides,
  };
}

function request(overrides: Partial<PendingRequest> = {}): PendingRequest {
  return {
    id: "bc-11111111-1111-1111-1111-111111111111",
    repoUrl: "https://github.com/acme/app",
    labels: [{ key: "repo", value: "acme/app" }],
    createdAtMs: 1,
    ...overrides,
  };
}

function plan(overrides: Partial<PlanInput> = {}) {
  const names = new Map<string, number>();
  return planLaunches({
    pools: [pool()],
    pending: [request()],
    slots: [],
    cooldowns: { requestUntilMs: {}, poolLaunchAtMs: {} },
    nowMs: 1_000_000,
    launchCooldownMs: 60_000,
    poolLaunchCooldownMs: 15_000,
    createWorkerName: (mode, poolName, requestId) => {
      const key = `${mode}:${poolName}:${requestId ?? ""}`;
      const n = (names.get(key) ?? 0) + 1;
      names.set(key, n);
      return `pw_${mode}_${n}`;
    },
    ...overrides,
  });
}

describe("request matching helpers", () => {
  it("extracts repo URLs from fields, labels, and owner/name", () => {
    expect(requestRepoUrl(request())).toBe("https://github.com/acme/app");
    expect(
      requestRepoUrl({
        id: "bc-1",
        repoOwner: "acme",
        repoName: "payments",
      }),
    ).toBe("https://github.com/acme/payments");
    expect(requestHasRepo({ id: "bc-2" })).toBe(false);
  });

  it("matches a request to the pool that advertises the repo and pool label", () => {
    const gpu = pool({ name: "gpu", repos: ["https://github.com/acme/app.git"] });
    const other = pool({ name: "cpu", repos: ["https://github.com/acme/other"] });
    const req = request({
      labels: [
        { key: "repo", value: "acme/app" },
        { key: "pool", value: "gpu" },
      ],
    });
    expect(matchingPools([gpu, other], req).map((item) => item.name)).toEqual(["gpu"]);
  });
});

describe("planLaunches serve / broadcast / warm", () => {
  it("serves a repo-backed pending request", () => {
    const result = plan();
    expect(result.intents).toEqual([
      expect.objectContaining({
        mode: "serve",
        poolName: "default",
        requestId: "bc-11111111-1111-1111-1111-111111111111",
        repoUrls: ["https://github.com/acme/app"],
      }),
    ]);
  });

  it("skips repo-less pending requests instead of serving them", () => {
    const result = plan({ pending: [{ id: "bc-norepo" }] });
    expect(result.intents.filter((intent) => intent.mode === "serve")).toEqual([]);
    expect(result.skipped).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          requestId: "bc-norepo",
          reason: expect.stringContaining("skip_no_repo"),
        }),
      ]),
    );
  });

  it("does not serve a request that already has a launching slot", () => {
    const slots: SlotSnapshot[] = [
      {
        poolName: "default",
        workerName: "pw_existing",
        status: "launching",
        requestId: "bc-11111111-1111-1111-1111-111111111111",
        repoUrls: ["https://github.com/acme/app"],
        launchedAtMs: 1,
      },
    ];
    const result = plan({ slots });
    expect(result.intents.filter((intent) => intent.mode === "serve")).toEqual([]);
    expect(result.skipped).toEqual(
      expect.arrayContaining([expect.objectContaining({ reason: "already_assigned" })]),
    );
  });

  it("respects request launch cooldown", () => {
    const cooldowns: CooldownState = {
      requestUntilMs: { "bc-11111111-1111-1111-1111-111111111111": 2_000_000 },
      poolLaunchAtMs: {},
    };
    const result = plan({ cooldowns, nowMs: 1_500_000 });
    expect(result.intents.filter((intent) => intent.mode === "serve")).toEqual([]);
    expect(result.skipped).toEqual(
      expect.arrayContaining([expect.objectContaining({ reason: "request_cooldown" })]),
    );
  });

  it("respects maxWorkers capacity", () => {
    const slots: SlotSnapshot[] = [0, 1, 2].map((i) => ({
      poolName: "default",
      workerName: `w${i}`,
      status: "running" as const,
      repoUrls: ["https://github.com/acme/app"],
      launchedAtMs: 1,
    }));
    const result = plan({ slots, pools: [pool({ maxWorkers: 3, minWorkers: 0 })] });
    expect(result.intents).toEqual([]);
    expect(result.skipped).toEqual(
      expect.arrayContaining([expect.objectContaining({ reason: "pool_at_capacity" })]),
    );
  });

  it("does not broadcast from a repo-less pool until it has served work", () => {
    const sandbox = pool({
      name: "sandbox",
      repos: [],
      hasServedWork: false,
      minWorkers: 0,
    });
    const result = plan({
      pools: [sandbox],
      pending: [{ id: "bc-empty", labels: [{ key: "pool", value: "sandbox" }] }],
    });
    expect(result.intents.filter((intent) => intent.mode === "broadcast")).toEqual([]);
    expect(result.skipped).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ reason: "broadcast_blocked_until_pool_has_served_work" }),
      ]),
    );
  });

  it("broadcasts leftover repo-less demand after the pool has served", () => {
    const sandbox = pool({
      name: "sandbox",
      repos: [],
      hasServedWork: true,
      lastServedRepos: ["https://github.com/acme/app"],
      minWorkers: 0,
    });
    const result = plan({
      pools: [sandbox],
      pending: [{ id: "bc-empty", labels: [{ key: "pool", value: "sandbox" }] }],
    });
    expect(result.intents).toEqual([
      expect.objectContaining({
        mode: "broadcast",
        poolName: "sandbox",
        repoUrls: ["https://github.com/acme/app"],
        requestId: "bc-empty",
      }),
    ]);
  });

  it("fills the warm floor when the pool has clone repos", () => {
    const result = plan({
      pending: [],
      pools: [pool({ minWorkers: 2, maxWorkers: 3 })],
    });
    expect(result.intents.filter((intent) => intent.mode === "warm")).toHaveLength(2);
  });

  it("does not warm a repo-less pool that has never served", () => {
    const result = plan({
      pending: [],
      pools: [pool({ repos: [], minWorkers: 1, hasServedWork: false })],
    });
    expect(result.intents.filter((intent) => intent.mode === "warm")).toEqual([]);
    expect(result.skipped).toEqual(
      expect.arrayContaining([expect.objectContaining({ reason: "warm_blocked_no_clone_repos" })]),
    );
  });
});

describe("applyLaunchCooldowns", () => {
  it("records per-request and per-pool cooldown timestamps", () => {
    const next = applyLaunchCooldowns(
      { requestUntilMs: {}, poolLaunchAtMs: {} },
      [
        {
          mode: "serve",
          poolName: "default",
          workerName: "pw_1",
          requestId: "bc-1",
          repoUrls: ["https://github.com/acme/app"],
          reason: "test",
        },
      ],
      5_000,
      60_000,
    );
    expect(next.requestUntilMs["bc-1"]).toBe(65_000);
    expect(next.poolLaunchAtMs.default).toBe(5_000);
  });
});

describe("settings + matching integration", () => {
  it("uses resolved pool caps from env-style settings", () => {
    const settings = loadPlannerSettings({
      POOLS: JSON.stringify([{ name: "default", repos: ["https://github.com/acme/app"] }]),
      MAX_WORKERS_PER_POOL: "1",
      MIN_WORKERS_PER_POOL: "0",
    });
    const result = planLaunches({
      pools: resolvePools(settings),
      pending: [request({ id: "bc-a" }), request({ id: "bc-b", repoUrl: "https://github.com/acme/app" })],
      slots: [],
      cooldowns: { requestUntilMs: {}, poolLaunchAtMs: {} },
      nowMs: 10,
      launchCooldownMs: 60_000,
      poolLaunchCooldownMs: 0,
      createWorkerName: (mode, _pool, id) => `${mode}-${id}`,
    });
    expect(result.intents).toHaveLength(1);
    expect(result.skipped).toEqual(
      expect.arrayContaining([expect.objectContaining({ reason: "pool_at_capacity" })]),
    );
  });
});
