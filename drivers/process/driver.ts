import { spawn, type ChildProcess } from 'child_process';
import { createRequire } from 'module';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import type { AgentEvent, JobCard } from '../../packages/orchestrator/src/types.js';

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
export const repoRoot = join(here, '../..');

export interface ProcessDriverOptions {
  appServerMode?: 'mock' | 'real';
  browserMode?: 'chromium' | 'lightpanda';
  codexBin?: string;
}

interface GuestProc {
  child: ChildProcess;
  rpc: StdioRpc;
  stderr: string;
}

export class ProcessGuestDriver {
  private guests = new Map<string, GuestProc>();

  constructor(private options: ProcessDriverOptions = {}) {}

  async start(config: { id: string; job: JobCard; fixturesUrl: string; cdpPort: number }): Promise<void> {
    const mode = this.options.appServerMode || 'mock';
    const tsxCli = require.resolve('tsx/cli');
    const worker = join(repoRoot, 'packages/guest-agent/src/worker.ts');
    const cmd = mode === 'real' ? (this.options.codexBin || 'codex') : process.execPath;
    const args = mode === 'real'
      ? ['app-server']
      : [tsxCli, worker];

    const child = spawn(cmd, args, {
      cwd: repoRoot,
      env: {
        ...process.env,
        GUEST_JOB_JSON: JSON.stringify(config.job),
        FIXTURES_URL: config.fixturesUrl,
        CDP_PORT: String(config.cdpPort),
        BROWSER_MODE: this.options.browserMode || 'chromium',
        ALLOW_CHROMIUM_FALLBACK: process.env.ALLOW_CHROMIUM_FALLBACK || 'true',
        LIGHTPANDA_DISABLE_TELEMETRY: 'true',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const guest: GuestProc = { child, rpc: new StdioRpc(child), stderr: '' };
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: string) => {
      guest.stderr = (guest.stderr + chunk).slice(-5000);
    });
    child.on('exit', (code) => {
      guest.rpc.failAll(new Error(`guest ${config.id} exited (${code}). ${guest.stderr}`));
    });
    this.guests.set(config.id, guest);

    await guest.rpc.request('initialize', {
      clientInfo: {
        name: 'microvm-workshop',
        title: 'MicroVM Workshop',
        version: '1.0.0',
      },
    });
    guest.rpc.notify('initialized', {});
  }

  async *runAgent(id: string, job: JobCard): AsyncGenerator<AgentEvent> {
    const guest = this.guests.get(id);
    if (!guest) throw new Error(`guest ${id} is not running`);

    const started = await guest.rpc.request<{ thread: { id: string } }>('thread/start', {
      cwd: repoRoot,
      ephemeral: true,
    });
    const threadId = started.thread?.id;
    if (!threadId) throw new Error(`thread/start returned no thread id: ${JSON.stringify(started)}`);

    const queue: AgentEvent[] = [];
    let wake: (() => void) | null = null;
    let done = false;
    const off = guest.rpc.onNotification((message) => {
      if (message.method === 'turn/completed') {
        const status = (message.params as { turn?: { status?: string; error?: { message?: string } } } | undefined)?.turn?.status;
        const error = (message.params as { turn?: { error?: { message?: string } } } | undefined)?.turn?.error?.message;
        queue.push({
          type: status === 'failed' ? 'error' : 'done',
          timestamp: new Date(),
          data: error ? { error, params: message.params } : message.params,
        });
        done = true;
      } else {
        queue.push({ type: 'message', timestamp: new Date(), data: message });
      }
      wake?.();
      wake = null;
    });

    const turnPromise = guest.rpc.request('turn/start', {
      threadId,
      input: [{ type: 'text', text: job.goal }],
    });
    turnPromise.catch((error: unknown) => {
      queue.push({ type: 'error', timestamp: new Date(), data: { error: error instanceof Error ? error.message : String(error) } });
      done = true;
      wake?.();
    });

    try {
      while (!done || queue.length > 0) {
        if (queue.length === 0) {
          await new Promise<void>((resolve) => {
            wake = resolve;
          });
        }
        while (queue.length > 0) {
          const event = queue.shift();
          if (event) yield event;
        }
      }
      await turnPromise.catch(() => undefined);
    } finally {
      off();
    }
  }

  async stop(id: string): Promise<void> {
    const guest = this.guests.get(id);
    if (!guest) return;
    this.guests.delete(id);
    if (guest.child.exitCode === null && !guest.child.killed) {
      guest.child.kill('SIGTERM');
      setTimeout(() => {
        if (guest.child.exitCode === null) guest.child.kill('SIGKILL');
      }, 1_000).unref();
    }
  }
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
}

class StdioRpc {
  private buffer = '';
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private listeners = new Set<(message: { method: string; params?: unknown }) => void>();
  private child: ChildProcess;

  constructor(child: ChildProcess) {
    this.child = child;
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => this.onData(chunk));
  }

  request<T = unknown>(method: string, params: unknown): Promise<T> {
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, {
        resolve: (value) => resolve(value as T),
        reject,
      });
      this.send({ id, method, params });
    });
  }

  notify(method: string, params: unknown): void {
    this.send({ method, params });
  }

  onNotification(listener: (message: { method: string; params?: unknown }) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  failAll(error: Error): void {
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }

  private send(message: unknown): void {
    this.child.stdin?.write(`${JSON.stringify(message)}\n`);
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    let newline = this.buffer.indexOf('\n');
    while (newline >= 0) {
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      newline = this.buffer.indexOf('\n');
      if (!line) continue;
      let message: { id?: number; method?: string; params?: unknown; result?: unknown; error?: { message?: string } };
      try {
        message = JSON.parse(line);
      } catch {
        continue;
      }
      if (message.id !== undefined && (message.result !== undefined || message.error)) {
        const pending = this.pending.get(message.id);
        this.pending.delete(message.id);
        if (!pending) continue;
        if (message.error) pending.reject(new Error(message.error.message || 'rpc error'));
        else pending.resolve(message.result);
      } else if (message.method) {
        for (const listener of this.listeners) listener({ method: message.method, params: message.params });
      }
    }
  }
}
