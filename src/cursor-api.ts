/**
 * Cursor private-worker HTTP client. Platform-free (no AWS imports).
 *
 * Auth matches the public fleet-management docs: Basic with the service
 * account API key as the username and an empty password.
 */

import type { ClaimResult, PendingRequest, PendingRequestsPage } from "./types.js";
import { canonicalizeUrl } from "./url.js";

export interface CursorApiOptions {
  apiUrl: string;
  apiKey: string;
  fetchImpl?: typeof fetch;
}

export class CursorApiError extends Error {
  readonly status: number;
  readonly body: string;

  constructor(message: string, status: number, body: string) {
    super(message);
    this.name = "CursorApiError";
    this.status = status;
    this.body = body;
  }
}

function basicAuth(apiKey: string): string {
  return `Basic ${Buffer.from(`${apiKey}:`, "utf8").toString("base64")}`;
}

function joinUrl(base: string, path: string, query?: Record<string, string | undefined>): string {
  const url = canonicalizeUrl(`${base.replace(/\/+$/, "")}${path}`);
  if (query) {
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined && value !== "") {
        url.searchParams.set(key, value);
      }
    }
  }
  return url.toString();
}

export class CursorApiClient {
  private readonly apiUrl: string;
  private readonly apiKey: string;
  private readonly fetchImpl: typeof fetch;
  private claimSupported: boolean | undefined;

  constructor(options: CursorApiOptions) {
    this.apiUrl = options.apiUrl.replace(/\/+$/, "");
    this.apiKey = options.apiKey;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  private async request(path: string, init: RequestInit = {}, query?: Record<string, string | undefined>): Promise<Response> {
    const url = joinUrl(this.apiUrl, path, query);
    const headers = new Headers(init.headers);
    headers.set("Authorization", basicAuth(this.apiKey));
    if (init.body && !headers.has("Content-Type")) {
      headers.set("Content-Type", "application/json");
    }
    return this.fetchImpl(url, { ...init, headers });
  }

  async listPendingRequestsPage(options: {
    limit?: number;
    pageToken?: string;
    repository?: string;
  } = {}): Promise<PendingRequestsPage> {
    const response = await this.request(
      "/v0/private-workers/pending-requests",
      { method: "GET" },
      {
        limit: String(options.limit ?? 50),
        pageToken: options.pageToken,
        repository: options.repository,
      },
    );
    const body = await response.text();
    if (!response.ok) {
      throw new CursorApiError(
        `GET /v0/private-workers/pending-requests failed: ${response.status}`,
        response.status,
        body,
      );
    }
    const parsed = body ? (JSON.parse(body) as PendingRequestsPage) : { requests: [] };
    return {
      requests: parsed.requests ?? [],
      nextPageToken: parsed.nextPageToken || undefined,
      totalCount: parsed.totalCount,
    };
  }

  async listAllPendingRequests(options: { repository?: string; maxPages?: number } = {}): Promise<PendingRequest[]> {
    const requests: PendingRequest[] = [];
    let pageToken: string | undefined;
    const maxPages = options.maxPages ?? 20;
    for (let page = 0; page < maxPages; page += 1) {
      const result = await this.listPendingRequestsPage({
        limit: 100,
        pageToken,
        repository: options.repository,
      });
      requests.push(...result.requests);
      if (!result.nextPageToken) {
        break;
      }
      pageToken = result.nextPageToken;
    }
    return requests;
  }

  /**
   * Probe POST /v0/private-workers/claim. The backend still claims when a
   * worker connects; this is an optional pre-claim. 404/405/501 mean the
   * route is not live and we stop calling it for this process.
   */
  async probeClaim(): Promise<boolean> {
    if (this.claimSupported !== undefined) {
      return this.claimSupported;
    }
    const response = await this.request("/v0/private-workers/claim", {
      method: "POST",
      body: JSON.stringify({ bcId: "bc-probe-not-a-real-request", workerId: "pw_probe" }),
    });
    if (response.status === 404 || response.status === 405 || response.status === 501) {
      this.claimSupported = false;
      return false;
    }
    // 400/409/401/403 all mean the route exists.
    this.claimSupported = true;
    return true;
  }

  async claim(bcId: string, workerId: string): Promise<ClaimResult | undefined> {
    const supported = await this.probeClaim();
    if (!supported) {
      return undefined;
    }
    const response = await this.request("/v0/private-workers/claim", {
      method: "POST",
      body: JSON.stringify({ bcId, workerId }),
    });
    const body = await response.text();
    if (response.status === 404 || response.status === 405 || response.status === 501) {
      this.claimSupported = false;
      return undefined;
    }
    if (!response.ok) {
      throw new CursorApiError(`POST /v0/private-workers/claim failed: ${response.status}`, response.status, body);
    }
    const parsed = body ? (JSON.parse(body) as ClaimResult) : { bcId, workerId };
    return { bcId: parsed.bcId ?? bcId, workerId: parsed.workerId ?? workerId };
  }
}
