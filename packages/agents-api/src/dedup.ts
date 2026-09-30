/**
 * One boot per environment id. Concurrent webhook deliveries share the same promise.
 */
export class DedupedCompute {
  private running = new Map<string, Promise<void>>();

  ensure(id: string, boot: () => Promise<void>): Promise<void> {
    const existing = this.running.get(id);
    if (existing) return existing;
    let settle!: (value: Promise<void>) => void;
    const gate = new Promise<void>((resolve, reject) => {
      settle = (value) => {
        value.then(resolve, reject);
      };
    });
    this.running.set(id, gate);
    settle(boot().catch((error: unknown) => {
      this.running.delete(id);
      throw error;
    }));
    return gate;
  }

  forget(id: string): void {
    this.running.delete(id);
  }

  has(id: string): boolean {
    return this.running.has(id);
  }
}
