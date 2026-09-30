import { describe, expect, it, afterEach } from 'vitest';
import { WebSocket } from 'ws';
import { AgentsApiServer } from './server.js';
import { handleEnvironmentEvent } from './worker.js';
import { signWebhook, verifyWebhook } from './webhook.js';
import { queueDecision, LAB_EXECUTOR_KEY } from './types.js';
import { ShutdownCoordinator } from './shutdown.js';
import { DedupedCompute } from './dedup.js';

const secret = 'whsec_' + Buffer.from('test-webhook-secret-value!!!!').toString('base64');

function signed(event: unknown, skewSec = 0): { body: string; headers: Record<string, string> } {
  const body = JSON.stringify(event);
  const timestamp = String(Math.floor(Date.now() / 1000) + skewSec);
  const id = 'evt_test';
  return {
    body,
    headers: {
      'content-type': 'application/json',
      'webhook-id': id,
      'webhook-timestamp': timestamp,
      'webhook-signature': signWebhook(secret, id, timestamp, body),
    },
  };
}

describe('webhook signatures', () => {
  it('accepts a v1 hmac and rejects a bad signature or a stale timestamp', () => {
    const { body, headers } = signed({ id: 'evt_test', type: 'agent.session.idle', data: { id: 'sess_1' } });
    expect(() => verifyWebhook(secret, headers, body)).not.toThrow();
    expect(() => verifyWebhook(secret, { ...headers, 'webhook-signature': 'v1,bm90aGluZw==' }, body)).toThrow(/invalid/);
    const stale = signed({ id: 'evt_test' }, -600);
    expect(() => verifyWebhook(secret, stale.headers, stale.body)).toThrow(/tolerance/);
  });

  it('queues environment_connection and session failure only', () => {
    expect(queueDecision({ type: 'agent.session.action_required', data: { required_action: { type: 'environment_connection' } } })).toBe('provision');
    expect(queueDecision({ type: 'agent.session.action_required', data: { required_action: { type: 'function_call' } } })).toBe('ignore');
    expect(queueDecision({ type: 'agent.session.idle' })).toBe('ignore');
    expect(queueDecision({ type: 'agent.session.failed' })).toBe('release');
  });
});

describe('shutdown coordinator', () => {
  it('does not stop on a zero grace period and cancels a pending stop when work arrives', async () => {
    const coordinator = new ShutdownCoordinator();
    let stops = 0;
    coordinator.schedule('env', 0, () => { stops += 1; });
    expect(coordinator.pendingCount).toBe(0);
    coordinator.schedule('env', 40, () => { stops += 1; });
    expect(coordinator.cancel('env')).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(stops).toBe(0);
    coordinator.schedule('env', 20, () => { stops += 1; });
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(stops).toBe(1);
  });
});

describe('deduped compute', () => {
  it('boots once for concurrent ensures', async () => {
    const dedup = new DedupedCompute();
    let boots = 0;
    const boot = async () => {
      boots += 1;
      await new Promise((resolve) => setTimeout(resolve, 30));
    };
    await Promise.all([dedup.ensure('ccarenv_a', boot), dedup.ensure('ccarenv_a', boot)]);
    expect(boots).toBe(1);
  });
});

