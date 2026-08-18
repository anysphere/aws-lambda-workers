/**
 * Cursor private-worker HTTP client. Platform-free (no AWS imports).
 *
 * Auth matches the Cloudflare reference: `Authorization: Bearer <key>`.
 */

import type { PendingRequest } from "./types.js";
import { canonicalizeUrl } from "./url.js";

export interface CursorApiOptions {
  apiUrl: string;
  apiKey: string;
  fetchImpl?: typeof fetch;
}

export interface PendingRequestsPage {
  requests: PendingRequest[];
  nextPageToken?: string;
  totalCount?: number;
}

export interface PrivateWorker {
  id?: string;
  workerId?: string;
  poolName?: string;
  isInUse?: boolean;
  activeBcId?: string;
}

export interface PrivatePool {
  name?: string;
  repos?: string[];
}

export interface ClaimResult {
  bcId: string;
  workerId: string;
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

function normalizePendingRequest(raw: Record<string, unknown>): PendingRequest {
  const labelsRaw = Array.isArray(raw.labels) ? raw.labels : [];
  const labels = labelsRaw
    .filter((label): label is { key: string; value: string } => {
      return Boolean(label && typeof label === "object" && "key" in label && "value" in label);
    })
    .map((label) => ({ key: String(label.key), value: String(label.value) }));
  const createdAtMs =
    typeof raw.createdAtMs === "number"
      ? raw.createdAtMs
      : typeof raw.createdAt === "string"
        ? Date.parse(raw.createdAt) || 0
        : 0;
  return {
    id: String(raw.id ?? ""),
    repoOwner: typeof raw.repoOwner === "string" ? raw.repoOwner : undefined,
    repoName: typeof raw.repoName === "string" ? raw.repoName : undefined,
    repoUrl: typeof raw.repoUrl === "string" ? raw.repoUrl : undefined,
    labels,
    createdAtMs,
  };
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
    headers.set("Authorization", `Bearer ${this.apiKey}`);
    if (init.body && !headers.has("Content-Type")) {
      headers.set("Content-Type", "application/json");
    }
    return this.fetchImpl(url, { ...init, headers });
  }

  private async readOk(response: Response, label: string): Promise<string> {
    const body = await response.text();
    if (!response.ok) {
      throw new CursorApiError(`${label} failed: ${response.status}`, response.status, body);
    }
    return body;
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
        limit: String(options.limit ?? 100),
        pageToken: options.pageToken,
        repository: options.repository,
      },
    );
    const body = await this.readOk(response, "GET /v0/private-workers/pending-requests");
    const parsed = body ? (JSON.parse(body) as { requests?: Record<string, unknown>[]; nextPageToken?: string; totalCount?: number }) : {};
    return {
      requests: (parsed.requests ?? []).map((item) => normalizePendingRequest(item)),
      nextPageToken: parsed.nextPageToken || undefined,
      totalCount: parsed.totalCount,
    };
  }

  /** Cloudflare client: up to 5 pages of 100. */
  async listPendingRequests(options: { repository?: string; maxPages?: number } = {}): Promise<PendingRequest[]> {
    const requests: PendingRequest[] = [];
    let pageToken: string | undefined;
    const maxPages = options.maxPages ?? 5;
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

  async listWorkers(): Promise<PrivateWorker[]> {
    const response = await this.request("/v0/private-workers", { method: "GET" });
    const body = await this.readOk(response, "GET /v0/private-workers");
    const parsed = body ? (JSON.parse(body) as { workers?: PrivateWorker[] } | PrivateWorker[]) : [];
    return Array.isArray(parsed) ? parsed : (parsed.workers ?? []);
  }

  async listPools(): Promise<PrivatePool[]> {
    const response = await this.request("/v0/private-workers/pools", { method: "GET" });
    const body = await this.readOk(response, "GET /v0/private-workers/pools");
    const parsed = body ? (JSON.parse(body) as { pools?: PrivatePool[] } | PrivatePool[]) : [];
    return Array.isArray(parsed) ? parsed : (parsed.pools ?? []);
  }

  /**
   * Optional pre-claim probe. The backend still claims when a worker
   * connects; 404/405/501 mean the route is not live.
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
