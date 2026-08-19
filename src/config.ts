import { canonicalizeUrl } from "./url.js";
import { allIngressArn, internetEgressArn } from "./launch-spec.js";

export const DEFAULT_POOL_NAME = "default";
export const DEFAULT_CONCURRENCY = 3;
export const DEFAULT_POLL_INTERVAL_SECONDS = 60;
export const DEFAULT_WORKER_IDLE_RELEASE_TIMEOUT_SECONDS = 300;
export const DEFAULT_CURSOR_API_URL = "https://api.cursor.com";
export const DEFAULT_LEASE_TTL_MS = 5 * 60 * 1000;

export interface EnvLike {
  [key: string]: string | undefined;
}

export interface ControllerSettings {
  poolName: string;
  concurrency: number;
  leaseTtlMs: number;
  workerIdleReleaseTimeoutSeconds: number;
  cursorApiUrl: string;
  cursorAgentEndpoint?: string;
  cursorApiKeyParamName: string;
  gitTokenParamName?: string;
  imageIdentifier: string;
  executionRoleArn: string;
  awsRegion: string;
  ingressNetworkConnectors: string[];
  egressNetworkConnectors: string[];
  logGroup?: string;
}

export function parsePositiveInt(raw: string | undefined, label: string, fallback: number): number {
  if (raw === undefined || raw === "") {
    return fallback;
  }
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`${label} must be a positive integer`);
  }
  return parsed;
}

export function loadSettings(env: EnvLike): ControllerSettings {
  const region = env.AWS_REGION || env.AWS_DEFAULT_REGION || "us-east-1";
  const imageIdentifier = required(env, "MICROVM_IMAGE_IDENTIFIER");
  const executionRoleArn = required(env, "MICROVM_EXECUTION_ROLE_ARN");
  const cursorApiKeyParamName = required(env, "CURSOR_API_KEY_PARAM_NAME");
  const extraIngress = trim(env.EXTRA_INGRESS_CONNECTOR_ARN);
  const extraEgress = trim(env.EXTRA_EGRESS_CONNECTOR_ARN);
  const gitTokenParamName = trim(env.GIT_TOKEN_PARAM_NAME);
  const logGroup = trim(env.MICROVM_LOG_GROUP);
  const agentEndpoint = trim(env.CURSOR_AGENT_ENDPOINT);

  return {
    poolName: trim(env.POOL_NAME) || DEFAULT_POOL_NAME,
    concurrency: parsePositiveInt(env.CONCURRENCY, "CONCURRENCY", DEFAULT_CONCURRENCY),
    leaseTtlMs: parsePositiveInt(env.LEASE_TTL_MS, "LEASE_TTL_MS", DEFAULT_LEASE_TTL_MS),
    workerIdleReleaseTimeoutSeconds: parsePositiveInt(
      env.WORKER_IDLE_RELEASE_TIMEOUT_SECONDS,
      "WORKER_IDLE_RELEASE_TIMEOUT_SECONDS",
      DEFAULT_WORKER_IDLE_RELEASE_TIMEOUT_SECONDS,
    ),
    cursorApiUrl: trim(env.CURSOR_API_URL) || DEFAULT_CURSOR_API_URL,
    cursorAgentEndpoint: agentEndpoint,
    cursorApiKeyParamName,
    gitTokenParamName,
    imageIdentifier,
    executionRoleArn,
    awsRegion: region,
    ingressNetworkConnectors: extraIngress
      ? [allIngressArn(region), extraIngress]
      : [allIngressArn(region)],
    egressNetworkConnectors: extraEgress
      ? [internetEgressArn(region), extraEgress]
      : [internetEgressArn(region)],
    logGroup,
  };
}

export function apiUrl(value: string): string {
  return canonicalizeUrl(value).toString().replace(/\/+$/, "");
}

function required(env: EnvLike, key: string): string {
  const value = trim(env[key]);
  if (!value) {
    throw new Error(`${key} is required`);
  }
  return value;
}

function trim(value: string | undefined): string | undefined {
  const next = value?.trim();
  return next ? next : undefined;
}
