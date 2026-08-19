import { apiUrl, loadSettings, type EnvLike } from "./config.js";
import { tickOnce, type TickDeps } from "./controller.js";
import { CursorApiClient } from "./cursor-api.js";
import { SpawnLease } from "./lease.js";
import { SignedMicroVmClient } from "./microvm.js";
import { optionalSsmParameterReader, ssmParameterReader } from "./secrets.js";
import type { TickResult } from "./types.js";

let processLease: SpawnLease | undefined;

function leaseFor(ttlMs: number): SpawnLease {
  if (!processLease) {
    processLease = new SpawnLease(ttlMs);
  }
  return processLease;
}

export async function createLiveDeps(
  env: EnvLike = process.env,
  fetchImpl: typeof fetch = fetch,
): Promise<TickDeps> {
  const settings = loadSettings(env);
  const cursorApiKey = await ssmParameterReader(settings.awsRegion, settings.cursorApiKeyParamName)();
  const gitToken = await optionalSsmParameterReader(settings.awsRegion, settings.gitTokenParamName)();
  return {
    settings,
    cursorApiKey,
    gitToken,
    api: new CursorApiClient({
      apiUrl: apiUrl(settings.cursorApiUrl),
      apiKey: cursorApiKey,
      fetchImpl,
    }),
    microvms: new SignedMicroVmClient({ region: settings.awsRegion }),
    lease: leaseFor(settings.leaseTtlMs),
  };
}

interface HttpResponse {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
}

function json(statusCode: number, body: unknown): HttpResponse {
  return {
    statusCode,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  };
}

function requestPath(event: Record<string, unknown>): string {
  return String(event.rawPath ?? event.path ?? "/").replace(/\/+$/, "") || "/";
}

export async function handler(event: unknown = {}): Promise<TickResult | { ok: true } | HttpResponse> {
  if (event && typeof event === "object" && (event as { health?: boolean }).health === true) {
    return { ok: true };
  }

  const record = event && typeof event === "object" ? (event as Record<string, unknown>) : undefined;
  if (record && (typeof record.rawPath === "string" || typeof record.path === "string")) {
    return requestPath(record) === "/health" ? json(200, { ok: true }) : json(404, { error: "not_found" });
  }

  return tickOnce(await createLiveDeps());
}
