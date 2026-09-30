import type { AgentEvent, JobCard } from '../../packages/orchestrator/src/types.js';

/**
 * MicroVM driver stub.
 *
 * Production shape: one microVM per user. The guest image contains
 * `codex app-server` and Lightpanda (`127.0.0.1:9222`). This fan-out lab
 * runs one guest per job instead, so a queue can pack many short workloads
 * onto one machine.
 *
 * On a Mac the same GuestDriver swaps to libkrun or Virtualization.framework.
 * This environment is Linux and does not implement a VMM. See docs/microvm.md.
 */
export class MicrovmGuestDriver {
  async start(config: { id: string; job: JobCard }): Promise<void> {
    throw new Error(
      `microvm driver is a documented swap-in, not a VMM. Job ${config.job.id} (${config.id}) ` +
      'should run under drivers/process on Linux CI, or under libkrun / Virtualization.framework on a Mac. ' +
      'Read docs/microvm.md.'
    );
  }

  async *runAgent(): AsyncGenerator<AgentEvent> {
    throw new Error('microvm guest was not started');
  }

  async stop(): Promise<void> {
    return undefined;
  }
}
