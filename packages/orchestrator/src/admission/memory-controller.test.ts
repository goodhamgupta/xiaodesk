import { describe, expect, it } from 'vitest';
import { MemoryController, createDefaultConfig } from './memory-controller.js';
import type { GuestState } from '../types.js';

function guest(id: string, memory = 700): GuestState {
  return {
    id,
    job_id: id,
    job_name: id,
    status: 'running',
    started_at: new Date(),
    memory_mb: memory,
  };
}

describe('memory admission', () => {
  it('fits 24 Lightpanda guests in an 18GB guest budget on a 24GB Mac', () => {
    const memory = new MemoryController(createDefaultConfig({ max_concurrent_guests: 24 }));
    expect(memory.usableMemoryMb).toBe(18 * 1024);
    expect(memory.effectiveMaxConcurrent).toBe(24);
    expect(memory.maxGuestsByMemory).toBeGreaterThanOrEqual(24);
  });

  it('caps concurrency when the RAM budget is small', () => {
    const memory = new MemoryController(createDefaultConfig({
      max_concurrent_guests: 20,
      memory_per_guest_mb: 700,
      total_memory_budget_mb: 2000,
      reserved_host_memory_mb: 600,
    }));
    expect(memory.effectiveMaxConcurrent).toBe(2);

    expect(memory.reserve(guest('a'))).toBe(true);
    expect(memory.reserve(guest('b'))).toBe(true);
    const denied = memory.canAdmit();
    expect(denied.admitted).toBe(false);
    expect(memory.reserve(guest('c'))).toBe(false);
    expect(memory.getPeakActive()).toBe(2);

    memory.release('a');
    expect(memory.canAdmit().admitted).toBe(true);
    expect(memory.reserve(guest('c'))).toBe(true);
  });
});