describe('agents api lifecycle', () => {
  const servers: AgentsApiServer[] = [];

  afterEach(async () => {
    await Promise.all(servers.splice(0).map((server) => server.close()));
  });

  async function start(connectionWaitMs = 300_000): Promise<AgentsApiServer> {
    const server = new AgentsApiServer({
      port: 0,
      host: '127.0.0.1',
      publicHost: '127.0.0.1',
      appKey: 'lab-app',
      executorKey: LAB_EXECUTOR_KEY,
      webhookSecret: secret,
      connectionWaitMs,
    });
    await server.listen();
    servers.push(server);
    return server;
  }

  async function api(server: AgentsApiServer, method: string, path: string, body?: unknown, token = 'lab-app') {
    const response = await fetch(`http://127.0.0.1:${server.port}${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) as Record<string, unknown> : {} };
  }

  it('rejects the executor key on session routes and a bad webhook signature', async () => {
    const server = await start();
    const denied = await api(server, 'POST', '/v1/agents/sessions', {
      agent: { model: 'lab-stub' },
      environment: { type: 'self_hosted', workspace_directory: '/workspace' },
    }, LAB_EXECUTOR_KEY);
    expect(denied.status).toBe(403);

    const bad = await fetch(`http://127.0.0.1:${server.port}/webhooks/openai`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'webhook-id': 'x', 'webhook-timestamp': '1', 'webhook-signature': 'v1,nope' },
      body: '{}',
    });
    expect(bad.status).toBe(400);
  });

  it('does not provision for function_call, does not stop on delete, and ignores idle', async () => {
    const server = await start();
    let ensured = 0;
    let stopped = 0;
    server.onQueued = (event) => handleEnvironmentEvent(event, {
      retrieve: (id) => server.getSession(id),
      ensure: async () => { ensured += 1; },
      stop: async () => { stopped += 1; },
    });

    const created = await api(server, 'POST', '/v1/agents/sessions', {
      agent: { model: 'lab-stub' },
      environment: { type: 'self_hosted', workspace_directory: '/workspace' },
    });
    const sessionId = String(created.body.id);
    const fn = signed({
      id: 'evt_fn',
      object: 'event',
      type: 'agent.session.action_required',
      data: { id: sessionId, required_action: { type: 'function_call' } },
    });
    const posted = await fetch(`http://127.0.0.1:${server.port}/webhooks/openai`, { method: 'POST', headers: fn.headers, body: fn.body });
    expect(posted.status).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(ensured).toBe(0);

    const deleted = await api(server, 'DELETE', `/v1/agents/sessions/${sessionId}`);
    expect(deleted.status).toBe(200);
    expect((await api(server, 'GET', `/v1/agents/sessions/${sessionId}`)).status).toBe(404);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(stopped).toBe(0);
  });

  it('fails the session when the executor misses the connection deadline and does not replay input', async () => {
    const server = await start(200);
    let stopped = 0;
    server.onQueued = (event) => handleEnvironmentEvent(event, {
      retrieve: (id) => server.getSession(id),
      ensure: async () => undefined,
      stop: async () => { stopped += 1; },
    });
    const created = await api(server, 'POST', '/v1/agents/sessions', {
      agent: { model: 'lab-stub' },
      environment: { type: 'self_hosted', workspace_directory: '/workspace' },
    });
    const session = created.body as { id: string; environment: { id: string; remote_url: string } };
    const input = await api(server, 'POST', `/v1/agents/sessions/${session.id}/input`, {
      input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'go' }] }],
    });
    expect(input.status).toBe(200);
    const again = await api(server, 'POST', `/v1/agents/sessions/${session.id}/input`, { input: [] });
    expect(again.status).toBe(409);

    await new Promise((resolve) => setTimeout(resolve, 400));
    const after = await api(server, 'GET', `/v1/agents/sessions/${session.id}`);
    expect(after.body.status).toBe('failed');
    expect(stopped).toBeGreaterThan(0);

    let commands = 0;
    const ws = new WebSocket(session.environment.remote_url, {
      headers: { authorization: `Bearer ${LAB_EXECUTOR_KEY}` },
    });
    await new Promise<void>((resolve, reject) => {
      ws.on('open', () => {
        ws.send(JSON.stringify({ type: 'register', environment_id: session.environment.id }));
      });
      ws.on('message', (raw) => {
        const message = JSON.parse(String(raw)) as { type?: string };
        if (message.type === 'command') commands += 1;
        if (message.type === 'registered' || message.type === 'error') resolve();
      });
      ws.on('error', reject);
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(commands).toBe(0);
    ws.close();
  });

  it('runs a turn once the executor connects and does not stop on idle', async () => {
    const server = await start();
    let stopped = 0;
    server.onQueued = (event) => handleEnvironmentEvent(event, {
      retrieve: (id) => server.getSession(id),
      ensure: async (session) => {
        const ws = new WebSocket(session.environment.remote_url, {
          headers: { authorization: `Bearer ${server.executorKey}` },
        });
        ws.on('message', (raw) => {
          const message = JSON.parse(String(raw)) as { type?: string; id?: string; name?: string };
          if (message.type === 'command' && message.name === 'run_job') {
            ws.send(JSON.stringify({ type: 'command_result', id: message.id, ok: true, output: 'ok' }));
          }
        });
        ws.on('open', () => {
          ws.send(JSON.stringify({ type: 'register', environment_id: session.environment.id }));
        });
      },
      stop: async () => { stopped += 1; },
    });

    const created = await api(server, 'POST', '/v1/agents/sessions', {
      agent: { model: 'lab-stub' },
      environment: { type: 'self_hosted', workspace_directory: '/workspace' },
      metadata: { job: { id: 'job', pack: 'support', name: 'n', goal: 'g', params: {} } },
    });
    const session = created.body as { id: string; environment: { remote_url: string; status: string } };
    expect(session.environment.remote_url).toContain('/v1/agents/api');
    expect(session.environment.status).toBe('pending');
    await api(server, 'POST', `/v1/agents/sessions/${session.id}/input`, {
      input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'go' }] }],
    });

    const seen: string[] = [];
    for await (const event of server.stream(session.id)) {
      seen.push(event.type);
      if (event.type === 'agent.session.idle') break;
    }
    expect(seen).toContain('agent.session.requires_action');
    expect(seen).toContain('agent.session.environment.connected');
    expect(seen).toContain('agent.session.in_progress');
    expect(seen).toContain('agent.session.turn.completed');
    expect(seen.at(-1)).toBe('agent.session.idle');
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(stopped).toBe(0);
    const finalSession = server.getSession(session.id);
    expect(finalSession?.status).toBe('idle');
    expect(finalSession?.environment.status).toBe('connected');
  });
});
