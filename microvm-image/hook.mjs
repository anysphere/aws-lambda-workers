#!/usr/bin/env node
// Lambda MicroVMs snapshot ENTRYPOINT and only deliver per-run pool/repo/key
// via POST /run (image env is shared). This process is that /run listener.
import { spawn } from "node:child_process";
import http from "node:http";

const PORT = Number(process.env.HOOK_PORT || 9000);
const PREFIX = "/aws/lambda-microvms/runtime/v1";
const ENTRYPOINT = process.env.WORKER_ENTRYPOINT || "/opt/cursor/entrypoint.sh";

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function envFromBody(raw) {
  if (!raw) return {};
  const envelope = JSON.parse(raw);
  const inner = envelope.runHookPayload
    ? JSON.parse(envelope.runHookPayload)
    : envelope;
  return inner.env && typeof inner.env === "object" ? inner.env : {};
}

let child;
function startWorker(env) {
  if (child && !child.killed) {
    try {
      child.kill("SIGTERM");
    } catch {
      /* ignore */
    }
  }
  child = spawn(ENTRYPOINT, [], { env: { ...process.env, ...env }, stdio: "inherit" });
  child.on("exit", (code, signal) => {
    console.log(`hook: worker exited code=${code} signal=${signal}`);
    if (child && child.exitCode !== null) child = undefined;
  });
}

const server = http.createServer(async (req, res) => {
  const ok = () => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end('{"status":"ok"}');
  };
  if (req.method !== "POST" || !req.url?.startsWith(PREFIX)) {
    res.writeHead(404);
    res.end();
    return;
  }
  const hook = req.url.slice(PREFIX.length + 1);
  try {
    if (hook === "ready" || hook === "validate" || hook === "suspend" || hook === "terminate") {
      ok();
      return;
    }
    if (hook === "run" || hook === "resume") {
      const env = envFromBody(await readBody(req));
      ok();
      startWorker(env);
      return;
    }
    res.writeHead(404);
    res.end();
  } catch (err) {
    console.error(`hook: ${hook} failed`, err);
    if (!res.headersSent) {
      res.writeHead(500);
      res.end();
    }
  }
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`hook: listening on ${PORT}`);
});
