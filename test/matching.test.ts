import { describe, expect, it } from "vitest";
import {
  DEFAULT_POOL_NAME,
  LAUNCH_COOLDOWN_MS,
  REQUEST_RECORD_TTL_MS,
  containerNameForBroadcast,
  containerNameForSlot,
  planBroadcastLaunch,
  planLaunches,
  planWarmLaunches,
  poolNameFromRequest,
  pruneRequestLaunchTimes,
  repoKeyFromOwnerName,
  repoKeyFromUrl,
  repoUrlsForLaunch,
  requestMatchesPool,
  reservedContainerNames,
} from "../src/matching.js";
import type { PendingRequest, PoolConfig, SlotState } from "../src/types.js";

function pool(overrides: Partial<PoolConfig> = {}): PoolConfig {
  return {
    name: "default",
    repos: ["https://github.com/acme/app"],
    ...overrides,
  };
}

function request(overrides: Partial<PendingRequest> = {}): PendingRequest {
  return {
    id: "bc-1",
    repoUrl: "https://github.com/acme/app",
    labels: [],
    createdAtMs: 1,
    ...overrides,
  };
}

function serve(overrides: Partial<Parameters<typeof planLaunches>[0]> = {}) {
  return planLaunches({
    pools: [pool()],
    pending: [request()],
    slotsByPool: {},
    requestLaunchTimes: {},
    nowMs: 1_000_000,
    maxWorkersPerPool: 3,
    ...overrides,
  });
}

describe("repoKeyFromUrl / repoKeyFromOwnerName", () => {
  it("normalizes https, ssh, git@, and .git suffixes to lowercase owner/name", () => {
    expect(repoKeyFromUrl("https://github.com/Acme/App.git")).toBe("acme/app");
    expect(repoKeyFromUrl("git@github.com:Acme/App.git")).toBe("acme/app");
    expect(repoKeyFromUrl("ssh://git@github.com/Acme/App.git")).toBe("acme/app");
    expect(repoKeyFromUrl("github.com/Acme/App")).toBe("acme/app");
    expect(repoKeyFromOwnerName("Acme", "App")).toBe("acme/app");
  });

  it("keeps GitLab nested groups", () => {
    expect(repoKeyFromUrl("https://gitlab.com/Group/Sub/Repo.git")).toBe("group/sub/repo");
    expect(repoKeyFromUrl("git@gitlab.com:Group/Sub/Repo.git")).toBe("group/sub/repo");
  });
});

describe("poolNameFromRequest / requestMatchesPool", () => {
  it("targets pool default when the pool label is missing", () => {
    expect(poolNameFromRequest(request({ labels: [] }))).toBe(DEFAULT_POOL_NAME);
    expect(requestMatchesPool(request({ labels: [] }), pool({ name: "default" }))).toBe(true);
    expect(requestMatchesPool(request({ labels: [] }), pool({ name: "gpu" }))).toBe(false);
  });

  it("never matches when the request has no resolvable repo", () => {
    const unlabeled = request({ repoUrl: undefined, repoOwner: undefined, repoName: undefined });
    expect(requestMatchesPool(unlabeled, pool())).toBe(false);
    expect(requestMatchesPool(unlabeled, pool({ repos: [] }))).toBe(false);
  });

  it("requires request.repoUrl for an any-repo pool", () => {
    const anyRepo = pool({ repos: [] });
    expect(
      requestMatchesPool(request({ repoUrl: undefined, repoOwner: "acme", repoName: "app" }), anyRepo),
    ).toBe(false);
    expect(requestMatchesPool(request({ repoUrl: "https://github.com/acme/app" }), anyRepo)).toBe(true);
  });

  it("matches a configured pool by repo key, not URL-string equality", () => {
    const gpu = pool({ name: "gpu", repos: ["git@github.com:Acme/App.git"] });
    const req = request({
      repoUrl: "https://github.com/acme/app",
      labels: [{ key: "pool", value: "gpu" }],
    });
    expect(requestMatchesPool(req, gpu)).toBe(true);
    expect(requestMatchesPool(req, pool({ name: "cpu" }))).toBe(false);
  });
});

describe("repoUrlsForLaunch", () => {
  it("clones the pool's full repo list when configured", () => {
    const multi = pool({
      repos: ["https://github.com/acme/app", "https://github.com/acme/lib"],
    });
    expect(repoUrlsForLaunch(request(), multi)).toEqual([
      "https://github.com/acme/app",
      "https://github.com/acme/lib",
    ]);
  });

  it("falls back to the request repo for an any-repo pool", () => {
    expect(repoUrlsForLaunch(request(), pool({ repos: [] }))).toEqual(["https://github.com/acme/app"]);
  });
});

