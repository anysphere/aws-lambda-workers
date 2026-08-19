import { DEFAULT_POOL_NAME, type ControllerSettings } from "./config.js";
import { CursorApiClient, CursorApiError } from "./cursor-api.js";
import { buildLaunchSpec } from "./launch-spec.js";
import type { SpawnLease } from "./lease.js";
import type { MicroVmClient } from "./microvm.js";
import type { PendingRequest, SpawnedWorker, SkippedRequest, TickError, TickResult } from "./types.js";
import { canonicalizeUrl } from "./url.js";

export interface TickDeps {
  settings: ControllerSettings;
  api: CursorApiClient;
  microvms: MicroVmClient;
  lease: SpawnLease;
  cursorApiKey: string;
  gitToken?: string;
}

export function poolNameFromRequest(request: PendingRequest): string {
  const label = request.labels.find((item) => item.key === "pool");
  const value = label?.value?.trim();
  return value || DEFAULT_POOL_NAME;
}

export function repoUrlFromRequest(request: PendingRequest): string | undefined {
  const explicit = request.repoUrl?.trim();
  if (explicit) {
    return explicit;
  }
  const owner = request.repoOwner?.trim();
  const name = request.repoName?.trim();
  if (owner && name) {
    return canonicalizeUrl(`https://github.com/${owner}/${name}`).toString().replace(/\/+$/, "");
  }
  return undefined;
}

export function workerNameFor(poolName: string, requestId: string): string {
  const slug = requestId.replace(/[^a-zA-Z0-9]/g, "").slice(0, 16) || "worker";
  return `aws-${poolName}-${slug}`;
}

export async function tickOnce(deps: TickDeps): Promise<TickResult> {
  const spawned: SpawnedWorker[] = [];
  const skipped: SkippedRequest[] = [];
  const errors: TickError[] = [];

  let pending: PendingRequest[];
  try {
    pending = await deps.api.listPendingRequests();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { spawned, skipped, errors: [{ message }] };
  }

  pending.sort((a, b) => a.createdAtMs - b.createdAtMs);

  for (const request of pending) {
    if (!request.id) {
      skipped.push({ reason: "missing request id" });
      continue;
    }
    if (poolNameFromRequest(request) !== deps.settings.poolName) {
      skipped.push({ requestId: request.id, reason: "pool mismatch" });
      continue;
    }
    const repoUrl = repoUrlFromRequest(request);
    if (!repoUrl) {
      skipped.push({ requestId: request.id, reason: "no repo" });
      continue;
    }
    if (deps.lease.size >= deps.settings.concurrency) {
      skipped.push({ requestId: request.id, reason: "concurrency" });
      continue;
    }
    if (!deps.lease.tryAcquire(request.id)) {
      skipped.push({ requestId: request.id, reason: "leased" });
      continue;
    }

    const workerName = workerNameFor(deps.settings.poolName, request.id);
    try {
      const claim = await deps.api.claim(request.id, workerName);
      if (claim === "skip") {
        deps.lease.release(request.id);
        skipped.push({ requestId: request.id, reason: "claim conflict" });
        continue;
      }
      const launched = await deps.microvms.launch(
        buildLaunchSpec({
          poolName: deps.settings.poolName,
          workerName,
          repoUrl,
          requestId: request.id,
          cursorApiKey: deps.cursorApiKey,
          gitToken: deps.gitToken,
          cursorApiUrl: deps.settings.cursorApiUrl,
          cursorAgentEndpoint: deps.settings.cursorAgentEndpoint,
          idleReleaseTimeoutSeconds: deps.settings.workerIdleReleaseTimeoutSeconds,
          awsRegion: deps.settings.awsRegion,
          imageIdentifier: deps.settings.imageIdentifier,
          executionRoleArn: deps.settings.executionRoleArn,
          ingressNetworkConnectors: deps.settings.ingressNetworkConnectors,
          egressNetworkConnectors: deps.settings.egressNetworkConnectors,
          logGroup: deps.settings.logGroup,
        }),
      );
      spawned.push({ requestId: request.id, workerName, microvmId: launched.microvmId });
    } catch (error) {
      deps.lease.release(request.id);
      const message = error instanceof Error ? error.message : String(error);
      errors.push({ requestId: request.id, message });
      if (error instanceof CursorApiError && (error.status === 401 || error.status === 403)) {
        break;
      }
    }
  }

  return { spawned, skipped, errors };
}
