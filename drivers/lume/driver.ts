import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import type { AgentEvent, JobCard } from '../../packages/orchestrator/src/types.js';
import { AgentsApiServer } from '../../packages/agents-api/src/server.js';
import { handleEnvironmentEvent } from '../../packages/agents-api/src/worker.js';
import { ShutdownCoordinator } from '../../packages/agents-api/src/shutdown.js';
import {
  guestFixturesUrl,
  KvmBackend,
  LumeBackend,
  selectBackendKind,
  type ComputeBackend,
  type DisplayHooks,
} from './compute.js';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../..');

export interface LumeDriverOptions {
  backend?: 'auto' | 'kvm' | 'lume';
  memoryMb?: number;
  agentsPort?: number;
  publicHost?: string;
  connectionWaitMs?: number;
  graceMs?: number;
  browserMode?: 'chromium' | 'lightpanda';
  onDisplay?: DisplayHooks['onDisplay'];
  onDisplayEnd?: DisplayHooks['onDisplayEnd'];
}

interface GuestRecord {
  sessionId: string;
  environmentId: string;
}

/**
 * One self-hosted Agents API environment per job.
 * Darwin uses `lume` (Virtualization.framework). Linux with /dev/kvm uses QEMU.
 * The executor inside the guest is `codex exec-server --remote --environment-id`.
 */
export class LumeGuestDriver {
  private server: AgentsApiServer | null = null;
  private backend: ComputeBackend | null = null;
  private records = new Map<string, GuestRecord>();
  private shutdown = new ShutdownCoordinator();
  private starting: Promise<void> | null = null;

  constructor(private options: LumeDriverOptions = {}) {}

  private async ready(): Promise<{ server: AgentsApiServer; backend: ComputeBackend }> {
    if (this.server && this.backend) return { server: this.server, backend: this.backend };
    if (!this.starting) this.starting = this.bootControlPlane();
    await this.starting;
    return { server: this.server!, backend: this.backend! };
  }

  private async bootControlPlane(): Promise<void> {
    const kind = this.options.backend && this.options.backend !== 'auto'
      ? this.options.backend
      : selectBackendKind();
    const publicHost = this.options.publicHost
      || (kind === 'kvm' ? '10.0.2.2' : (process.env.LUME_HOST_IP || '192.168.64.1'));
    const hooks: DisplayHooks = {
      onDisplay: (info) => this.options.onDisplay?.(info),
      onDisplayEnd: (guestId) => this.options.onDisplayEnd?.(guestId),
    };
    const backend: ComputeBackend = kind === 'kvm'
      ? new KvmBackend(repoRoot, this.options.memoryMb ?? 1536, publicHost, hooks)
      : new LumeBackend(publicHost, hooks);
    const server = new AgentsApiServer({
      port: this.options.agentsPort ?? Number(process.env.AGENTS_PORT || 4319),
      host: '0.0.0.0',
      publicHost,
      connectionWaitMs: this.options.connectionWaitMs ?? 300_000,
    });
    server.onQueued = (event) => handleEnvironmentEvent(event, {
      retrieve: (id) => server.getSession(id),
      ensure: async (session) => {
        try {
          await backend.ensure(session, server.executorKey);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          server.failConnection(session.id, message);
          throw error;
        }
      },
      stop: (environmentId) => backend.stop(environmentId),
    });
    await server.listen();
    this.server = server;
    this.backend = backend;
    console.log(`agents api on :${server.port} remote_url=${server.remoteUrl()} backend=${backend.name}`);
  }

