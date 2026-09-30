/**
 * Grace-period shutdown. An idle event is not itself a stop.
 * Call schedule only when the application opted into a grace period.
 * Cancel when a connection is requested or a turn starts.
 */
export class ShutdownCoordinator {
  private timers = new Map<string, ReturnType<typeof setTimeout>>();

  schedule(id: string, delayMs: number, stop: () => void): void {
    this.cancel(id);
    if (delayMs <= 0) return;
    const timer = setTimeout(() => {
      this.timers.delete(id);
      stop();
    }, delayMs);
    this.timers.set(id, timer);
  }

  cancel(id: string): boolean {
    const timer = this.timers.get(id);
    if (!timer) return false;
    clearTimeout(timer);
    this.timers.delete(id);
    return true;
  }

  get pendingCount(): number {
    return this.timers.size;
  }
}
