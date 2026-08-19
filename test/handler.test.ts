import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import { agentBin, controllerArgs, runWorkerController } from "../src/index.js";

describe("controllerArgs", () => {
  it("execs agent worker controller --spawn, not a home-grown poll loop", () => {
    expect(agentBin({ CURSOR_AGENT_BIN: "cursor-agent" })).toBe("cursor-agent");
    expect(controllerArgs({ SPAWN_SCRIPT: "/var/task/spawn.mjs" })).toEqual([
      "worker",
      "controller",
      "--spawn",
      "/var/task/spawn.mjs",
    ]);
  });

  it("forwards optional one-tick flags from CURSOR_WORKER_CONTROLLER_ARGS", () => {
    expect(
      controllerArgs({
        SPAWN_SCRIPT: "./spawn.mjs",
        CURSOR_WORKER_CONTROLLER_ARGS: "--once",
      }),
    ).toEqual(["worker", "controller", "--spawn", "./spawn.mjs", "--once"]);
  });
});

describe("runWorkerController", () => {
  it("spawns the CLI with CURSOR_API_KEY and does not call pending-requests", async () => {
    const calls: { bin: string; args: string[]; env?: NodeJS.ProcessEnv }[] = [];
    const spawnImpl = ((bin: string, args: string[], options: { env?: NodeJS.ProcessEnv }) => {
      calls.push({ bin, args, env: options.env });
      const child = new EventEmitter();
      queueMicrotask(() => child.emit("exit", 0, null));
      return child;
    }) as unknown as typeof import("node:child_process").spawn;

    const result = await runWorkerController({
      env: {
        SPAWN_SCRIPT: "/var/task/spawn.mjs",
        CURSOR_AGENT_BIN: "agent",
      },
      spawnImpl,
      readApiKey: async () => "secret-key",
    });
    expect(result).toEqual({ ok: true, exitCode: 0 });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.bin).toBe("agent");
    expect(calls[0]?.args).toEqual(["worker", "controller", "--spawn", "/var/task/spawn.mjs"]);
    expect(calls[0]?.env?.CURSOR_API_KEY).toBe("secret-key");
  });
});
