import { SSMClient, GetParameterCommand } from "@aws-sdk/client-ssm";
import { loadPlannerSettings, resolvePools } from "./config.js";
import { CursorApiClient } from "./cursor-api.js";
import { buildLaunchSpec, type LaunchSpecInput } from "./launch-spec.js";
import { planLaunches } from "./matching.js";
import { LaunchMicroVmError, type MicroVmClient } from "./microvm.js";
import { gcSlots, recordLaunches, type SlotStore } from "./slot-state.js";
import type { LaunchIntent, PendingRequest, PlanResult, PlannerSettings } from "./types.js";

export interface SchedulerEnv {
  [key: string]: string | undefined;
}

export interface TickResult {
  pending: number;
  intents: LaunchIntent[];
  launched: Array<{ workerName: string; microvmId?: string; action: string }>;
  skipped: PlanResult["skipped"];
  errors: string[];
}

export interface SchedulerDeps {
  nowMs?: () => number;
  loadStore: () => Promise<SlotStore>;
  saveStore: (store: SlotStore) => Promise<void>;
  listPending: () => Promise<PendingRequest[]>;
  claim?: (bcId: string, workerId: string) => Promise<{ workerId: string } | undefined>;
  microvms: MicroVmClient;
  settings: PlannerSettings;
  launchSpecBase: Omit<LaunchSpecInput, "intent">;
}

export async function tickOnce(deps: SchedulerDeps): Promise<TickResult> {
  const nowMs = (deps.nowMs ?? Date.now)();
  let store = gcSlots(await deps.loadStore(), nowMs, deps.settings.launchCooldownMs * 4);
  const pending = await deps.listPending();
  const pools = resolvePools(deps.settings, store.poolMeta);
  const plan = planLaunches({
    pools,
    pending,
    slots: store.slots,
    cooldowns: store.cooldowns,
    nowMs,
    launchCooldownMs: deps.settings.launchCooldownMs,
    poolLaunchCooldownMs: deps.settings.poolLaunchCooldownMs,
  });

  const launched: TickResult["launched"] = [];
  const errors: string[] = [];
  const applied: LaunchIntent[] = [];

  for (const intent of plan.intents) {
    try {
      if (intent.requestId && deps.claim) {
        const claimed = await deps.claim(intent.requestId, intent.workerName);
        if (claimed?.workerId) {
          intent.workerName = claimed.workerId;
        }
      }
      const spec = buildLaunchSpec({ ...deps.launchSpecBase, intent }, store.slots);
      const result = await deps.microvms.launch(spec);
      applied.push(intent);
      store = recordLaunches(
        store,
        [intent],
        nowMs,
        deps.settings.launchCooldownMs,
        [{ intent, microvmId: result.microvmId }],
      );
      launched.push({
        workerName: intent.workerName,
        microvmId: result.microvmId,
        action: spec.action,
      });
    } catch (error) {
      const message = error instanceof LaunchMicroVmError ? error.message : String(error);
      errors.push(`${intent.workerName}: ${message}`);
    }
  }

  if (applied.length === 0 && plan.intents.length === 0) {
    store = gcSlots(store, nowMs, deps.settings.launchCooldownMs * 4);
  }
  await deps.saveStore(store);

  return {
    pending: pending.length,
    intents: plan.intents,
    launched,
    skipped: plan.skipped,
    errors,
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

export async function createLiveDeps(env: SchedulerEnv, microvms: MicroVmClient, store: {
  load: () => Promise<SlotStore>;
  save: (store: SlotStore) => Promise<void>;
}): Promise<SchedulerDeps> {
  const settings = schedulerSettingsFromEnv(env);
  const region = env.AWS_REGION || env.AWS_DEFAULT_REGION || "us-east-1";
  const paramName = env.CURSOR_API_KEY_PARAM_NAME;
  if (!paramName) {
    throw new Error("CURSOR_API_KEY_PARAM_NAME is required");
  }
  // Scheduler reads the key at runtime to poll pending-requests. The raw
  // value is never placed in the function environment or the MicroVM payload;
  // the MicroVM receives only this parameter name.
  const apiKey = await loadCursorApiKey(paramName, region);
  const cursor = new CursorApiClient({ apiUrl: settings.cursorApiUrl, apiKey });

  return {
    loadStore: store.load,
    saveStore: store.save,
    listPending: () => cursor.listAllPendingRequests(),
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
