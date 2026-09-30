import { EventEmitter } from 'events';
import type { JobCard, JobResult, JobStatus, QueueStats } from '../types.js';

export interface QueuedJob {
  card: JobCard;
  status: JobStatus;
  result?: JobResult;
  enqueued_at: Date;
  started_at?: Date;
  finished_at?: Date;
}

export class WorkQueue extends EventEmitter {
  private jobs: Map<string, QueuedJob> = new Map();
  private pendingQueue: string[] = [];

  enqueue(card: JobCard): void {
    if (this.jobs.has(card.id)) {
      throw new Error(`Job ${card.id} already exists in queue`);
    }

    const queuedJob: QueuedJob = {
      card,
      status: 'queued',
      enqueued_at: new Date(),
    };

    this.jobs.set(card.id, queuedJob);
    this.pendingQueue.push(card.id);
    this.emit('job:enqueued', card);
  }

  enqueueBatch(cards: JobCard[]): void {
    for (const card of cards) {
      this.enqueue(card);
    }
    this.emit('batch:enqueued', cards.length);
  }

  dequeue(): QueuedJob | null {
    const jobId = this.pendingQueue.shift();
    if (!jobId) return null;

    const job = this.jobs.get(jobId);
    if (!job) return null;

    job.status = 'running';
    job.started_at = new Date();
    this.emit('job:started', job);
    return job;
  }

  peek(count: number = 10): QueuedJob[] {
    return this.pendingQueue
      .slice(0, count)
      .map(id => this.jobs.get(id)!)
      .filter(Boolean);
  }

  markComplete(jobId: string, result: JobResult): void {
    const job = this.jobs.get(jobId);
    if (!job) return;

    job.status = result.status;
    job.result = result;
    job.finished_at = new Date();
    this.emit('job:completed', job);
  }

  requeue(jobId: string): void {
    const job = this.jobs.get(jobId);
    if (!job) return;
    job.status = 'queued';
    job.started_at = undefined;
    if (!this.pendingQueue.includes(jobId)) {
      this.pendingQueue.unshift(jobId);
    }
    this.emit('job:requeued', job);
  }

  cancel(jobId: string): boolean {
    const job = this.jobs.get(jobId);
    if (!job) return false;

    if (job.status === 'queued') {
      const idx = this.pendingQueue.indexOf(jobId);
      if (idx !== -1) this.pendingQueue.splice(idx, 1);
    }

    job.status = 'cancelled';
    job.finished_at = new Date();
    this.emit('job:cancelled', job);
    return true;
  }

  getJob(jobId: string): QueuedJob | undefined {
    return this.jobs.get(jobId);
  }

  getStats(): QueueStats {
    const jobs = Array.from(this.jobs.values());
    return {
      pending: jobs.filter(j => j.status === 'queued').length,
      running: jobs.filter(j => j.status === 'running').length,
      completed: jobs.filter(j => ['passed', 'failed', 'cancelled', 'timeout'].includes(j.status)).length,
      passed: jobs.filter(j => j.status === 'passed').length,
      failed: jobs.filter(j => j.status === 'failed').length,
      cancelled: jobs.filter(j => j.status === 'cancelled').length,
      timeout: jobs.filter(j => j.status === 'timeout').length,
    };
  }

  getRecentResults(count: number = 10): JobResult[] {
    return Array.from(this.jobs.values())
      .filter(j => j.result)
      .sort((a, b) => (b.finished_at?.getTime() || 0) - (a.finished_at?.getTime() || 0))
      .slice(0, count)
      .map(j => j.result!);
  }

  getAllJobs(): QueuedJob[] {
    return Array.from(this.jobs.values());
  }

  clear(): void {
    this.jobs.clear();
    this.pendingQueue = [];
    this.emit('queue:cleared');
  }

  get size(): number {
    return this.jobs.size;
  }

  get pendingCount(): number {
    return this.pendingQueue.length;
  }
}
