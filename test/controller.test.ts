import { describe, expect, it } from "vitest";
import { loadSettings } from "../src/config.js";
import { tickOnce, workerNameFor } from "../src/controller.js";
import { CursorApiClient } from "../src/cursor-api.js";
import { SpawnLease } from "../src/lease.js";
import { handler } from "../src/index.js";
import type { MicroVmClient } from "../src/microvm.js";
import type { MicrovmLaunchSpec } from "../src/launch-spec.js";
import type { PendingRequest } from "../src/types.js";

const settings = loadSettings({
  POOL_NAME: "default",
  CONCURRENCY: "2",
  CURSOR_API_KEY_PARAM_NAME: "/cursor/api-key",
  MICROVM_IMAGE_IDENTIFIER: "cursor-pool-worker",
  MICROVM_EXECUTION_ROLE_ARN: "arn:aws:iam::1:role/microvm",
  AWS_REGION: "us-east-1",
});

function request(partial: Partial<PendingRequest> & Pick<PendingRequest, "id">): PendingRequest {
  return {
    labels: [],
    createdAtMs: 0,
    ...partial,
  };
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function api(fetchImpl: typeof fetch): CursorApiClient {
  return new CursorApiClient({ apiUrl: "https://api.cursor.com", apiKey: "test-key", fetchImpl });
}

function recordingMicrovms(): { client: MicroVmClient; specs: MicrovmLaunchSpec[] } {
  const specs: MicrovmLaunchSpec[] = [];
  return {
    specs,
    client: {
      async launch(spec) {
        specs.push(spec);
        return { microvmId: `m-${specs.length}` };
      },
    },
  };
}

describe("handler", () => {
  it("health is a one-liner and does not spawn", async () => {
    await expect(handler({ health: true })).resolves.toEqual({ ok: true });
    await expect(handler({ rawPath: "/health" })).resolves.toMatchObject({ statusCode: 200 });
  });
});

describe("tickOnce", () => {
  it("paginates pending-requests, claims, and RunMicrovm without waiting on the agent", async () => {
    const fetchImpl = async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/pending-requests") && url.includes("pageToken=next")) {
        return jsonResponse(200, {
          requests: [{ id: "bc-2", repoUrl: "https://github.com/acme/two", createdAtMs: 2 }],
        });
      }
      if (url.includes("/pending-requests")) {
        return jsonResponse(200, {
          requests: [{ id: "bc-1", repoUrl: "https://github.com/acme/one", createdAtMs: 1 }],
          nextPageToken: "next",
        });
      }
      if (url.endsWith("/claim") && init?.method === "POST") {
        const body = JSON.parse(String(init.body));
        if (body.bcId === "bc-probe-not-a-real-request") {
          return jsonResponse(400, { error: "unknown_request" });
        }
        return jsonResponse(200, { bcId: body.bcId, workerId: body.workerId });
      }
      throw new Error(`unexpected ${url}`);
    };
    const { client, specs } = recordingMicrovms();
    const result = await tickOnce({
      settings,
      api: api(fetchImpl as unknown as typeof fetch),
      microvms: client,
      lease: new SpawnLease(60_000),
      cursorApiKey: "k",
    });
    expect(result.spawned.map((item) => item.requestId)).toEqual(["bc-1", "bc-2"]);
    expect(result.spawned[0]?.microvmId).toBe("m-1");
    expect(specs).toHaveLength(2);
    const payload = JSON.parse(specs[0]!.runHookPayload) as { env: Record<string, string> };
    expect(payload.env.POOL_NAME).toBe("default");
    expect(payload.env.REPO_URL).toBe("https://github.com/acme/one");
    expect(payload.env.CURSOR_API_KEY).toBe("k");
    expect(payload.env.WORKER_NAME).toBe(workerNameFor("default", "bc-1"));
  });

  it("still spawns when the claim probe returns 404/405/501", async () => {
    const fetchImpl = async (input: string | URL) => {
      const url = String(input);
      if (url.includes("/pending-requests")) {
        return jsonResponse(200, {
          requests: [{ id: "bc-1", repoUrl: "https://github.com/acme/one" }],
        });
      }
      return jsonResponse(501, { message: "not implemented" });
    };
    const { client, specs } = recordingMicrovms();
    const result = await tickOnce({
      settings,
      api: api(fetchImpl as unknown as typeof fetch),
      microvms: client,
      lease: new SpawnLease(60_000),
      cursorApiKey: "k",
    });
    expect(result.spawned).toHaveLength(1);
    expect(specs).toHaveLength(1);
  });

  it("skips on claim 409 and does not RunMicrovm", async () => {
    const fetchImpl = async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/pending-requests")) {
        return jsonResponse(200, {
          requests: [{ id: "bc-1", repoUrl: "https://github.com/acme/one" }],
        });
      }
      const body = JSON.parse(String(init?.body ?? "{}"));
      if (body.bcId === "bc-probe-not-a-real-request") {
        return jsonResponse(400, {});
      }
      return jsonResponse(409, { error: "conflict" });
    };
    let launched = 0;
    const result = await tickOnce({
      settings,
      api: api(fetchImpl as unknown as typeof fetch),
      microvms: {
        async launch() {
          launched += 1;
          return { microvmId: "nope" };
        },
      },
      lease: new SpawnLease(60_000),
      cursorApiKey: "k",
    });
    expect(launched).toBe(0);
    expect(result.skipped.some((item) => item.reason === "claim conflict")).toBe(true);
  });

  it("caps launches at concurrency", async () => {
    const pending = [1, 2, 3, 4].map((n) => ({
      id: `bc-${n}`,
      repoUrl: `https://github.com/acme/r${n}`,
      createdAtMs: n,
    }));
    const fetchImpl = async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/pending-requests")) {
        return jsonResponse(200, { requests: pending });
      }
      const body = JSON.parse(String(init?.body ?? "{}"));
      if (body.bcId === "bc-probe-not-a-real-request") {
        return jsonResponse(400, {});
      }
      return jsonResponse(200, {});
    };
    const { client, specs } = recordingMicrovms();
    const result = await tickOnce({
      settings,
      api: api(fetchImpl as unknown as typeof fetch),
      microvms: client,
      lease: new SpawnLease(60_000),
      cursorApiKey: "k",
    });
    expect(specs).toHaveLength(2);
    expect(result.skipped.filter((item) => item.reason === "concurrency")).toHaveLength(2);
  });

  it("leases a request so a second tick does not spawn it again", async () => {
    const fetchImpl = async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/pending-requests")) {
        return jsonResponse(200, {
          requests: [{ id: "bc-1", repoUrl: "https://github.com/acme/one" }],
        });
      }
      const body = JSON.parse(String(init?.body ?? "{}"));
      if (body.bcId === "bc-probe-not-a-real-request") {
        return jsonResponse(400, {});
      }
      return jsonResponse(200, {});
    };
    const { client, specs } = recordingMicrovms();
    const lease = new SpawnLease(60_000);
    const deps = {
      settings,
      api: api(fetchImpl as unknown as typeof fetch),
      microvms: client,
      lease,
      cursorApiKey: "k",
    };
    await expect(tickOnce(deps)).resolves.toMatchObject({ spawned: [{ requestId: "bc-1" }] });
    const second = await tickOnce(deps);
    expect(second.spawned).toEqual([]);
    expect(second.skipped.some((item) => item.reason === "leased")).toBe(true);
    expect(specs).toHaveLength(1);
  });

  it("ignores other pools and requests without a repo", async () => {
    const fetchImpl = async (input: string | URL) => {
      const url = String(input);
      if (url.includes("/pending-requests")) {
        return jsonResponse(200, {
          requests: [
            request({ id: "bc-gpu", repoUrl: "https://github.com/acme/one", labels: [{ key: "pool", value: "gpu" }] }),
            request({ id: "bc-empty" }),
          ],
        });
      }
      return jsonResponse(501, {});
    };
    const { client, specs } = recordingMicrovms();
    const result = await tickOnce({
      settings,
      api: api(fetchImpl as unknown as typeof fetch),
      microvms: client,
      lease: new SpawnLease(60_000),
      cursorApiKey: "k",
    });
    expect(specs).toHaveLength(0);
    expect(result.skipped.map((item) => item.reason).sort()).toEqual(["no repo", "pool mismatch"]);
  });
});
