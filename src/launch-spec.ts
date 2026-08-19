/**
 * One-shot RunMicrovm payload. Per-VM pool/repo/key cannot be image env
 * (those are snapshotted); AWS delivers this string to the image /run hook.
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
  repoUrl: string;
  requestId?: string;
  cursorApiKey: string;
  gitToken?: string;
  cursorApiUrl?: string;
  cursorAgentEndpoint?: string;
  idleReleaseTimeoutSeconds: number;
  awsRegion: string;
  imageIdentifier: string;
  executionRoleArn: string;
  ingressNetworkConnectors: string[];
  egressNetworkConnectors: string[];
  logGroup?: string;
}

export interface RunHookPayload {
  version: string;
  env: Record<string, string>;
}

export interface MicrovmLaunchSpec {
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
  // Outbound pool workers do not trip inbound-proxy idle. The agent
  // --idle-release-timeout exits; maximumDurationInSeconds reaps the VM.
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
  const env: Record<string, string> = {
    POOL_NAME: input.poolName,
    WORKER_NAME: input.workerName,
    CURSOR_AGENT_WORKER_ID: input.workerName,
    CURSOR_API_KEY: input.cursorApiKey,
    REPO_URL: input.repoUrl,
    IDLE_RELEASE_TIMEOUT_SECONDS: String(input.idleReleaseTimeoutSeconds),
    AWS_REGION: input.awsRegion,
  };
  if (input.requestId) env.CURSOR_REQUEST_ID = input.requestId;
  if (input.gitToken) env.GIT_TOKEN = input.gitToken;
  if (input.cursorApiUrl) env.CURSOR_API_URL = input.cursorApiUrl;
  if (input.cursorAgentEndpoint) env.CURSOR_AGENT_ENDPOINT = input.cursorAgentEndpoint;
  return { version: RUN_HOOK_PAYLOAD_VERSION, env };
}

export function buildLaunchSpec(input: SpawnLaunchInput): MicrovmLaunchSpec {
  return {
    imageIdentifier: input.imageIdentifier,
    executionRoleArn: input.executionRoleArn,
    runHookPayload: JSON.stringify(buildRunHookPayload(input)),
    maximumDurationInSeconds: MAX_RUN_LIFETIME_SECONDS,
    idlePolicy: DEFAULT_IDLE_POLICY,
    ingressNetworkConnectors: input.ingressNetworkConnectors,
    egressNetworkConnectors: input.egressNetworkConnectors,
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
