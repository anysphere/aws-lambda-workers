/**
 * AWS spawn hook for `agent worker controller --spawn ./spawn.mjs`
 * (or `cursor-agent worker controller --spawn ./spawn.mjs`).
 *
 * Reads CURSOR_* env from the CLI and submits one RunMicrovm. Returns
 * immediately — it does not wait for cursor-agent to finish.
 *
 * Exit codes:
 *   0  submitted
 *   1  retryable (throttles, 5xx, network)
 *   2+ non-retryable (missing env, 4xx)
 */

import { pathToFileURL } from "node:url";
import { canonicalizeUrl } from "./url.js";
import { buildLaunchSpec, type SpawnLaunchInput } from "./launch-spec.js";
import { LaunchMicroVmError, SignedMicroVmClient, type MicroVmClient } from "./microvm.js";

export const EXIT_OK = 0;
export const EXIT_RETRYABLE = 1;
export const EXIT_NON_RETRYABLE = 2;

export interface SpawnEnv {
  [key: string]: string | undefined;
}

export interface SpawnRequest extends SpawnLaunchInput {}

export interface SpawnResult {
  exitCode: number;
  message: string;
  microvmId?: string;
}

export function requiredEnv(env: SpawnEnv, key: string): string | undefined {
  const value = env[key]?.trim();
  return value ? value : undefined;
}

export function repoUrlFromEnv(env: SpawnEnv): string | undefined {
  const explicit = requiredEnv(env, "CURSOR_REPO_URL");
  if (explicit) {
    return explicit;
  }
  const owner = requiredEnv(env, "CURSOR_REPO_OWNER");
  const name = requiredEnv(env, "CURSOR_REPO_NAME");
  if (owner && name) {
    return canonicalizeUrl(`https://github.com/${owner}/${name}`).toString().replace(/\/+$/, "");
  }
  return undefined;
}

export function readSpawnRequest(env: SpawnEnv): { ok: true; request: SpawnRequest } | { ok: false; message: string } {
  const workerName = requiredEnv(env, "CURSOR_WORKER_NAME");
  if (!workerName) {
    return { ok: false, message: "CURSOR_WORKER_NAME is required" };
  }
  const apiKey = requiredEnv(env, "CURSOR_API_KEY");
  if (!apiKey) {
    return { ok: false, message: "CURSOR_API_KEY is required" };
  }
  const repoUrl = repoUrlFromEnv(env);
  if (!repoUrl) {
    return { ok: false, message: "CURSOR_REPO_URL or CURSOR_REPO_OWNER+CURSOR_REPO_NAME is required" };
  }
  const imageIdentifier = requiredEnv(env, "MICROVM_IMAGE_IDENTIFIER");
  if (!imageIdentifier) {
    return { ok: false, message: "MICROVM_IMAGE_IDENTIFIER is required" };
  }
  const executionRoleArn = requiredEnv(env, "MICROVM_EXECUTION_ROLE_ARN");
  if (!executionRoleArn) {
    return { ok: false, message: "MICROVM_EXECUTION_ROLE_ARN is required" };
  }
  const region = requiredEnv(env, "AWS_REGION") || requiredEnv(env, "AWS_DEFAULT_REGION") || "us-east-1";
  const idle = Number(env.WORKER_IDLE_RELEASE_TIMEOUT_SECONDS || "300");
  const extraIngress = requiredEnv(env, "EXTRA_INGRESS_CONNECTOR_ARN");
  const extraEgress = requiredEnv(env, "EXTRA_EGRESS_CONNECTOR_ARN");

  return {
    ok: true,
    request: {
      poolName: requiredEnv(env, "CURSOR_POOL") || "default",
      workerName,
      repoUrls: [repoUrl],
      requestId: requiredEnv(env, "CURSOR_REQUEST_ID"),
      userEmail: requiredEnv(env, "CURSOR_USER_EMAIL"),
      cursorApiKey: apiKey,
      cursorApiKeyParamName: requiredEnv(env, "CURSOR_API_KEY_PARAM_NAME"),
      gitTokenParamName: requiredEnv(env, "GIT_TOKEN_PARAM_NAME"),
      repoCacheBucket: requiredEnv(env, "REPO_CACHE_BUCKET"),
      cursorApiUrl: requiredEnv(env, "CURSOR_API_URL"),
      cursorAgentEndpoint: requiredEnv(env, "CURSOR_AGENT_ENDPOINT"),
      idleReleaseTimeoutSeconds: Number.isFinite(idle) && idle > 0 ? idle : 300,
      awsRegion: region,
      imageIdentifier,
      executionRoleArn,
      ingressNetworkConnectors: extraIngress
        ? [`arn:aws:lambda:${region}:aws:network-connector:aws-network-connector:ALL_INGRESS`, extraIngress]
        : undefined,
      egressNetworkConnectors: extraEgress
        ? [`arn:aws:lambda:${region}:aws:network-connector:aws-network-connector:INTERNET_EGRESS`, extraEgress]
        : undefined,
      logGroup: requiredEnv(env, "MICROVM_LOG_GROUP"),
    },
  };
}

export function exitCodeForError(error: unknown): number {
  if (error instanceof LaunchMicroVmError) {
    return error.retryable ? EXIT_RETRYABLE : EXIT_NON_RETRYABLE;
  }
  return EXIT_RETRYABLE;
}

export async function spawnMicrovm(
  env: SpawnEnv,
  clientFactory: (region: string) => MicroVmClient = (region) => new SignedMicroVmClient({ region }),
): Promise<SpawnResult> {
  const parsed = readSpawnRequest(env);
  if (!parsed.ok) {
    return { exitCode: EXIT_NON_RETRYABLE, message: parsed.message };
  }
  const spec = buildLaunchSpec(parsed.request);
  try {
    const launched = await clientFactory(parsed.request.awsRegion).launch(spec);
    return {
      exitCode: EXIT_OK,
      message: `submitted ${launched.microvmId}`,
      microvmId: launched.microvmId,
    };
  } catch (error) {
    return {
      exitCode: exitCodeForError(error),
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function main(env: SpawnEnv = process.env, log: Pick<Console, "log" | "error"> = console): Promise<number> {
  const result = await spawnMicrovm(env);
  if (result.exitCode === EXIT_OK) {
    log.log(result.message);
  } else {
    log.error(result.message);
  }
  return result.exitCode;
}

function isMain(): boolean {
  const entry = process.argv[1];
  if (!entry) {
    return false;
  }
  return import.meta.url === pathToFileURL(entry).href;
}

if (isMain()) {
  main()
    .then((code) => {
      process.exit(code);
    })
    .catch((error) => {
      console.error(error);
      process.exit(EXIT_RETRYABLE);
    });
}