describe("planLaunches", () => {
  it("serves the oldest request first on pool=<name>/slot=<n>", () => {
    const launches = serve({
      pending: [
        request({ id: "bc-new", createdAtMs: 50 }),
        request({ id: "bc-old", createdAtMs: 10 }),
      ],
    });
    expect(launches.map((item) => item.spec.requestId)).toEqual(["bc-old", "bc-new"]);
    expect(launches[0]).toMatchObject({
      containerName: containerNameForSlot("default", 0),
      slotIndex: 0,
      spec: {
        mode: "serve",
        workerName: "aws-default-0",
        repoUrls: ["https://github.com/acme/app"],
      },
    });
  });

  it("does not serialize a pool: two matching requests can launch in one tick", () => {
    const launches = serve({
      pending: [request({ id: "bc-a", createdAtMs: 1 }), request({ id: "bc-b", createdAtMs: 2 })],
      maxWorkersPerPool: 3,
    });
    expect(launches).toHaveLength(2);
    expect(launches.map((item) => item.containerName)).toEqual([
      "pool=default/slot=0",
      "pool=default/slot=1",
    ]);
  });

  it("skips a request still inside LAUNCH_COOLDOWN_MS", () => {
    const launches = serve({
      requestLaunchTimes: { "bc-1": 1_000_000 - 1_000 },
      nowMs: 1_000_000,
    });
    expect(launches).toEqual([]);
  });

  it("skips a slot still inside per-slot cooldown", () => {
    const slots: SlotState[] = [{ slotIndex: 0, running: false, lastLaunchAtMs: 1_000_000 - 1_000 }];
    const launches = serve({
      slotsByPool: { default: slots },
      maxWorkersPerPool: 1,
    });
    expect(launches).toEqual([]);
  });

  it("does not treat a running or suspended slot as free", () => {
    const launches = serve({
      slotsByPool: { default: [{ slotIndex: 0, running: true }] },
      maxWorkersPerPool: 1,
    });
    expect(launches).toEqual([]);
  });

  it("uses the pool's full repo list on serve", () => {
    const launches = serve({
      pools: [pool({ repos: ["https://github.com/acme/app", "https://github.com/acme/lib"] })],
    });
    expect(launches[0]?.spec.repoUrls).toEqual([
      "https://github.com/acme/app",
      "https://github.com/acme/lib",
    ]);
  });
});

describe("planWarmLaunches", () => {
  it("fills the warm floor on pools that have repos", () => {
    const warm = planWarmLaunches({
      pools: [pool({ minWorkers: 2 })],
      slotsByPool: {},
      reservedContainerNames: new Set(),
      nowMs: 1,
      minWorkersPerPool: 1,
      maxWorkersPerPool: 3,
    });
    expect(warm).toHaveLength(2);
    expect(warm.every((item) => item.spec.mode === "warm")).toBe(true);
  });

  it("skips pools with no repos", () => {
    const warm = planWarmLaunches({
      pools: [pool({ repos: [], minWorkers: 2 })],
      slotsByPool: {},
      reservedContainerNames: new Set(),
      nowMs: 1,
      minWorkersPerPool: 1,
      maxWorkersPerPool: 3,
    });
    expect(warm).toEqual([]);
  });

  it("counts serve-reserved and running/suspended slots toward the floor", () => {
    const serveLaunch = serve({ maxWorkersPerPool: 3 })[0];
    const reserved = reservedContainerNames(serveLaunch ? [serveLaunch] : []);
    const warm = planWarmLaunches({
      pools: [pool({ minWorkers: 2 })],
      slotsByPool: { default: [{ slotIndex: 1, running: true }] },
      reservedContainerNames: reserved,
      nowMs: 1,
      minWorkersPerPool: 1,
      maxWorkersPerPool: 3,
    });
    expect(warm).toEqual([]);
  });
});

describe("broadcast helpers", () => {
  it("names the one-off register boot pool=<name>/broadcast", () => {
    expect(containerNameForBroadcast("gpu")).toBe("pool=gpu/broadcast");
    expect(planBroadcastLaunch(pool({ name: "gpu" }))).toMatchObject({
      containerName: "pool=gpu/broadcast",
      slotIndex: -1,
      spec: { mode: "broadcast", workerName: "aws-gpu-broadcast" },
    });
  });
});

describe("pruneRequestLaunchTimes", () => {
  it("drops entries older than REQUEST_RECORD_TTL_MS", () => {
    const now = REQUEST_RECORD_TTL_MS + 5_000;
    const next = pruneRequestLaunchTimes({ fresh: now - 1_000, stale: 0 }, now);
    expect(next).toEqual({ fresh: now - 1_000 });
    expect(LAUNCH_COOLDOWN_MS).toBe(120_000);
  });
});
