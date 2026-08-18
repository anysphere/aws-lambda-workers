import { DynamoSlotStore } from "./dynamo.js";
import { SignedMicroVmClient } from "./microvm.js";
import { createLiveDeps, tickOnce, type TickResult } from "./scheduler.js";

interface LambdaResponse {
  statusCode: number;
  headers?: Record<string, string>;
  body: string;
}

function json(statusCode: number, body: unknown): LambdaResponse {
  return {
    statusCode,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  };
}

function isHttpEvent(event: Record<string, unknown>): boolean {
  return typeof event.rawPath === "string" || typeof event.path === "string" || typeof event.requestContext === "object";
}

function isScheduleEvent(event: Record<string, unknown>): boolean {
  return event.source === "aws.events" || event["detail-type"] === "Scheduled Event";
}

function requestPath(event: Record<string, unknown>): string {
  const raw = String(event.rawPath ?? event.path ?? "/");
  return raw.replace(/\/+$/, "") || "/";
}

function requestMethod(event: Record<string, unknown>): string {
  const requestContext = event.requestContext as { http?: { method?: string } } | undefined;
  return String(event.httpMethod ?? requestContext?.http?.method ?? "GET").toUpperCase();
}

function headerMap(event: Record<string, unknown>): Record<string, string> {
  const headers = (event.headers ?? {}) as Record<string, string>;
  const normalized: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    normalized[key.toLowerCase()] = value;
  }
  return normalized;
}

function authorize(event: Record<string, unknown>): boolean {
  const expected = process.env.ADMIN_TOKEN;
  if (!expected) {
    return false;
  }
  const headers = headerMap(event);
  const auth = headers.authorization ?? "";
  const bearer = auth.startsWith("Bearer ") ? auth.slice("Bearer ".length) : "";
  return bearer === expected || headers["x-admin-token"] === expected;
}

async function runTick(): Promise<TickResult> {
  const region = process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || "us-east-1";
  const table = process.env.SLOT_TABLE_NAME;
  if (!table) {
    throw new Error("SLOT_TABLE_NAME is required");
  }
  const store = new DynamoSlotStore(table);
  const microvms = new SignedMicroVmClient({ region });
  const deps = await createLiveDeps(process.env, microvms, {
    load: () => store.load(),
    save: (next) => store.save(next),
  });
  return tickOnce(deps);
}

async function statusBody(): Promise<unknown> {
  const table = process.env.SLOT_TABLE_NAME;
  if (!table) {
    return { ok: false, error: "SLOT_TABLE_NAME missing" };
  }
  const store = new DynamoSlotStore(table);
  const state = await store.load();
  return {
    ok: true,
    slots: state.slots,
    poolMeta: state.poolMeta,
    cooldownRequests: Object.keys(state.cooldowns.requestUntilMs).length,
  };
}

export async function handler(event: Record<string, unknown> = {}): Promise<LambdaResponse | TickResult> {
  if (isScheduleEvent(event) || event.tick === true) {
    return runTick();
  }

  if (isHttpEvent(event)) {
    const path = requestPath(event);
    const method = requestMethod(event);

    if (path === "/health" && method === "GET") {
      return json(200, { ok: true });
    }

    if ((path === "/status" || path === "/tick") && !authorize(event)) {
      return json(401, { error: "unauthorized" });
    }

    if (path === "/status" && method === "GET") {
      return json(200, await statusBody());
    }

    if (path === "/tick" && (method === "POST" || method === "GET")) {
      const result = await runTick();
      return json(result.errors.length > 0 ? 207 : 200, result);
    }

    return json(404, { error: "not_found" });
  }

  return runTick();
}
