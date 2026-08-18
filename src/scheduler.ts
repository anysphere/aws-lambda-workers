import { SSMClient, GetParameterCommand } from "@aws-sdk/client-ssm";
import { loadPlannerSettings, poolConfigFingerprint, type PlannerSettings } from "./config.js";
import { CursorApiClient } from "./cursor-api.js";
import { buildLaunchSpec, type LaunchSpecInput } from "./launch-spec.js";
import {
  planBroadcastLaunch,
  planLaunches,
  planWarmLaunches,
  reservedContainerNames,
} from "./matching.js";
import { LaunchMicroVmError, type MicroVmClient } from "./microvm.js";
import { gcSlots, plannerSlotsByPool, recordLaunches, type SlotStore } from "./slot-state.js";
import type { PendingRequest, PlannedLaunch } from "./types.js";

export interface SchedulerEnv {
  [key: string]: string | undefined;
}

export interface TickResult {
  pending: number;
  launches: PlannedLaunch[];
  launched: Array<{ workerName: string; microvmId?: string; action: string; mode: string }>;
  errors: string[];
  fingerprintChanged: boolean;
}

export interface SchedulerDeps {
  nowMs?: () => number;
  loadStore: () => Promise<SlotStore>;
  saveStore: (store: SlotStore) => Promise<void>;
  listPending: () => Promise<PendingRequest[]>;
  claim?: (bcId: string, workerId: string) => Promise<{ workerId: string } | undefined>;
  microvms: MicroVmClient;
  settings: PlannerSettings;
  launchSpecBase: Omit<LaunchSpecInput, "spec">;
}

export async function tickOnce(deps: SchedulerDeps): Promise<TickResult> {
  const nowMs = (deps.nowMs ?? Date.now)();
  let store = gcSlots(await deps.loadStore(), nowMs);
  const pending = await deps.listPending();
  const slotsByPool = plannerSlotsByPool(store);
  const fingerprint = poolConfigFingerprint(deps.settings.pools);
  const fingerprintChanged = store.poolConfigFingerprint !== fingerprint;

  const serve = planLaunches({
    pools: deps.settings.pools,
    pending,
    slotsByPool,
    requestLaunchTimes: store.requestLaunchTimes,
    nowMs,
    maxWorkersPerPool: deps.settings.maxWorkersPerPool,
  });
  const warm = planWarmLaunches({
    pools: deps.settings.pools,
    slotsByPool,
    reservedContainerNames: reservedContainerNames(serve),
    nowMs,
    minWorkersPerPool: deps.settings.minWorkersPerPool,
    maxWorkersPerPool: deps.settings.maxWorkersPerPool,
  });
  const broadcast = fingerprintChanged
    ? deps.settings.pools.filter((pool) => pool.repos.length > 0).map(planBroadcastLaunch)
    : [];

  const planned = [...serve, ...warm, ...broadcast];
  const launched: TickResult["launched"] = [];
  const errors: string[] = [];
  const applied: PlannedLaunch[] = [];
  const appliedMeta: Array<{ launch: PlannedLaunch; microvmId?: string }> = [];

  for (const launch of planned) {
    try {
      let spec = launch.spec;
      if (spec.requestId && deps.claim) {
        const claimed = await deps.claim(spec.requestId, spec.workerName);
        if (claimed?.workerId) {
          spec = { ...spec, workerName: claimed.workerId };
        }
      }
      const microvmSpec = buildLaunchSpec({ ...deps.launchSpecBase, spec }, store.slots, launch.slotIndex);
      const result = await deps.microvms.launch(microvmSpec);
      const recorded = { ...launch, spec };
      applied.push(recorded);
      appliedMeta.push({ launch: recorded, microvmId: result.microvmId });
      launched.push({
        workerName: spec.workerName,
        microvmId: result.microvmId,
        action: microvmSpec.action,
        mode: spec.mode,
      });
    } catch (error) {
      const message = error instanceof LaunchMicroVmError ? error.message : String(error);
      errors.push(`${launch.spec.workerName}: ${message}`);
    }
  }

  store = recordLaunches(store, applied, nowMs, appliedMeta);
  store = { ...store, poolConfigFingerprint: fingerprint };
  await deps.saveStore(store);

  return {
    pending: pending.length,
    launches: planned,
    launched,
    errors,
    fingerprintChanged,
  };
}

export async function loadCursorApiKey(paramName: string, region: string): Promise<string> {
  const client = new SSMClient({ region });
  const result = await client.send(new GetParameterCommand({ Name: paramName, WithDecryption: true }));
  const value = result.Parameter?.Value;
  if (!value) {
    throw new Error(`SSM parameter ${paramName} has no value`);
  }
  return value;
}

export function schedulerSettingsFromEnv(env: SchedulerEnv): PlannerSettings {
  return loadPlannerSettings(env);
}

export async function createLiveDeps(
  env: SchedulerEnv,
  microvms: MicroVmClient,
  store: {
    load: () => Promise<SlotStore>;
    save: (store: SlotStore) => Promise<void>;
  },
): Promise<SchedulerDeps> {
  const settings = schedulerSettingsFromEnv(env);
  const region = env.AWS_REGION || env.AWS_DEFAULT_REGION || "us-east-1";
  const paramName = env.CURSOR_API_KEY_PARAM_NAME;
  if (!paramName) {
    throw new Error("CURSOR_API_KEY_PARAM_NAME is required");
  }
  const apiKey = await loadCursorApiKey(paramName, region);
  const cursor = new CursorApiClient({ apiUrl: settings.cursorApiUrl, apiKey });

  return {
    loadStore: store.load,
    saveStore: store.save,
    listPending: () => cursor.listPendingRequests(),
    claim: async (bcId, workerId) => {
      try {
        return await cursor.claim(bcId, workerId);
      } catch (error) {
        console.warn("optional claim failed; backend will claim on connect", error);
        return undefined;
      }
    },
    microvms,
    settings,
    launchSpecBase: {
      imageIdentifier: required(env, "MICROVM_IMAGE_IDENTIFIER"),
      executionRoleArn: required(env, "MICROVM_EXECUTION_ROLE_ARN"),
      cursorApiKeyParamName: paramName,
      gitTokenParamName: env.GIT_TOKEN_PARAM_NAME,
      repoCacheBucket: env.REPO_CACHE_BUCKET,
      cursorApiUrl: settings.cursorApiUrl,
      cursorAgentEndpoint: settings.cursorAgentEndpoint,
      idleReleaseTimeoutSeconds: settings.workerIdleReleaseTimeoutSeconds,
      awsRegion: region,
      logGroup: env.MICROVM_LOG_GROUP,
      ingressNetworkConnectors: [
        `arn:aws:lambda:${region}:aws:network-connector:aws-network-connector:ALL_INGRESS`,
        ...(env.EXTRA_INGRESS_CONNECTOR_ARN ? [env.EXTRA_INGRESS_CONNECTOR_ARN] : []),
      ],
      egressNetworkConnectors: [
        `arn:aws:lambda:${region}:aws:network-connector:aws-network-connector:INTERNET_EGRESS`,
        ...(env.EXTRA_EGRESS_CONNECTOR_ARN ? [env.EXTRA_EGRESS_CONNECTOR_ARN] : []),
      ],
    },
  };
}

function required(env: SchedulerEnv, key: string): string {
  const value = env[key];
  if (!value) {
    throw new Error(`${key} is required`);
  }
  return value;
}
