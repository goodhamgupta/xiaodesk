import { describe, expect, it } from 'vitest';
import { WorkQueue } from '../queue/work-queue.js';
import { MemoryController, createDefaultConfig } from '../admission/memory-controller.js';
import { FanOutRunner, type GuestDriver } from './fan-out-runner.js';
import type { AgentEvent, JobCard } from '../types.js';

class FakeDriver implements GuestDriver {
  current = 0;
  peak = 0;

  async start(): Promise<void> {
    this.current += 1;
    this.peak = Math.max(this.peak, this.current);
    await new Promise((resolve) => setTimeout(resolve, 40));
  }

  async stop(): Promise<void> {
    this.current -= 1;
  }

  async *runAgent(): AsyncGenerator<AgentEvent> {
    await new Promise((resolve) => setTimeout(resolve, 80));
    yield { type: 'done', timestamp: new Date(), data: { ok: true } };
  }
}

describe('fan-out admission', () => {
  it('keeps at most two guests in flight under a low RAM budget', async () => {
    const config = createDefaultConfig({
      max_concurrent_guests: 20,
      memory_per_guest_mb: 700,
      total_memory_budget_mb: 2000,
      reserved_host_memory_mb: 600,
      default_timeout_ms: 5_000,
    });
    const queue = new WorkQueue();
    const memory = new MemoryController(config);
    const driver = new FakeDriver();
    const runner = new FanOutRunner(queue, memory, config, driver, {
      async evaluate() {
        return [{ name: 'ok', passed: true }];
      },
    });

    for (let i = 0; i < 6; i++) {
      const card: JobCard = {
        id: `job-${i}`,
        pack: 'support',
        name: `job ${i}`,
        description: 'noop',
        goal: 'noop',
        params: {},
        eval: { type: 'composite', checks: [] },
      };
      queue.enqueue(card);
    }

    runner.start();
    await runner.waitUntilDrained();
    expect(driver.peak).toBe(2);
    expect(memory.getPeakActive()).toBe(2);
    expect(queue.getStats().passed).toBe(6);
    expect(runner.getBackpressureEvents()).toBeGreaterThan(0);
  });
});
