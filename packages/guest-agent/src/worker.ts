import { runGuestJob } from './run-job.js';
import type { JobCard } from './stub/stub-agent.js';

interface RpcRequest {
  id?: number;
  method: string;
  params?: Record<string, unknown>;
}

let initialized = false;
let initSeen = false;
const threads = new Map<string, { id: string }>();

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
    await runGuestJob(job, (event) => {
      const item = {
        type: event.type,
        id: `item_${Date.now()}`,
        text: JSON.stringify(event.data),
      };
      notify('item/completed', { item, event: event.type });
    });
    notify('turn/completed', { turn: { ...turn, status: 'completed' } });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(message);
    notify('turn/completed', { turn: { ...turn, status: 'failed', error: { message } } });
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
