/**
 * One-shot RunMicrovm payload for a controller-spawned worker.
 */

export const RUN_HOOK_PAYLOAD_VERSION = "1";
export const MAX_RUN_LIFETIME_SECONDS = 28_800;

export interface IdlePolicySpec {
  maxIdleDurationSeconds: number;
  suspendedDurationSeconds: number;
  autoResumeEnabled: boolean;
}

export interface SpawnLaunchInput {
  poolName: string;
  workerName: string;
  repoUrls: readonly string[];
  requestId?: string;
  userEmail?: string;
  cursorApiKey?: string;
  cursorApiKeyParamName?: string;
  gitTokenParamName?: string;
  repoCacheBucket?: string;
  cursorApiUrl?: string;
  cursorAgentEndpoint?: string;
  idleReleaseTimeoutSeconds: number;
  awsRegion: string;
  imageIdentifier: string;
  executionRoleArn: string;
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
    userEmail?: string;
    mode: "serve";
    cursorApiKey?: string;
    cursorApiKeyParamName?: string;
    gitTokenParamName?: string;
    repoCacheBucket?: string;
    cursorApiUrl?: string;
    cursorAgentEndpoint?: string;
    idleReleaseTimeoutSeconds: number;
    awsRegion: string;
  };
}

export interface MicrovmLaunchSpec {
  action: "launch";
  imageIdentifier: string;
  executionRoleArn: string;
  runHookPayload: string;
  maximumDurationInSeconds: number;
  idlePolicy: IdlePolicySpec;
  ingressNetworkConnectors: string[];
  egressNetworkConnectors: string[];
  logging?: { cloudWatch: { logGroup: string } };
}

export const DEFAULT_IDLE_POLICY: IdlePolicySpec = {
  // Inbound-proxy idle is not the worker clock. cursor-agent
  // --idle-release-timeout exits the process; hooks then terminate the VM.
  maxIdleDurationSeconds: MAX_RUN_LIFETIME_SECONDS,
  suspendedDurationSeconds: 0,
  autoResumeEnabled: false,
};

export function allIngressArn(region: string): string {
  return `arn:aws:lambda:${region}:aws:network-connector:aws-network-connector:ALL_INGRESS`;
}

export function internetEgressArn(region: string): string {
  return `arn:aws:lambda:${region}:aws:network-connector:aws-network-connector:INTERNET_EGRESS`;
}

export function buildRunHookPayload(input: SpawnLaunchInput): RunHookPayload {
  const worker: RunHookPayload["worker"] = {
    poolName: input.poolName,
    workerName: input.workerName,
    workerId: input.workerName,
    repoUrls: [...input.repoUrls],
    mode: "serve",
    idleReleaseTimeoutSeconds: input.idleReleaseTimeoutSeconds,
    awsRegion: input.awsRegion,
  };
  if (input.requestId) worker.requestId = input.requestId;
  if (input.userEmail) worker.userEmail = input.userEmail;
  if (input.cursorApiKeyParamName) {
    worker.cursorApiKeyParamName = input.cursorApiKeyParamName;
  } else if (input.cursorApiKey) {
    worker.cursorApiKey = input.cursorApiKey;
  }
  if (input.gitTokenParamName) worker.gitTokenParamName = input.gitTokenParamName;
  if (input.repoCacheBucket) worker.repoCacheBucket = input.repoCacheBucket;
  if (input.cursorApiUrl) worker.cursorApiUrl = input.cursorApiUrl;
  if (input.cursorAgentEndpoint) worker.cursorAgentEndpoint = input.cursorAgentEndpoint;
  return { version: RUN_HOOK_PAYLOAD_VERSION, worker };
}

export function buildLaunchSpec(input: SpawnLaunchInput): MicrovmLaunchSpec {
  const payload = buildRunHookPayload(input);
  return {
    action: "launch",
    imageIdentifier: input.imageIdentifier,
    executionRoleArn: input.executionRoleArn,
    runHookPayload: JSON.stringify(payload),
    maximumDurationInSeconds: MAX_RUN_LIFETIME_SECONDS,
    idlePolicy: DEFAULT_IDLE_POLICY,
    ingressNetworkConnectors: input.ingressNetworkConnectors ?? [allIngressArn(input.awsRegion)],
    egressNetworkConnectors: input.egressNetworkConnectors ?? [internetEgressArn(input.awsRegion)],
    logging: input.logGroup ? { cloudWatch: { logGroup: input.logGroup } } : undefined,
  };
}

export function runMicrovmParams(spec: MicrovmLaunchSpec): Record<string, unknown> {
  const params: Record<string, unknown> = {
    imageIdentifier: spec.imageIdentifier,
    runHookPayload: spec.runHookPayload,
    maximumDurationInSeconds: spec.maximumDurationInSeconds,
    executionRoleArn: spec.executionRoleArn,
    idlePolicy: spec.idlePolicy,
    ingressNetworkConnectors: spec.ingressNetworkConnectors,
    egressNetworkConnectors: spec.egressNetworkConnectors,
  };
  if (spec.logging) {
    params.logging = spec.logging;
  }
  return params;
}
