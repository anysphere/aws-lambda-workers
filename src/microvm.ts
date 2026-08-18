/**
 * Thin lambda-microvms client. Signs REST calls so we do not depend on a
 * matching @aws-sdk/client-lambda-microvms release.
 */

import { Sha256 } from "@aws-crypto/sha256-js";
import { defaultProvider } from "@aws-sdk/credential-provider-node";
import { HttpRequest } from "@smithy/protocol-http";
import { SignatureV4 } from "@smithy/signature-v4";
import { runMicrovmParams, type MicrovmLaunchSpec } from "./launch-spec.js";

export const MICROVM_SERVICE = "lambda-microvms";

export interface LaunchedMicroVm {
  microvmId: string;
  endpoint?: string;
}

export interface MicroVmClient {
  launch(spec: MicrovmLaunchSpec): Promise<LaunchedMicroVm>;
}

export class LaunchMicroVmError extends Error {
  readonly status?: number;
  readonly retryable: boolean;

  constructor(message: string, options: { status?: number; retryable?: boolean; cause?: unknown } = {}) {
    super(message);
    this.name = "LaunchMicroVmError";
    this.status = options.status;
    this.retryable = options.retryable ?? isRetryableStatus(options.status);
    if (options.cause !== undefined) {
      this.cause = options.cause;
    }
  }
}

export function isRetryableStatus(status: number | undefined): boolean {
  if (status === undefined) {
    return true;
  }
  return status === 408 || status === 429 || status >= 500;
}

interface SignedClientOptions {
  region: string;
  fetchImpl?: typeof fetch;
  credentials?: () => Promise<{ accessKeyId: string; secretAccessKey: string; sessionToken?: string }>;
}

export class SignedMicroVmClient implements MicroVmClient {
  private readonly region: string;
  private readonly fetchImpl: typeof fetch;
  private readonly credentials: SignedClientOptions["credentials"];

  constructor(options: SignedClientOptions) {
    this.region = options.region;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.credentials = options.credentials ?? defaultProvider();
  }

  private endpointHost(): string {
    return `${MICROVM_SERVICE}.${this.region}.amazonaws.com`;
  }

  private async signedFetch(method: string, path: string, body?: unknown): Promise<Response> {
    const payload = body === undefined ? "" : JSON.stringify(body);
    const request = new HttpRequest({
      protocol: "https:",
      hostname: this.endpointHost(),
      method,
      path,
      headers: {
        host: this.endpointHost(),
        "content-type": "application/json",
      },
      body: payload || undefined,
    });
    const signer = new SignatureV4({
      service: MICROVM_SERVICE,
      region: this.region,
      credentials: this.credentials!,
      sha256: Sha256,
    });
    const signed = await signer.sign(request);
    const headers = new Headers();
    for (const [key, value] of Object.entries(signed.headers)) {
      if (typeof value === "string") {
        headers.set(key, value);
      }
    }
    return this.fetchImpl(`https://${this.endpointHost()}${path}`, {
      method,
      headers,
      body: payload || undefined,
    });
  }

  async launch(spec: MicrovmLaunchSpec): Promise<LaunchedMicroVm> {
    const params = runMicrovmParams(spec);
    let response: Response;
    try {
      response = await this.signedFetch("POST", "/microvms", params);
    } catch (error) {
      throw new LaunchMicroVmError(`RunMicrovm network error: ${error instanceof Error ? error.message : error}`, {
        retryable: true,
        cause: error,
      });
    }
    const text = await response.text();
    if (!response.ok) {
      throw new LaunchMicroVmError(`RunMicrovm failed: ${response.status} ${text}`, {
        status: response.status,
        cause: text,
      });
    }
    const parsed = text ? (JSON.parse(text) as { microvmId?: string; endpoint?: string }) : {};
    if (!parsed.microvmId) {
      throw new LaunchMicroVmError(`RunMicrovm response missing microvmId: ${text}`, { retryable: true });
    }
    return { microvmId: parsed.microvmId, endpoint: parsed.endpoint };
  }
}
