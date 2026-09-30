import { createServer, type IncomingMessage, type ServerResponse } from 'http';
import { randomBytes } from 'crypto';
import { WebSocketServer, type WebSocket } from 'ws';
import {
  LAB_APP_KEY,
  LAB_EXECUTOR_KEY,
  LAB_WEBHOOK_SECRET,
  queueDecision,
  type AgentSession,
  type ApiEvent,
  type RequiredActionType,
} from './types.js';
import { signWebhook, verifyWebhook } from './webhook.js';

export interface AgentsApiOptions {
  port?: number;
  host?: string;
  publicHost: string;
  appKey?: string;
  executorKey?: string;
  webhookSecret?: string;
  connectionWaitMs?: number;
  webhookUrl?: string;
}

interface LiveSocket {
  ws: WebSocket;
  environmentId: string;
}

function id(prefix: string): string {
  return `${prefix}_${randomBytes(8).toString('hex')}`;
}

function bearer(req: IncomingMessage): string | undefined {
  const header = req.headers.authorization || '';
  const match = /^Bearer\s+(.+)$/i.exec(Array.isArray(header) ? header[0] : header);
  return match?.[1];
}

export class AgentsApiServer {
  readonly options: Required<Omit<AgentsApiOptions, 'webhookUrl'>> & { webhookUrl?: string };
  private http = createServer((req, res) => {
    void this.route(req, res);
  });
  private wss = new WebSocketServer({ noServer: true });
  private sessions = new Map<string, AgentSession>();
  private byEnvironment = new Map<string, string>();
  private buffers = new Map<string, ApiEvent[]>();
  private waiters = new Map<string, Array<() => void>>();
  private sockets = new Map<string, LiveSocket>();
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  private queue: ApiEvent[] = [];
  private draining = false;
  onQueued: ((event: ApiEvent) => Promise<unknown>) | null = null;
  port = 0;

  constructor(options: AgentsApiOptions) {
    this.options = {
      port: options.port ?? 0,
      host: options.host ?? '0.0.0.0',
      publicHost: options.publicHost,
      appKey: options.appKey || process.env.OPENAI_API_KEY || LAB_APP_KEY,
      executorKey: options.executorKey || process.env.OPENAI_EXECUTOR_API_KEY || LAB_EXECUTOR_KEY,
      webhookSecret: options.webhookSecret || process.env.OPENAI_WEBHOOK_SECRET || LAB_WEBHOOK_SECRET,
      connectionWaitMs: options.connectionWaitMs ?? 300_000,
      webhookUrl: options.webhookUrl,
    };
    this.http.on('upgrade', (req, socket, head) => {
      const url = new URL(req.url || '/', 'http://127.0.0.1');
      if (url.pathname !== '/v1/agents/api') {
        socket.destroy();
        return;
      }
      if (bearer(req) !== this.options.executorKey) {
        socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
        socket.destroy();
        return;
      }
      this.wss.handleUpgrade(req, socket, head, (ws) => {
        this.onExecutor(ws);
      });
    });
  }

  get executorKey(): string {
    return this.options.executorKey;
  }

  get appKey(): string {
    return this.options.appKey;
  }

  get webhookSecret(): string {
    return this.options.webhookSecret;
  }

  async listen(): Promise<void> {
    await new Promise<void>((resolve) => {
      this.http.listen(this.options.port, this.options.host, () => resolve());
    });
    const address = this.http.address();
    this.port = typeof address === 'object' && address ? address.port : this.options.port;
  }

  async close(): Promise<void> {
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    for (const live of this.sockets.values()) live.ws.close();
    this.sockets.clear();
    await new Promise<void>((resolve) => this.wss.close(() => resolve()));
    await new Promise<void>((resolve) => this.http.close(() => resolve()));
  }

  remoteUrl(): string {
    return `ws://${this.options.publicHost}:${this.port}/v1/agents/api`;
  }

  getSession(sessionId: string): AgentSession | undefined {
    return this.sessions.get(sessionId);
  }

  async *stream(sessionId: string): AsyncGenerator<ApiEvent> {
    let index = 0;
    try {
      while (true) {
        const buffered = this.buffers.get(sessionId) ?? [];
        if (index < buffered.length) {
          yield buffered[index++];
          continue;
        }
        const session = this.sessions.get(sessionId);
        if (!session || session.deleted) return;
        await new Promise<void>((resolve) => {
          const list = this.waiters.get(sessionId) ?? [];
          list.push(resolve);
          this.waiters.set(sessionId, list);
        });
      }
    } finally {
      /* waiter resolves on the next event; a returned generator just stops pulling */
    }
  }

