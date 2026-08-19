/**
 * Thin Lambda wrapper. Does not poll, claim, or plan — it execs the
 * published CLI:
 *   agent worker controller --spawn ./spawn.mjs
 *
 * EventBridge re-invokes this function. If the CLI is a long-running loop,
 * Lambda timeout stops it and the next schedule starts a new process.
 * Pass extra CLI flags via CURSOR_WORKER_CONTROLLER_ARGS (e.g. --once).
 */

import { spawn, type ChildProcess } from "node:child_process";
import { join } from "node:path";
import { SSMClient, GetParameterCommand } from "@aws-sdk/client-ssm";

export interface ControllerEnv {
  [key: string]: string | undefined;
}

export interface RunControllerOptions {
  env?: ControllerEnv;
  spawnImpl?: typeof spawn;
  readApiKey?: (env: ControllerEnv) => Promise<string>;
}

export function controllerArgs(env: ControllerEnv = process.env): string[] {
  const script = env.SPAWN_SCRIPT || join(process.cwd(), "spawn.mjs");
  const extra = (env.CURSOR_WORKER_CONTROLLER_ARGS || "")
    .split(/\s+/)
    .map((part) => part.trim())
    .filter(Boolean);
  return ["worker", "controller", "--spawn", script, ...extra];
}

export function agentBin(env: ControllerEnv = process.env): string {
  return env.CURSOR_AGENT_BIN || "agent";
}

export async function readCursorApiKey(env: ControllerEnv): Promise<string> {
  const inline = env.CURSOR_API_KEY?.trim();
  if (inline) {
    return inline;
  }
  const name = env.CURSOR_API_KEY_PARAM_NAME?.trim();
  if (!name) {
    throw new Error("CURSOR_API_KEY or CURSOR_API_KEY_PARAM_NAME is required");
  }
  const region = env.AWS_REGION || env.AWS_DEFAULT_REGION || "us-east-1";
  const client = new SSMClient({ region });
  const result = await client.send(new GetParameterCommand({ Name: name, WithDecryption: true }));
  const value = result.Parameter?.Value?.trim();
  if (!value) {
    throw new Error(`SSM parameter ${name} has no value`);
  }
  return value;
}

function waitForChild(child: ChildProcess): Promise<number> {
  return new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (code !== null) {
        resolve(code);
        return;
      }
      resolve(signal ? 1 : 0);
    });
  });
}

export async function runWorkerController(options: RunControllerOptions = {}): Promise<{ ok: true; exitCode: number }> {
  const env = options.env ?? process.env;
  const spawnImpl = options.spawnImpl ?? spawn;
  const readApiKey = options.readApiKey ?? readCursorApiKey;
  const apiKey = await readApiKey(env);
  const bin = agentBin(env);
  const args = controllerArgs(env);
  const child = spawnImpl(bin, args, {
    env: { ...env, CURSOR_API_KEY: apiKey },
    stdio: "inherit",
  });
  const exitCode = await waitForChild(child);
  if (exitCode !== 0) {
    throw new Error(`${bin} ${args.join(" ")} exited ${exitCode}`);
  }
  return { ok: true, exitCode };
}

export async function handler(): Promise<{ ok: true; exitCode: number }> {
  return runWorkerController();
}
