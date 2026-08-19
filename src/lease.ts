/**
 * In-process spawn lease. Prevents the same pending request from launching
 * twice on a warm Lambda. Not a DynamoDB slot planner.
 */
export class SpawnLease {
  private readonly until = new Map<string, number>();

  constructor(
    private readonly ttlMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  get size(): number {
    this.gc();
    return this.until.size;
  }

  has(id: string): boolean {
    this.gc();
    return this.until.has(id);
  }

  tryAcquire(id: string): boolean {
    this.gc();
    if (this.until.has(id)) {
      return false;
    }
    this.until.set(id, this.now() + this.ttlMs);
    return true;
  }

  release(id: string): void {
    this.until.delete(id);
  }

  private gc(): void {
    const now = this.now();
    for (const [id, expires] of this.until) {
      if (expires <= now) {
        this.until.delete(id);
      }
    }
  }
}
