/**
 * Build the RunMicrovm / resume payload. Kept free of AWS SDK imports so
 * vitest can exercise the same JSON the scheduler sends.
 */

import { MAX_RUN_LIFETIME_SECONDS } from "./config.js";
import type { LaunchIntent, SlotSnapshot } from "./types.js";

export const RUN_HOOK_PAYLOAD_VERSION = "1";

export interface IdlePolicySpec {
  maxIdleDurationSeconds: number;
  suspendedDurationSeconds: number;
  autoResumeEnabled: boolean;
}

export interface LaunchSpecInput {
  intent: LaunchIntent;
  imageIdentifier: string;
  executionRoleArn: string;
  cursorApiKeyParamName: string;
  gitTokenParamName?: string;
  repoCacheBucket?: string;
  cursorApiUrl: string;
  cursorAgentEndpoint: string;
  idleReleaseTimeoutSeconds: number;
  awsRegion: string;
  maximumDurationSeconds?: number;
  idlePolicy?: IdlePolicySpec;
  ingressNetworkConnectors?: string[];
  egressNetworkConnectors?: string[];
  logGroup?: string;
}

export interface RunHookPayload {
  version: string;
  worker: {
    poolName: string;
    workerName: string;
    workerId: string;
    repoUrls: string[];
    requestId?: string;
    mode: string;
    cursorApiUrl: string;
    cursorAgentEndpoint: string;
    cursorApiKeyParamName: string;
    gitTokenParamName?: string;
    repoCacheBucket?: string;
    idleReleaseTimeoutSeconds: number;
    awsRegion: string;
  };
}

export interface MicrovmLaunchSpec {
  action: "launch" | "resume";
  imageIdentifier?: string;
  microvmId?: string;
  executionRoleArn?: string;
  runHookPayload: string;
  maximumDurationInSeconds: number;
  idlePolicy?: IdlePolicySpec;
  ingressNetworkConnectors?: string[];
  egressNetworkConnectors?: string[];
  logging?: { cloudWatch: { logGroup: string } };
}

export const DEFAULT_IDLE_POLICY: IdlePolicySpec = {
  // AWS idle is *inbound proxy* idle. Outbound cursor-agent bridges look
  // idle to the platform even while connected. Default high so warm workers
  // do not flap; the worker's --idle-release-timeout is the real idle clock.
  maxIdleDurationSeconds: MAX_RUN_LIFETIME_SECONDS,
  suspendedDurationSeconds: MAX_RUN_LIFETIME_SECONDS,
  autoResumeEnabled: true,
};

export function allIngressArn(region: string): string {
  return `arn:aws:lambda:${region}:aws:network-connector:aws-network-connector:ALL_INGRESS`;
}

export function internetEgressArn(region: string): string {
  return `arn:aws:lambda:${region}:aws:network-connector:aws-network-connector:INTERNET_EGRESS`;
}

export function buildRunHookPayload(input: LaunchSpecInput): RunHookPayload {
  const worker: RunHookPayload["worker"] = {
    poolName: input.intent.poolName,
    workerName: input.intent.workerName,
    workerId: input.intent.workerName,
    repoUrls: input.intent.repoUrls,
    mode: input.intent.mode,
    cursorApiUrl: input.cursorApiUrl,
    cursorAgentEndpoint: input.cursorAgentEndpoint,
    cursorApiKeyParamName: input.cursorApiKeyParamName,
    idleReleaseTimeoutSeconds: input.idleReleaseTimeoutSeconds,
    awsRegion: input.awsRegion,
  };
  if (input.intent.requestId) {
    worker.requestId = input.intent.requestId;
  }
  if (input.gitTokenParamName) {
    worker.gitTokenParamName = input.gitTokenParamName;
  }
  if (input.repoCacheBucket) {
    worker.repoCacheBucket = input.repoCacheBucket;
  }
  return { version: RUN_HOOK_PAYLOAD_VERSION, worker };
}

export function assertNoSecrets(payload: unknown): void {
  const serialized = JSON.stringify(payload);
  const forbidden = ["CURSOR_API_KEY", "GIT_TOKEN", "ANTHROPIC_API_KEY"];
  for (const key of forbidden) {
    if (new RegExp(`"${key}"\\s*:\\s*"`).test(serialized) && !serialized.includes(`${key}_PARAM`)) {
      throw new Error(`run hook payload must not contain ${key}`);
    }
    if (serialized.includes("key_") && /sk-[a-zA-Z0-9]{8,}/.test(serialized)) {
      throw new Error("run hook payload looks like it contains a raw secret");
    }
  }
}

export function chooseResumeSlot(intent: LaunchIntent, slots: SlotSnapshot[]): SlotSnapshot | undefined {
  const candidates = slots.filter(
    (slot) =>
      slot.poolName === intent.poolName &&
      slot.status === "suspended" &&
      !slot.requestId,
  );
  return candidates[0];
}

export function buildLaunchSpec(input: LaunchSpecInput, slots: SlotSnapshot[] = []): MicrovmLaunchSpec {
  const payload = buildRunHookPayload(input);
  assertNoSecrets(payload);
  const runHookPayload = JSON.stringify(payload);
  const resume = chooseResumeSlot(input.intent, slots);
  const idlePolicy = input.idlePolicy ?? DEFAULT_IDLE_POLICY;
  const maximumDurationInSeconds = input.maximumDurationSeconds ?? MAX_RUN_LIFETIME_SECONDS;

  if (resume?.microvmId) {
    return {
      action: "resume",
      microvmId: resume.microvmId,
      runHookPayload,
      maximumDurationInSeconds,
      idlePolicy,
    };
  }

  return {
    action: "launch",
    imageIdentifier: input.imageIdentifier,
    executionRoleArn: input.executionRoleArn,
    runHookPayload,
    maximumDurationInSeconds,
    idlePolicy,
    ingressNetworkConnectors: input.ingressNetworkConnectors ?? [allIngressArn(input.awsRegion)],
    egressNetworkConnectors: input.egressNetworkConnectors ?? [internetEgressArn(input.awsRegion)],
    logging: input.logGroup ? { cloudWatch: { logGroup: input.logGroup } } : undefined,
  };
}

export function runMicrovmParams(spec: MicrovmLaunchSpec): Record<string, unknown> {
  if (spec.action !== "launch" || !spec.imageIdentifier) {
    throw new Error("runMicrovmParams requires a launch spec");
  }
  const params: Record<string, unknown> = {
    imageIdentifier: spec.imageIdentifier,
    runHookPayload: spec.runHookPayload,
    maximumDurationInSeconds: spec.maximumDurationInSeconds,
  };
  if (spec.executionRoleArn) {
    params.executionRoleArn = spec.executionRoleArn;
  }
  if (spec.idlePolicy) {
    params.idlePolicy = spec.idlePolicy;
  }
  if (spec.ingressNetworkConnectors) {
    params.ingressNetworkConnectors = spec.ingressNetworkConnectors;
  }
  if (spec.egressNetworkConnectors) {
    params.egressNetworkConnectors = spec.egressNetworkConnectors;
  }
  if (spec.logging) {
    params.logging = spec.logging;
  }
  return params;
}
