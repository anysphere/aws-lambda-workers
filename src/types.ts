export interface PendingRequest {
  readonly id: string;
  readonly repoOwner?: string;
  readonly repoName?: string;
  readonly repoUrl?: string;
  readonly labels: readonly { readonly key: string; readonly value: string }[];
  readonly createdAtMs: number;
}

export interface TickResult {
  readonly spawned: readonly SpawnedWorker[];
  readonly skipped: readonly SkippedRequest[];
  readonly errors: readonly TickError[];
}

export interface SpawnedWorker {
  readonly requestId: string;
  readonly workerName: string;
  readonly microvmId: string;
}

export interface SkippedRequest {
  readonly requestId?: string;
  readonly reason: string;
}

export interface TickError {
  readonly requestId?: string;
  readonly message: string;
}
