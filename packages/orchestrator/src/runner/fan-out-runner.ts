import { EventEmitter } from 'events';
import { v4 as uuid } from 'uuid';
import type {
  JobCard,
  JobResult,
  GuestState,
  OrchestratorConfig,
  EvalCheckResult,
  AgentEvent,
} from '../types.js';
import { WorkQueue, type QueuedJob } from '../queue/work-queue.js';
import { MemoryController } from '../admission/memory-controller.js';

export interface GuestDriver {
  start(config: { id: string; job: JobCard; fixturesUrl: string; cdpPort: number }): Promise<void>;
  stop(id: string): Promise<void>;
  runAgent(id: string, job: JobCard): AsyncGenerator<AgentEvent>;
}

export interface EvalRunner {
  evaluate(job: JobCard, fixturesUrl: string): Promise<EvalCheckResult[]>;
}

export class FanOutRunner extends EventEmitter {
  private queue: WorkQueue;
  private memory: MemoryController;
  private config: OrchestratorConfig;
  private driver: GuestDriver;
  private evalRunner: EvalRunner;
  private running = false;
  private activeJobs: Map<string, { job: QueuedJob; guest: GuestState; abortController: AbortController }> = new Map();
  private nextCdpPort = 9300;
  private backpressureEvents = 0;

  constructor(
    queue: WorkQueue,
    memory: MemoryController,
    config: OrchestratorConfig,
    driver: GuestDriver,
    evalRunner: EvalRunner
  ) {
    super();
    this.queue = queue;
    this.memory = memory;
    this.config = config;
    this.driver = driver;
    this.evalRunner = evalRunner;

    this.memory.on('guest:released', () => this.pump());
    this.queue.on('job:enqueued', () => this.pump());
    this.queue.on('batch:enqueued', () => this.pump());
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.emit('runner:started');
    this.pump();
  }

  stop(): void {
    this.running = false;
    this.emit('runner:stopped');
  }

  getBackpressureEvents(): number {
    return this.backpressureEvents;
  }

  getActiveCount(): number {
    return this.activeJobs.size;
  }

  async waitUntilDrained(timeoutMs = 15 * 60_000): Promise<void> {
    const started = Date.now();
    while (this.queue.pendingCount > 0 || this.activeJobs.size > 0) {
      if (Date.now() - started > timeoutMs) {
        throw new Error(`timed out waiting for queue drain (pending=${this.queue.pendingCount}, active=${this.activeJobs.size})`);
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }

  private pump(): void {
    if (!this.running) return;

    while (true) {
      const decision = this.memory.canAdmit();
      if (!decision.admitted) {
        if (this.queue.pendingCount > 0) {
          this.backpressureEvents += 1;
          this.emit('backpressure', decision);
        }
        return;
      }

      const queuedJob = this.queue.dequeue();
      if (!queuedJob) return;

      const { guest, cdpPort } = this.buildGuest(queuedJob);
      if (!this.memory.reserve(guest)) {
        this.queue.requeue(queuedJob.card.id);
        this.backpressureEvents += 1;
        this.emit('backpressure', this.memory.canAdmit());
        return;
      }

      void this.execute(queuedJob, guest, cdpPort);
    }
  }

  private buildGuest(queuedJob: QueuedJob): { guest: GuestState; cdpPort: number } {
    const cdpPort = this.nextCdpPort++;
    if (this.nextCdpPort > 9500) this.nextCdpPort = 9300;
    return {
      cdpPort,
      guest: {
        id: `guest-${uuid().slice(0, 8)}`,
        job_id: queuedJob.card.id,
        job_name: queuedJob.card.name,
        status: 'starting',
        started_at: new Date(),
        memory_mb: this.config.memory_per_guest_mb,
      },
    };
  }

  private async execute(queuedJob: QueuedJob, guest: GuestState, cdpPort: number): Promise<void> {
    const abortController = new AbortController();
    this.activeJobs.set(queuedJob.card.id, { job: queuedJob, guest, abortController });
    this.emit('job:starting', { job: queuedJob.card, guest });

    const result: JobResult = {
      job_id: queuedJob.card.id,
      status: 'running',
      started_at: new Date(),
      guest_id: guest.id,
      logs: [],
    };

    const timeout = queuedJob.card.timeout_ms || this.config.default_timeout_ms;
    const timeoutId = setTimeout(() => {
      abortController.abort();
      void this.driver.stop(guest.id);
    }, timeout);

    try {
      await this.driver.start({
        id: guest.id,
        job: queuedJob.card,
        fixturesUrl: this.config.fixtures_url,
        cdpPort,
      });

      guest.status = 'running';
      this.emit('guest:running', guest);

      for await (const event of this.driver.runAgent(guest.id, queuedJob.card)) {
        if (abortController.signal.aborted) break;
        this.emit('agent:event', { job_id: queuedJob.card.id, event });
        result.logs?.push(`[${event.type}] ${JSON.stringify(event.data)}`);
        if (event.type === 'error') {
          result.error = typeof event.data === 'object' && event.data && 'error' in (event.data as Record<string, unknown>)
            ? String((event.data as Record<string, unknown>).error)
            : 'agent error';
        }
      }

      if (abortController.signal.aborted) {
        result.status = 'timeout';
        result.error = result.error || 'Job timed out';
      }

      try {
        result.eval_results = await this.evalRunner.evaluate(queuedJob.card, this.config.fixtures_url);
      } catch (error) {
        result.eval_results = [{
          name: 'eval_runner',
          passed: false,
          error: error instanceof Error ? error.message : String(error),
        }];
      }

      if (result.status !== 'timeout') {
        const evalsPass = (result.eval_results ?? []).every((check) => check.passed) && (result.eval_results?.length ?? 0) > 0;
        result.status = evalsPass ? 'passed' : 'failed';
        if (!evalsPass && !result.error) {
          result.error = 'one or more eval checks failed';
        }
      }
    } catch (error) {
      result.error = error instanceof Error ? error.message : String(error);
      result.status = abortController.signal.aborted ? 'timeout' : 'failed';
      this.emit('job:error', { job: queuedJob.card, error });
      if (!result.eval_results) {
        try {
          result.eval_results = await this.evalRunner.evaluate(queuedJob.card, this.config.fixtures_url);
        } catch {
          result.eval_results = [];
        }
      }
    } finally {
      clearTimeout(timeoutId);
      result.finished_at = new Date();
      result.duration_ms = result.finished_at.getTime() - (result.started_at?.getTime() ?? result.finished_at.getTime());
      guest.status = 'stopping';
      this.emit('guest:stopping', guest);
      try {
        await this.driver.stop(guest.id);
      } catch (error) {
        this.emit('driver:error', { guest_id: guest.id, error });
      }
      this.memory.release(guest.id);
      this.activeJobs.delete(queuedJob.card.id);
      this.queue.markComplete(queuedJob.card.id, result);
      this.emit('job:completed', { job: queuedJob.card, result });
    }
  }

  cancelJob(jobId: string): boolean {
    const active = this.activeJobs.get(jobId);
    if (active) {
      active.abortController.abort();
      void this.driver.stop(active.guest.id);
      return true;
    }
    return this.queue.cancel(jobId);
  }

  getActiveJobs(): Array<{ job: JobCard; guest: GuestState }> {
    return Array.from(this.activeJobs.values()).map(({ job, guest }) => ({
      job: job.card,
      guest,
    }));
  }

  isRunning(): boolean {
    return this.running;
  }
}
