import { describe, expect, it } from "vitest";
import { CursorApiClient } from "../src/cursor-api.js";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

describe("CursorApiClient", () => {
  it("uses Bearer auth and paginates pending requests (5 x 100)", async () => {
    const fetchImpl = async (input: string | URL, init?: RequestInit) => {
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
    };
    const client = new CursorApiClient({
      apiUrl: "https://api.cursor.com",
      apiKey: "test-key",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const requests = await client.listPendingRequests();
    expect(requests.map((item) => item.id)).toEqual(["bc-1", "bc-2"]);
    expect(requests[0]?.labels).toEqual([]);
    expect(requests[0]?.createdAtMs).toBe(0);
  });

  it("treats 404/405/501 claim as unsupported and stops calling it", async () => {
    let calls = 0;
    const fetchImpl = async () => {
      calls += 1;
      return jsonResponse(404, { message: "not found" });
    };
    const client = new CursorApiClient({
      apiUrl: "https://api.cursor.com",
      apiKey: "test-key",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(await client.claim("bc-1", "pw_1")).toBe("spawn");
    expect(await client.claim("bc-2", "pw_2")).toBe("spawn");
    expect(calls).toBe(1);
  });

  it("returns spawn when the claim endpoint is live", async () => {
    const fetchImpl = async (input: string | URL, init?: RequestInit) => {
      if (init?.method === "POST") {
        const body = JSON.parse(String(init.body));
        if (body.bcId === "bc-probe-not-a-real-request") {
          return jsonResponse(400, { error: "unknown_request" });
        }
        return jsonResponse(200, { bcId: body.bcId, workerId: body.workerId });
      }
      return jsonResponse(404, {});
    };
    const client = new CursorApiClient({
      apiUrl: "https://api.cursor.com",
      apiKey: "test-key",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await expect(client.claim("bc-1", "pw_1")).resolves.toBe("spawn");
  });

  it("skips on 409 conflict", async () => {
    const fetchImpl = async (input: string | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}"));
      if (body.bcId === "bc-probe-not-a-real-request") {
        return jsonResponse(400, {});
      }
      return jsonResponse(409, { error: "conflict" });
    };
    const client = new CursorApiClient({
      apiUrl: "https://api.cursor.com",
      apiKey: "test-key",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await expect(client.claim("bc-1", "pw_1")).resolves.toBe("skip");
  });
});