  failConnection(sessionId: string, message: string): void {
    const session = this.sessions.get(sessionId);
    if (!session || session.deleted || session.status === 'failed') return;
    this.clearTimer(sessionId);
    session.environment.status = 'failed';
    session.required_actions = [];
    session.pending_input = null;
    this.push(session, 'agent.session.environment.failed', { id: session.id, error: { message } }, false);
    session.status = 'failed';
    session.error = { message };
    this.push(session, 'agent.session.failed', { id: session.id, error: { message } }, true);
  }

  private push(session: AgentSession, type: string, data: Record<string, unknown>, webhook: boolean): ApiEvent {
    const event: ApiEvent = {
      id: id('evt'),
      object: 'event',
      created_at: Math.floor(Date.now() / 1000),
      type,
      data,
    };
    const buffered = this.buffers.get(session.id) ?? [];
    buffered.push(event);
    this.buffers.set(session.id, buffered);
    this.wake(session.id);
    if (webhook) void this.deliverWebhook(event);
    return event;
  }

  private wake(sessionId: string): void {
    const list = this.waiters.get(sessionId) ?? [];
    this.waiters.set(sessionId, []);
    for (const resolve of list) resolve();
  }

  private async deliverWebhook(event: ApiEvent): Promise<void> {
    const url = this.options.webhookUrl || `http://127.0.0.1:${this.port}/webhooks/openai`;
    const body = JSON.stringify(event);
    const timestamp = String(event.created_at);
    try {
      await fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'webhook-id': event.id,
          'webhook-timestamp': timestamp,
          'webhook-signature': signWebhook(this.options.webhookSecret, event.id, timestamp, body),
        },
        body,
      });
    } catch (error) {
      console.error(`webhook delivery failed: ${error instanceof Error ? error.message : error}`);
    }
  }

  private clearTimer(sessionId: string): void {
    const timer = this.timers.get(sessionId);
    if (!timer) return;
    clearTimeout(timer);
    this.timers.delete(sessionId);
  }

  private armConnectionWait(session: AgentSession): void {
    this.clearTimer(session.id);
    const timer = setTimeout(() => {
      this.timers.delete(session.id);
      const current = this.sessions.get(session.id);
      if (!current || current.deleted || current.environment.status === 'connected' || current.status === 'failed') return;
      if (!current.required_actions.some((action) => action.type === 'environment_connection')) return;
      this.failConnection(session.id, 'environment connection timed out after 5 minutes');
    }, this.options.connectionWaitMs);
    this.timers.set(session.id, timer);
  }

  private startTurn(session: AgentSession): void {
    const live = this.sockets.get(session.environment.id);
    if (!live || session.pending_input == null || session.status === 'in_progress' || session.status === 'failed') return;
    session.required_actions = session.required_actions.filter((action) => action.type !== 'environment_connection');
    session.status = 'in_progress';
    const input = session.pending_input;
    this.push(session, 'agent.session.in_progress', { id: session.id }, true);
    const commandId = id('cmd');
    live.ws.send(JSON.stringify({
      type: 'command',
      id: commandId,
      name: 'run_job',
      input,
      job: session.metadata.job ?? null,
      fixtures_url: session.metadata.fixtures_url ?? null,
      browser_mode: session.metadata.browser_mode ?? 'chromium',
    }));
  }

  private onExecutor(ws: WebSocket): void {
    let environmentId = '';
    ws.on('message', (raw) => {
      let message: Record<string, unknown>;
      try {
        message = JSON.parse(String(raw)) as Record<string, unknown>;
      } catch {
        ws.send(JSON.stringify({ type: 'error', message: 'invalid json' }));
        return;
      }
      if (message.type === 'register') {
        environmentId = String(message.environment_id || '');
        const sessionId = this.byEnvironment.get(environmentId);
        const session = sessionId ? this.sessions.get(sessionId) : undefined;
        if (!session || session.deleted) {
          ws.send(JSON.stringify({ type: 'error', message: `unknown environment ${environmentId}` }));
          ws.close();
          return;
        }
        const previous = this.sockets.get(environmentId);
        if (previous && previous.ws !== ws) previous.ws.close();
        this.sockets.set(environmentId, { ws, environmentId });
        session.environment.status = 'connected';
        this.clearTimer(session.id);
        this.push(session, 'agent.session.environment.connected', {
          id: session.id,
          environment_id: environmentId,
        }, false);
        session.required_actions = session.required_actions.filter((action) => action.type !== 'environment_connection');
        ws.send(JSON.stringify({ type: 'registered', environment_id: environmentId }));
        if (session.pending_input != null && session.status !== 'in_progress' && session.status !== 'failed') {
          this.startTurn(session);
        }
        return;
      }
      if (message.type === 'event') {
        const sessionId = this.byEnvironment.get(environmentId);
        const session = sessionId ? this.sessions.get(sessionId) : undefined;
        if (!session) return;
        this.push(session, 'agent.session.item.completed', {
          id: session.id,
          command_id: message.command_id,
          name: message.name,
          data: message.data,
        }, false);
        return;
      }
      if (message.type === 'command_result') {
        const sessionId = this.byEnvironment.get(environmentId);
        const session = sessionId ? this.sessions.get(sessionId) : undefined;
        if (!session || session.status !== 'in_progress') return;
        session.pending_input = null;
        const ok = message.ok !== false;
        if (ok) {
          this.push(session, 'agent.session.turn.completed', {
            id: session.id,
            command_id: message.id,
            output: message.output ?? '',
          }, false);
        } else {
          this.push(session, 'agent.session.turn.failed', {
            id: session.id,
            command_id: message.id,
            error: { message: String(message.error || 'turn failed') },
          }, false);
        }
        session.status = 'idle';
        this.push(session, 'agent.session.idle', { id: session.id }, true);
      }
    });
    ws.on('close', () => {
      if (!environmentId) return;
      const live = this.sockets.get(environmentId);
      if (!live || live.ws !== ws) return;
      this.sockets.delete(environmentId);
      const sessionId = this.byEnvironment.get(environmentId);
      const session = sessionId ? this.sessions.get(sessionId) : undefined;
      if (!session || session.deleted) return;
      session.environment.status = 'disconnected';
      this.push(session, 'agent.session.environment.disconnected', {
        id: session.id,
        environment_id: environmentId,
      }, false);
      if (session.status === 'in_progress') {
        session.pending_input = null;
        this.push(session, 'agent.session.turn.failed', {
          id: session.id,
          error: { message: 'executor disconnected mid-turn' },
        }, false);
        session.status = 'idle';
        this.push(session, 'agent.session.idle', { id: session.id }, true);
      }
    });
  }

  private async route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url || '/', 'http://127.0.0.1');
    try {
      if (req.method === 'POST' && url.pathname === '/webhooks/openai') {
        await this.webhook(req, res);
        return;
      }
      if (req.method === 'GET' && url.pathname === '/health') {
        this.send(res, 200, { ok: true });
        return;
      }
      const token = bearer(req);
      if (token === this.options.executorKey && token !== this.options.appKey) {
        this.send(res, 403, { error: { message: 'executor key cannot call session routes' } });
        return;
      }
      if (token !== this.options.appKey) {
        this.send(res, 401, { error: { message: 'invalid application API key' } });
        return;
      }
      if (req.method === 'POST' && url.pathname === '/v1/agents/sessions') {
        const body = await this.readJson(req);
        this.createSession(res, body);
        return;
      }
      const sessionMatch = url.pathname.match(/^\/v1\/agents\/sessions\/([^/]+)(\/.*)?$/);
      if (sessionMatch) {
        const sessionId = decodeURIComponent(sessionMatch[1]);
        const rest = sessionMatch[2] || '';
        if (req.method === 'GET' && rest === '') {
          this.retrieve(res, sessionId);
          return;
        }
        if (req.method === 'DELETE' && rest === '') {
          this.deleteSession(res, sessionId);
          return;
        }
        if (req.method === 'POST' && rest === '/input') {
          const body = await this.readJson(req);
          this.postInput(res, sessionId, body);
          return;
        }
        if (req.method === 'GET' && rest === '/events') {
          this.sse(req, res, sessionId);
          return;
        }
      }
      const envMatch = url.pathname.match(/^\/v1\/agents\/environments\/([^/]+)$/);
      if (req.method === 'GET' && envMatch) {
        const environmentId = decodeURIComponent(envMatch[1]);
        const sessionId = this.byEnvironment.get(environmentId);
        const session = sessionId ? this.sessions.get(sessionId) : undefined;
        if (!session || session.deleted) {
          this.send(res, 404, { error: { message: 'environment not found' } });
          return;
        }
        this.send(res, 200, session.environment);
        return;
      }
      this.send(res, 404, { error: { message: `no route ${req.method} ${url.pathname}` } });
    } catch (error) {
      this.send(res, 400, { error: { message: error instanceof Error ? error.message : String(error) } });
    }
  }

  private createSession(res: ServerResponse, body: Record<string, unknown>): void {
    const environment = body.environment as { type?: string; workspace_directory?: string } | undefined;
    const agent = body.agent as { model?: string; instructions?: string } | undefined;
    if (!agent?.model) throw new Error('agent.model is required');
    if (environment?.type !== 'self_hosted') throw new Error('environment.type must be self_hosted');
    const workspace = environment.workspace_directory || '/workspace';
    const session: AgentSession = {
      id: id('sess'),
      object: 'agent.session',
      status: 'idle',
      created_at: Math.floor(Date.now() / 1000),
      deleted: false,
      agent: { model: agent.model, instructions: agent.instructions },
      environment: {
        id: id('ccarenv'),
        object: 'agent.environment',
        type: 'self_hosted',
        status: 'pending',
        remote_url: '',
        workspace_directory: workspace,
      },
      required_actions: [],
      metadata: (body.metadata as Record<string, unknown>) || {},
      pending_input: null,
    };
    session.environment.remote_url = this.remoteUrl();
    this.sessions.set(session.id, session);
    this.byEnvironment.set(session.environment.id, session.id);
    this.buffers.set(session.id, []);
    this.push(session, 'agent.session.created', {
      id: session.id,
      environment_id: session.environment.id,
      environment_type: 'self_hosted',
      connect: { remote_url: session.environment.remote_url },
    }, true);
    this.push(session, 'agent.session.environment.pending', {
      id: session.id,
      environment_id: session.environment.id,
    }, false);
    this.send(res, 200, this.publicSession(session));
  }

  private retrieve(res: ServerResponse, sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session || session.deleted) {
      this.send(res, 404, { error: { message: 'session not found' } });
      return;
    }
    this.send(res, 200, this.publicSession(session));
  }

  private deleteSession(res: ServerResponse, sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session || session.deleted) {
      this.send(res, 404, { error: { message: 'session not found' } });
      return;
    }
    session.deleted = true;
    this.clearTimer(sessionId);
    this.wake(sessionId);
    this.send(res, 200, { id: session.id, deleted: true });
  }

  private postInput(res: ServerResponse, sessionId: string, body: Record<string, unknown>): void {
    const session = this.sessions.get(sessionId);
    if (!session || session.deleted) {
      this.send(res, 404, { error: { message: 'session not found' } });
      return;
    }
    if (session.status === 'failed') {
      this.send(res, 409, { error: { message: 'session failed' } });
      return;
    }
    if (session.pending_input != null || session.required_actions.some((action) => action.type === 'environment_connection')) {
      this.send(res, 409, { error: { message: 'input is already waiting for an environment connection' } });
      return;
    }
    session.pending_input = body.input ?? body;
    if (session.environment.status === 'connected') {
      this.startTurn(session);
      this.send(res, 200, this.publicSession(session));
      return;
    }
    const action = { id: id('act'), type: 'environment_connection' as RequiredActionType };
    session.required_actions.push(action);
    this.push(session, 'agent.session.requires_action', {
      id: session.id,
      required_action: { type: 'environment_connection' },
    }, false);
    this.push(session, 'agent.session.action_required', {
      id: session.id,
      required_action: { type: 'environment_connection' },
    }, true);
    this.armConnectionWait(session);
    this.send(res, 200, this.publicSession(session));
  }

  private sse(_req: IncomingMessage, res: ServerResponse, sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session || session.deleted) {
      this.send(res, 404, { error: { message: 'session not found' } });
      return;
    }
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });
    void (async () => {
      for await (const event of this.stream(sessionId)) {
        res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
        if (event.type === 'agent.session.turn.completed'
          || event.type === 'agent.session.turn.failed'
          || event.type === 'agent.session.failed') {
          break;
        }
      }
      res.end();
    })();
  }

  private async webhook(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await this.readRaw(req);
    try {
      verifyWebhook(this.options.webhookSecret, req.headers, body);
    } catch (error) {
      this.send(res, 400, { error: { message: error instanceof Error ? error.message : 'invalid signature' } });
      return;
    }
    const event = JSON.parse(body) as ApiEvent;
    if (queueDecision(event) !== 'ignore') this.queue.push(event);
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('ok');
    setImmediate(() => {
      void this.drain();
    });
  }

  private async drain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      while (this.queue.length) {
        const event = this.queue.shift()!;
        if (!this.onQueued) continue;
        try {
          await this.onQueued(event);
        } catch (error) {
          console.error(`webhook worker failed: ${error instanceof Error ? error.message : error}`);
        }
      }
    } finally {
      this.draining = false;
      if (this.queue.length) void this.drain();
    }
  }

  private publicSession(session: AgentSession): Record<string, unknown> {
    return {
      id: session.id,
      object: session.object,
      status: session.status,
      created_at: session.created_at,
      agent: session.agent,
      environment: session.environment,
      required_actions: session.required_actions,
      metadata: session.metadata,
      ...(session.error ? { error: session.error } : {}),
    };
  }

  private send(res: ServerResponse, status: number, body: unknown): void {
    const payload = JSON.stringify(body);
    res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) });
    res.end(payload);
  }

  private readRaw(req: IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      req.on('error', reject);
    });
  }

  private async readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
    const raw = await this.readRaw(req);
    if (!raw) return {};
    return JSON.parse(raw) as Record<string, unknown>;
  }
}
