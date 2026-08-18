#!/usr/bin/env node
// Lambda MicroVM lifecycle hooks for a Cursor pool worker.
//
// POST /aws/lambda-microvms/runtime/v1/{ready,validate,run,resume,suspend,terminate}
//
// /run and /resume must return 200 quickly. Clone + cursor-agent start happen
// in the background. Worker name / IDs / secrets are minted here, never at
// image build, because they would be frozen into the snapshot.

import { spawn } from "node:child_process";
import http from "node:http";
import { SSMClient, GetParameterCommand } from "@aws-sdk/client-ssm";

const HOOK_PORT = Number(process.env.HOOK_PORT || 9000);
const HOOK_HOST = "0.0.0.0";
const HOOK_PREFIX = "/aws/lambda-microvms/runtime/v1";
const ENTRYPOINT = process.env.WORKER_ENTRYPOINT || "/opt/cursor/entrypoint.sh";

let workerChild;
let startedForRun = false;

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

function parseRunEnvelope(raw) {
  if (!raw) return { envelope: {}, dispatch: {} };
  const envelope = JSON.parse(raw);
  const inner = envelope.runHookPayload
    ? JSON.parse(envelope.runHookPayload)
    : envelope;
  const dispatch = inner.worker || inner.session || inner;
  return { envelope, dispatch };
}

async function fetchParameter(name, region) {
  const client = new SSMClient({ region });
  const result = await client.send(
    new GetParameterCommand({ Name: name, WithDecryption: true }),
  );
  const value = result.Parameter?.Value;
  if (!value) {
    throw new Error(`SSM parameter ${name} has no value`);
  }
  return value;
}

function stopWorker(signal = "SIGTERM") {
  if (!workerChild || workerChild.killed) {
    return;
  }
  try {
    workerChild.kill(signal);
  } catch (err) {
    console.warn("hooks: failed to signal worker", err);
  }
}

function startWorker(env) {
  stopWorker();
  const child = spawn(ENTRYPOINT, [], {
    env: { ...process.env, ...env },
    stdio: "inherit",
  });
  child.on("exit", (code, signal) => {
    console.log(`hooks: worker exited code=${code} signal=${signal}`);
    if (workerChild === child) {
      workerChild = undefined;
    }
  });
  workerChild = child;
  return child;
}

function randomWorkerId(prefix = "pw") {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  return `${prefix}_${hex}`;
}

async function materializeRuntimeEnv(dispatch) {
  const region = dispatch.awsRegion || process.env.AWS_REGION || "us-east-1";
  const workerId = dispatch.workerId || dispatch.workerName || randomWorkerId();
  const paramName = dispatch.cursorApiKeyParamName || process.env.CURSOR_API_KEY_PARAM_NAME;
  if (!paramName) {
    throw new Error("cursorApiKeyParamName is required");
  }
  const apiKey = await fetchParameter(paramName, region);
  let gitToken;
  if (dispatch.gitTokenParamName) {
    gitToken = await fetchParameter(dispatch.gitTokenParamName, region);
  }
  const repoUrls = Array.isArray(dispatch.repoUrls) ? dispatch.repoUrls.join(",") : "";
  const env = {
    AWS_REGION: region,
    POOL_NAME: dispatch.poolName || "default",
    WORKER_NAME: workerId,
    CURSOR_AGENT_WORKER_ID: workerId,
    CURSOR_API_KEY: apiKey,
    CURSOR_API_URL: dispatch.cursorApiUrl || "",
    CURSOR_AGENT_ENDPOINT: dispatch.cursorAgentEndpoint || "",
    REPO_URLS: repoUrls,
    IDLE_RELEASE_TIMEOUT_SECONDS: String(dispatch.idleReleaseTimeoutSeconds || 300),
    REPO_CACHE_BUCKET: dispatch.repoCacheBucket || "",
  };
  if (gitToken) {
    env.GIT_TOKEN = gitToken;
  }
  return env;
}

async function handleRunOrResume(dispatch, kind) {
  const env = await materializeRuntimeEnv(dispatch);
  console.log(`hooks: ${kind} pool=${env.POOL_NAME} worker=${env.WORKER_NAME} repos=${env.REPO_URLS}`);
  startWorker(env);
}

const server = http.createServer(async (req, res) => {
  const ok = (body = { status: "ok" }) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };

  if (req.url === "/health") {
    ok({ status: "ok", workerRunning: Boolean(workerChild) });
    return;
  }

  if (req.method !== "POST" || !req.url?.startsWith(HOOK_PREFIX)) {
    res.writeHead(404);
    res.end();
    return;
  }

  const hook = req.url.slice(HOOK_PREFIX.length + 1);

  try {
    switch (hook) {
      case "ready":
      case "validate":
        // Snapshot gate: hook server is up. Do not start a unique worker here.
        ok({ status: "ready", git: true, agent: true });
        return;
      case "run": {
        const raw = await readBody(req);
        const { dispatch } = parseRunEnvelope(raw);
        if (!dispatch.poolName && !dispatch.cursorApiKeyParamName) {
          res.writeHead(400, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "invalid run payload" }));
          return;
        }
        ok({ status: "accepted" });
        if (startedForRun) {
          return;
        }
        startedForRun = true;
        handleRunOrResume(dispatch, "run").catch((err) => {
          console.error("hooks: /run background start failed", err);
        });
        return;
      }
      case "resume": {
        const raw = await readBody(req);
        const { dispatch } = parseRunEnvelope(raw);
        ok({ status: "accepted" });
        handleRunOrResume(dispatch, "resume").catch((err) => {
          console.error("hooks: /resume background start failed", err);
        });
        return;
      }
      case "suspend":
        stopWorker("SIGTERM");
        ok({ status: "suspending" });
        return;
      case "terminate":
        stopWorker("SIGTERM");
        ok({ status: "terminating" });
        return;
      default:
        res.writeHead(404);
        res.end();
    }
  } catch (err) {
    console.error(`hooks: ${hook} failed`, err);
    if (!res.headersSent) {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "hook_failed" }));
    }
  }
});

server.listen(HOOK_PORT, HOOK_HOST, () => {
  console.log(`hooks: listening on ${HOOK_HOST}:${HOOK_PORT}`);
});
