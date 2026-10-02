import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import type { AgentEvent, JobCard } from '../../packages/orchestrator/src/types.js';
import { AgentsApiServer } from '../../packages/agents-api/src/server.js';
import { handleEnvironmentEvent } from '../../packages/agents-api/src/worker.js';
import { ShutdownCoordinator } from '../../packages/agents-api/src/shutdown.js';
import { NekoBackend, type NekoHooks } from './neko.js';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../..');

export interface DockerDriverOptions {
  memoryMb?: number;
  agentsPort?: number;
  publicHost?: string;
  connectionWaitMs?: number;
  graceMs?: number;
  browserMode?: 'chromium' | 'lightpanda';
  onDisplay?: NekoHooks['onDisplay'];
  onDisplayEnd?: NekoHooks['onDisplayEnd'];
}

interface GuestRecord {
  sessionId: string;
  environmentId: string;
}

interface SessionBody {
  id: string;
  environment: { id: string; remote_url: string };
}

/**
 * One self-hosted Agents API environment per job, backed by a neko container.
 * `POST /v1/agents/sessions` does not start Docker. The webhook worker starts
 * the container and `codex exec-server` only for `environment_connection`.
 * `DELETE /v1/agents/sessions/:id` does not remove the container. `stop` does
 * that as a second step.
 */
export class DockerGuestDriver {
  private server: AgentsApiServer | null = null;
  private backend: NekoBackend | null = null;
  private records = new Map<string, GuestRecord>();
  private shutdown = new ShutdownCoordinator();
  private starting: Promise<void> | null = null;

  constructor(private options: DockerDriverOptions = {}) {}

  private async ready(): Promise<{ server: AgentsApiServer; backend: NekoBackend }> {
    if (this.server && this.backend) return { server: this.server, backend: this.backend };
    if (!this.starting) this.starting = this.bootControlPlane();
    await this.starting;
    return { server: this.server!, backend: this.backend! };
  }

  private async bootControlPlane(): Promise<void> {
    const publicHost = this.options.publicHost || '127.0.0.1';
    const backend = new NekoBackend(repoRoot, {
      onDisplay: (info) => this.options.onDisplay?.(info),
      onDisplayEnd: (guestId) => this.options.onDisplayEnd?.(guestId),
    });
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
    console.log(`agents api on :${server.port} remote_url=${server.remoteUrl()} backend=neko`);
  }

  async start(config: { id: string; job: JobCard; fixturesUrl: string; cdpPort: number }): Promise<void> {
    const { server } = await this.ready();
    const created = await this.api<SessionBody>(server, 'POST', '/v1/agents/sessions', {
      agent: {
        model: 'lab-stub',
        instructions: 'Run the scripted browser-use job inside this neko environment.',
      },
      environment: { type: 'self_hosted', workspace_directory: '/workspace' },
      metadata: {
        job: config.job,
        fixtures_url: config.fixturesUrl,
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
    console.log(`delete session ${record.sessionId} (does not stop the neko container)`);
    const deleted = await fetch(`http://127.0.0.1:${this.server.port}/v1/agents/sessions/${record.sessionId}`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${this.server.appKey}` },
    });
    if (!deleted.ok && deleted.status !== 404) {
      console.error(`session delete returned HTTP ${deleted.status}`);
    }
    console.log(`stop neko ${record.environmentId}`);
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
      if (event.type === 'agent.session.failed' || event.type === 'agent.session.turn.completed' || event.type === 'agent.session.turn.failed') {
        return;
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
