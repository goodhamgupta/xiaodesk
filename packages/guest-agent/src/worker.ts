import { createBrowserTool, type BrowserTool } from './browser/browser-tool.js';
import { createMockAppServer } from './app-server/mock-server.js';
import { createStubAgent, type JobCard } from './stub/stub-agent.js';
import { spawn, type ChildProcess } from 'child_process';

interface RpcRequest {
  id?: number;
  method: string;
  params?: Record<string, unknown>;
}

let initialized = false;
let initSeen = false;
const threads = new Map<string, { id: string }>();
let browser: BrowserTool | null = null;
let lightpanda: ChildProcess | null = null;

function write(message: unknown): void {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function reply(id: number | undefined, result: unknown): void {
  write({ id, result });
}

function fail(id: number | undefined, code: number, message: string): void {
  write({ id, error: { code, message } });
}

function notify(method: string, params: unknown): void {
  write({ method, params });
}

function loadJob(): JobCard {
  const raw = process.env.GUEST_JOB_JSON;
  if (!raw) throw new Error('GUEST_JOB_JSON is not set');
  return JSON.parse(raw) as JobCard;
}

async function waitForCdp(port: string): Promise<void> {
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (response.ok) return;
    } catch {
      // server still booting
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error(`Lightpanda CDP did not come up on 127.0.0.1:${port}`);
}

async function launchBrowser(): Promise<BrowserTool> {
  const mode = process.env.BROWSER_MODE || 'chromium';
  const port = process.env.CDP_PORT || '9222';
  const allowFallback = process.env.ALLOW_CHROMIUM_FALLBACK !== 'false';

  if (mode === 'lightpanda') {
    try {
      let endpoint = process.env.LIGHTPANDA_CDP || `http://127.0.0.1:${port}`;
      if (process.env.LIGHTPANDA_BIN) {
        lightpanda = spawn(process.env.LIGHTPANDA_BIN, ['serve', '--host', '127.0.0.1', '--port', port], {
          env: { ...process.env, LIGHTPANDA_DISABLE_TELEMETRY: 'true' },
          stdio: 'ignore',
        });
        endpoint = `http://127.0.0.1:${port}`;
        await waitForCdp(port);
      }
      const tool = createBrowserTool({ mode: 'lightpanda', cdpEndpoint: endpoint, headless: true });
      await tool.launch();
      console.error(`browser: lightpanda via ${endpoint}`);
      return tool;
    } catch (error) {
      if (!allowFallback) throw error;
      console.error(`Lightpanda unavailable (${error instanceof Error ? error.message : error}). Falling back to Playwright Chromium.`);
    }
  }

  const tool = createBrowserTool({ mode: 'chromium', headless: true });
  await tool.launch();
  console.error('browser: playwright chromium');
  return tool;
}

async function handleTurn(id: number, params: Record<string, unknown>): Promise<void> {
  const threadId = String(params.threadId || '');
  if (!threads.has(threadId)) {
    fail(id, -32602, `Unknown thread ${threadId}`);
    return;
  }

  const turn = { id: `turn_${Date.now()}`, threadId, status: 'inProgress' };
  reply(id, { turn });
  notify('turn/started', { turn });

  const job = loadJob();
  try {
    browser = await launchBrowser();
    const agent = createStubAgent({
      fixturesUrl: process.env.FIXTURES_URL || 'http://127.0.0.1:4317',
      browserTool: browser,
      appServer: createMockAppServer(),
    });
    for await (const event of agent.run(job)) {
      const item = {
        type: event.type,
        id: `item_${Date.now()}`,
        text: JSON.stringify(event.data),
      };
      notify('item/completed', { item, event: event.type });
    }
    notify('turn/completed', { turn: { ...turn, status: 'completed' } });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(message);
    notify('turn/completed', { turn: { ...turn, status: 'failed', error: { message } } });
  } finally {
    await browser?.close().catch(() => undefined);
    browser = null;
    if (lightpanda) {
      lightpanda.kill('SIGTERM');
      lightpanda = null;
    }
  }
}

async function handle(message: RpcRequest): Promise<void> {
  const { id, method, params = {} } = message;

  if (method === 'initialize') {
    if (initSeen) {
      fail(id, -32600, 'Already initialized');
      return;
    }
    initSeen = true;
    reply(id, {
      userAgent: 'microvm-workshop-mock-app-server/1.0.0',
      platformFamily: 'lab',
      platformOs: process.platform,
    });
    return;
  }

  if (method === 'initialized') {
    initialized = true;
    return;
  }

  if (!initialized) {
    fail(id, -32600, 'Not initialized');
    return;
  }

  if (method === 'thread/start') {
    const thread = {
      id: `thr_${Math.random().toString(36).slice(2, 10)}`,
      ephemeral: true,
      path: null,
      status: 'idle',
      cwd: params.cwd ?? null,
    };
    threads.set(thread.id, thread);
    notify('thread/started', { thread });
    reply(id, { thread });
    return;
  }

  if (method === 'turn/start') {
    if (id === undefined) {
      fail(id, -32600, 'turn/start requires an id');
      return;
    }
    await handleTurn(id, params);
    return;
  }

  fail(id, -32601, `Method not found: ${method}`);
}

const incoming: RpcRequest[] = [];
let pumping = false;

async function pump(): Promise<void> {
  if (pumping) return;
  pumping = true;
  while (incoming.length) {
    const message = incoming.shift()!;
    try {
      await handle(message);
    } catch (error) {
      console.error(error);
      if (message.id !== undefined) {
        fail(message.id, -32000, error instanceof Error ? error.message : String(error));
      }
    }
  }
  pumping = false;
}

let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk: string) => {
  buffer += chunk;
  let newline = buffer.indexOf('\n');
  while (newline >= 0) {
    const line = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    newline = buffer.indexOf('\n');
    if (!line) continue;
    incoming.push(JSON.parse(line) as RpcRequest);
  }
  void pump();
});

process.stdin.on('end', () => {
  setTimeout(() => process.exit(0), 50);
});