  async start(config: { id: string; job: JobCard; fixturesUrl: string; cdpPort: number }): Promise<void> {
    const { server, backend } = await this.ready();
    const fixturesUrl = guestFixturesUrl(config.fixturesUrl, backend.guestHost);
    const created = await this.api<SessionBody>(server, 'POST', '/v1/agents/sessions', {
      agent: {
        model: 'lab-stub',
        instructions: 'Run the scripted browser-use job inside this self-hosted environment.',
      },
      environment: { type: 'self_hosted', workspace_directory: '/workspace' },
      metadata: {
        job: config.job,
        fixtures_url: fixturesUrl,
        browser_mode: this.options.browserMode || 'chromium',
        guest_id: config.id,
        cdp_port: config.cdpPort,
      },
    });
    this.records.set(config.id, { sessionId: created.id, environmentId: created.environment.id });
    const graceMs = this.options.graceMs ?? Number(process.env.ENVIRONMENT_GRACE_MS || 0);
    if (graceMs > 0) void this.watchGrace(server, created.id, created.environment.id, graceMs);

    await this.api(server, 'POST', `/v1/agents/sessions/${created.id}/input`, {
      input: [{
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: config.job.goal }],
      }],
    });

    const deadline = Date.now() + (this.options.connectionWaitMs ?? 300_000);
    for await (const event of server.stream(created.id)) {
      if (event.type === 'agent.session.environment.connected') return;
      if (event.type === 'agent.session.failed' || event.type === 'agent.session.environment.failed') {
        const message = JSON.stringify(event.data.error || event.data);
        throw new Error(`environment failed before the executor connected: ${message}`);
      }
      if (Date.now() > deadline) throw new Error('timed out waiting for codex exec-server to connect');
    }
    throw new Error('session stream ended before the executor connected');
  }

  async *runAgent(id: string, _job: JobCard): AsyncGenerator<AgentEvent> {
    const record = this.records.get(id);
    const server = this.server;
    if (!record || !server) throw new Error(`guest ${id} is not running`);
    for await (const event of server.stream(record.sessionId)) {
      if (event.type === 'agent.session.in_progress') {
        yield { type: 'thinking', timestamp: new Date(), data: event.data };
      } else if (event.type === 'agent.session.item.completed') {
        yield { type: 'tool_result', timestamp: new Date(), data: event.data };
      } else if (event.type === 'agent.session.turn.completed') {
        yield { type: 'done', timestamp: new Date(), data: event.data };
        return;
      } else if (event.type === 'agent.session.turn.failed' || event.type === 'agent.session.failed') {
        yield { type: 'error', timestamp: new Date(), data: event.data };
        return;
      }
    }
  }

  async stop(id: string): Promise<void> {
    const record = this.records.get(id);
    if (!record || !this.server || !this.backend) return;
    this.records.delete(id);
    this.shutdown.cancel(record.environmentId);
    console.log(`delete session ${record.sessionId} (does not stop compute)`);
    const deleted = await fetch(`http://127.0.0.1:${this.server.port}/v1/agents/sessions/${record.sessionId}`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${this.server.appKey}` },
    });
    if (!deleted.ok && deleted.status !== 404) {
      console.error(`session delete returned HTTP ${deleted.status}`);
    }
    console.log(`stop compute ${record.environmentId}`);
    await this.backend.stop(record.environmentId);
  }

  private async watchGrace(server: AgentsApiServer, sessionId: string, environmentId: string, graceMs: number): Promise<void> {
    for await (const event of server.stream(sessionId)) {
      if (event.type === 'agent.session.requires_action' || event.type === 'agent.session.in_progress') {
        this.shutdown.cancel(environmentId);
      }
      if (event.type === 'agent.session.idle') {
        this.shutdown.schedule(environmentId, graceMs, () => {
          void this.backend?.stop(environmentId);
        });
      }
    }
  }

  private async api<T = unknown>(server: AgentsApiServer, method: string, path: string, body?: unknown): Promise<T> {
    const response = await fetch(`http://127.0.0.1:${server.port}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${server.appKey}`,
        'content-type': 'application/json',
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    const parsed = text ? JSON.parse(text) as T & { error?: { message?: string } } : {} as T;
    if (!response.ok) {
      throw new Error(`${method} ${path} failed: HTTP ${response.status} ${text}`);
    }
    return parsed;
  }
}

interface SessionBody {
  id: string;
  environment: { id: string; remote_url: string };
}
