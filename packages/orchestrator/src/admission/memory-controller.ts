import { EventEmitter } from 'events';
import type { OrchestratorConfig, GuestState } from '../types.js';

export interface AdmissionDecision {
  admitted: boolean;
  reason?: string;
  available_memory_mb: number;
  active_guests: number;
}

export class MemoryController extends EventEmitter {
  private activeGuests: Map<string, GuestState> = new Map();
  private config: OrchestratorConfig;
  private peakActive = 0;

  constructor(config: OrchestratorConfig) {
    super();
    this.config = config;
  }

  get usableMemoryMb(): number {
    return this.config.total_memory_budget_mb - this.config.reserved_host_memory_mb;
  }

  get usedMemoryMb(): number {
    let total = 0;
    for (const guest of this.activeGuests.values()) {
      total += guest.memory_mb;
    }
    return total;
  }

  get availableMemoryMb(): number {
    return this.usableMemoryMb - this.usedMemoryMb;
  }

  get maxGuestsByMemory(): number {
    return Math.floor(this.usableMemoryMb / this.config.memory_per_guest_mb);
  }

  get effectiveMaxConcurrent(): number {
    return Math.min(this.config.max_concurrent_guests, this.maxGuestsByMemory);
  }

  canAdmit(): AdmissionDecision {
    const activeCount = this.activeGuests.size;
    const availableMem = this.availableMemoryMb;
    const neededMem = this.config.memory_per_guest_mb;

    if (activeCount >= this.config.max_concurrent_guests) {
      return {
        admitted: false,
        reason: `Max concurrent guests reached (${activeCount}/${this.config.max_concurrent_guests})`,
        available_memory_mb: availableMem,
        active_guests: activeCount,
      };
    }

    if (availableMem < neededMem) {
      return {
        admitted: false,
        reason: `Insufficient memory: need ${neededMem}MB, have ${availableMem}MB`,
        available_memory_mb: availableMem,
        active_guests: activeCount,
      };
    }

    return {
      admitted: true,
      available_memory_mb: availableMem,
      active_guests: activeCount,
    };
  }

  reserve(guest: GuestState): boolean {
    const decision = this.canAdmit();
    if (!decision.admitted) {
      this.emit('admission:rejected', { guest, reason: decision.reason });
      return false;
    }

    this.activeGuests.set(guest.id, guest);
    this.peakActive = Math.max(this.peakActive, this.activeGuests.size);
    this.emit('guest:reserved', guest);
    this.emit('memory:updated', {
      used: this.usedMemoryMb,
      available: this.availableMemoryMb,
      active: this.activeGuests.size,
    });
    return true;
  }

  release(guestId: string): void {
    const guest = this.activeGuests.get(guestId);
    if (!guest) return;

    this.activeGuests.delete(guestId);
    this.emit('guest:released', guest);
    this.emit('memory:updated', {
      used: this.usedMemoryMb,
      available: this.availableMemoryMb,
      active: this.activeGuests.size,
    });
  }

  getActiveGuests(): GuestState[] {
    return Array.from(this.activeGuests.values());
  }

  getGuestState(guestId: string): GuestState | undefined {
    return this.activeGuests.get(guestId);
  }

  updateConfig(updates: Partial<OrchestratorConfig>): void {
    this.config = { ...this.config, ...updates };
    this.emit('config:updated', this.config);
  }

  getConfig(): OrchestratorConfig {
    return { ...this.config };
  }

  getStats() {
    return {
      active_guests: this.activeGuests.size,
      max_concurrent: this.effectiveMaxConcurrent,
      memory_used_mb: this.usedMemoryMb,
      memory_available_mb: this.availableMemoryMb,
      memory_per_guest_mb: this.config.memory_per_guest_mb,
      total_budget_mb: this.config.total_memory_budget_mb,
      reserved_host_mb: this.config.reserved_host_memory_mb,
      peak_active: this.peakActive,
    };
  }

  getPeakActive(): number {
    return this.peakActive;
  }
}

export function createDefaultConfig(overrides?: Partial<OrchestratorConfig>): OrchestratorConfig {
  return {
    max_concurrent_guests: 20,
    memory_per_guest_mb: 700,
    total_memory_budget_mb: 24 * 1024,
    reserved_host_memory_mb: 6 * 1024,
    fixtures_url: 'http://127.0.0.1:4317',
    driver: 'process',
    browser_mode: 'chromium',
    default_timeout_ms: 120_000,
    ...overrides,
  };
}
