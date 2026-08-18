/**
 * Thin lambda-microvms client.
 *
 * The service model is new enough that we sign REST calls ourselves rather
 * than requiring a matching @aws-sdk/client-lambda-microvms release on the
 * scheduler image.
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
  resume(microvmId: string): Promise<void>;
  suspend(microvmId: string): Promise<void>;
  terminate(microvmId: string): Promise<void>;
}

export class LaunchMicroVmError extends Error {
  constructor(
    message: string,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = "LaunchMicroVmError";
  }
}

interface SignedClientOptions {
  region: string;
  fetchImpl?: typeof fetch;
}

export class SignedMicroVmClient implements MicroVmClient {
  private readonly region: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: SignedClientOptions) {
    this.region = options.region;
    this.fetchImpl = options.fetchImpl ?? fetch;
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
      credentials: defaultProvider(),
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
    if (spec.action === "resume" && spec.microvmId) {
      await this.resume(spec.microvmId);
      return { microvmId: spec.microvmId };
    }
    const params = runMicrovmParams(spec);
    const response = await this.signedFetch("POST", "/microvms", params);
    const text = await response.text();
    if (!response.ok) {
      throw new LaunchMicroVmError(`RunMicrovm failed: ${response.status} ${text}`, text);
    }
    const parsed = text ? (JSON.parse(text) as { microvmId?: string; endpoint?: string }) : {};
    if (!parsed.microvmId) {
      throw new LaunchMicroVmError(`RunMicrovm response missing microvmId: ${text}`);
    }
    return { microvmId: parsed.microvmId, endpoint: parsed.endpoint };
  }

  async resume(microvmId: string): Promise<void> {
    const response = await this.signedFetch("POST", `/microvms/${encodeURIComponent(microvmId)}/resume`);
    if (!response.ok) {
      throw new LaunchMicroVmError(`ResumeMicrovm failed: ${response.status} ${await response.text()}`);
    }
  }

  async suspend(microvmId: string): Promise<void> {
    const response = await this.signedFetch("POST", `/microvms/${encodeURIComponent(microvmId)}/suspend`);
    if (!response.ok) {
      throw new LaunchMicroVmError(`SuspendMicrovm failed: ${response.status} ${await response.text()}`);
    }
  }

  async terminate(microvmId: string): Promise<void> {
    const response = await this.signedFetch("POST", `/microvms/${encodeURIComponent(microvmId)}/terminate`);
    if (!response.ok) {
      throw new LaunchMicroVmError(`TerminateMicrovm failed: ${response.status} ${await response.text()}`);
    }
  }
}
