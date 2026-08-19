#!/usr/bin/env node
/** Lambda entry: exec `cursor-agent worker controller --spawn ./spawn.mjs`. */
import { spawn } from "node:child_process";

export async function handler() {
  const bin = process.env.CURSOR_AGENT_BIN || "cursor-agent";
  const extra = (process.env.CURSOR_WORKER_CONTROLLER_ARGS || "").trim().split(/\s+/).filter(Boolean);
  const args = ["worker", "controller", "--spawn", "./spawn.mjs", ...extra];
  const code = await new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: "inherit", env: process.env });
    child.on("error", reject);
    child.on("exit", (c) => resolve(c ?? 1));
  });
  if (code !== 0) throw new Error(`${bin} ${args.join(" ")} exited ${code}`);
  return { ok: true };
}
