import { describe, expect, it, vi } from "vitest";
import { CursorApiClient } from "../src/cursor-api.js";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

describe("CursorApiClient", () => {
  it("uses Bearer auth and paginates pending requests (5 x 100)", async () => {
    const fetchImpl = vi.fn(async (input: string | URL, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      expect(headers.get("Authorization")).toBe("Bearer test-key");
      const url = String(input);
      if (url.includes("pageToken=next")) {
        return jsonResponse(200, { requests: [{ id: "bc-2" }] });
      }
      return jsonResponse(200, {
        requests: [{ id: "bc-1", repoUrl: "https://github.com/acme/app" }],
        nextPageToken: "next",
        totalCount: 2,
      });
    });
    const client = new CursorApiClient({
      apiUrl: "https://api.cursor.com",
      apiKey: "test-key",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const requests = await client.listPendingRequests();
    expect(requests.map((item) => item.id)).toEqual(["bc-1", "bc-2"]);
    expect(requests[0]?.labels).toEqual([]);
    expect(requests[0]?.createdAtMs).toBe(0);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("lists workers and pools", async () => {
    const fetchImpl = vi.fn(async (input: string | URL) => {
      const url = String(input);
      if (url.endsWith("/v0/private-workers/pools")) {
        return jsonResponse(200, { pools: [{ name: "default" }] });
      }
      return jsonResponse(200, { workers: [{ workerId: "aws-default-0" }] });
    });
    const client = new CursorApiClient({
      apiUrl: "https://api.cursor.com",
      apiKey: "test-key",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await expect(client.listWorkers()).resolves.toEqual([{ workerId: "aws-default-0" }]);
    await expect(client.listPools()).resolves.toEqual([{ name: "default" }]);
  });

  it("treats 404 claim as unsupported and stops calling it", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(404, { message: "not found" }));
    const client = new CursorApiClient({
      apiUrl: "https://api.cursor.com",
      apiKey: "test-key",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(await client.claim("bc-1", "pw_1")).toBeUndefined();
    expect(await client.claim("bc-2", "pw_2")).toBeUndefined();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("returns a claim when the endpoint is live", async () => {
    const fetchImpl = vi.fn(async (input: string | URL, init?: RequestInit) => {
      if (init?.method === "POST") {
        const body = JSON.parse(String(init.body));
        if (body.bcId === "bc-probe-not-a-real-request") {
          return jsonResponse(400, { error: "unknown_request" });
        }
        return jsonResponse(200, { bcId: body.bcId, workerId: body.workerId });
      }
      return jsonResponse(404, {});
    });
    const client = new CursorApiClient({
      apiUrl: "https://api.cursor.com",
      apiKey: "test-key",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await expect(client.claim("bc-1", "pw_1")).resolves.toEqual({ bcId: "bc-1", workerId: "pw_1" });
  });
});
