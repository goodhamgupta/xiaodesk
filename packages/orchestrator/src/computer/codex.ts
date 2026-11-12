import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { DeskEvent } from './desk.js';

export interface CodexDeskOptions {
  message: string;
  container: string;
  repoRoot: string;
  shotsDir: string;
  timeoutMs?: number;
}

interface JsonRpcMessage {
  id?: number;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { message?: string };
}

class AppServerRpc {
  private buffer = '';
  private nextId = 1;
  private pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  private listeners = new Set<(message: JsonRpcMessage) => void>();

  constructor(private child: ChildProcess) {
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => this.onData(chunk));
  }

  request<T = unknown>(method: string, params: unknown): Promise<T> {
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: (value) => resolve(value as T), reject });
      this.send({ id, method, params });
    });
  }

  notify(method: string, params: unknown): void {
    this.send({ method, params });
  }

  onMessage(listener: (message: JsonRpcMessage) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  failAll(error: Error): void {
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }

  private send(message: unknown): void {
    if (process.env.CODEX_DEBUG) console.error(`app-server -> ${JSON.stringify(message)}`);
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
      let message: JsonRpcMessage;
      try {
        message = JSON.parse(line) as JsonRpcMessage;
      } catch {
        continue;
      }
      if (process.env.CODEX_DEBUG) console.error(`app-server <- ${line}`);
      if (message.id !== undefined && (message.result !== undefined || message.error)) {
        const pending = this.pending.get(message.id);
        this.pending.delete(message.id);
        if (!pending) continue;
        if (message.error) pending.reject(new Error(message.error.message || 'app-server rpc error'));
        else pending.resolve(message.result);
        continue;
      }
      for (const listener of this.listeners) listener(message);
    }
  }
}

export function codexDeskAvailable(): boolean {
  if (process.env.CODEX_DESK === '0') return false;
  if (process.env.CODEX_DESK === '1') return true;
  const auth = process.env.CODEX_AUTH_JSON || join(homedir(), '.codex', 'auth.json');
  return Boolean(process.env.OPENAI_API_KEY) || existsSync(auth);
}

function containerBin(): string {
  if (process.env.DOCKER_BIN) return process.env.DOCKER_BIN;
  try {
    execFileSync('podman', ['--version'], { stdio: 'ignore' });
    return 'podman';
  } catch {
    return 'docker';
  }
}

function ensureContainerAuth(bin: string, container: string): void {
  const auth = process.env.CODEX_AUTH_JSON || join(homedir(), '.codex', 'auth.json');
  if (!existsSync(auth)) return;
  try {
    execFileSync(bin, ['cp', auth, `${container}:/home/neko/.codex/auth.json`], { stdio: 'ignore' });
    execFileSync(bin, ['exec', '-u', 'root', container, 'chown', 'neko:neko', '/home/neko/.codex/auth.json'], { stdio: 'ignore' });
    execFileSync(bin, ['exec', '-u', 'root', container, 'chmod', '600', '/home/neko/.codex/auth.json'], { stdio: 'ignore' });
  } catch (error) {
    if (process.env.CODEX_DEBUG) {
      console.error(`codex auth copy failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

const SCREEN_CHANGING_TOOLS = new Set([
  'launch_app', 'click', 'double_click', 'right_click', 'type_text',
  'type_text_chars', 'press_key', 'hotkey', 'scroll', 'drag', 'run_steps',
  'page', 'set_value', 'bring_to_front',
]);

function captureActiveWindow(bin: string, container: string, shotsDir: string): string | null {
  try {
    mkdirSync(shotsDir, { recursive: true });
    execFileSync(bin, [
      'exec', '-u', 'neko',
      '-e', 'DISPLAY=:99.0',
      '-e', 'HOME=/home/neko',
      '-e', 'XDG_RUNTIME_DIR=/tmp/runtime-neko',
      container,
      'bash', '-lc',
      'scrot -u -o /tmp/desk-active.png >/dev/null 2>&1 || scrot -o /tmp/desk-active.png >/dev/null 2>&1',
    ], { stdio: 'ignore' });
    const file = `${container}__active-${Date.now()}.png`;
    execFileSync(bin, ['cp', `${container}:/tmp/desk-active.png`, join(shotsDir, file)], { stdio: 'ignore' });
    return file;
  } catch {
    return null;
  }
}

const DESK_INSTRUCTIONS = [
  'You control a disposable Linux Xfce desktop inside a container, on DISPLAY=:99.0.',
  'Use only the cua-driver MCP tools for GUI work. Do not use shell commands to operate the desktop.',
  'After every action that changes the screen, call get_window_state or get_browser_state and read the actual screen/page before answering.',
  'For web tasks, use the page/browser tools to read visible content and report the content, not merely that a window opened.',
  'Never claim something is open, done, or visible without a fresh observation that proves it.',
].join(' ');

/**
 * Run one Codex app-server turn inside the neko container.
 *
 * Codex and Cua Driver both run in the guest. The host only carries stdio and
 * copies the host Codex auth file into the container before the turn. This is
 * deliberate: the model must only ever see the container desktop.
 */
export async function* runCodexDesk(options: CodexDeskOptions): AsyncGenerator<DeskEvent> {
  const bin = containerBin();
  ensureContainerAuth(bin, options.container);

  const apiKey = process.env.OPENAI_API_KEY;
  const args = [
    'exec', '-i',
    '-u', 'neko',
    '-e', 'DISPLAY=:99.0',
    '-e', 'HOME=/home/neko',
    '-e', 'XDG_RUNTIME_DIR=/tmp/runtime-neko',
    '-e', 'CODEX_HOME=/home/neko/.codex',
    '-e', `CUA_DRIVER_PERMISSION_MODE=${process.env.CUA_DRIVER_PERMISSION_MODE || 'unrestricted'}`,
    ...(apiKey ? ['-e', `OPENAI_API_KEY=${apiKey}`] : []),
    options.container,
    'bash', '-lc',
    [
      'exec /usr/local/bin/codex app-server',
      '-c approval_policy="never"',
      '-c sandbox_mode="danger-full-access"',
      '-c model_reasoning_summary="detailed"',
    ].join(' '),
  ];
  const child = spawn(bin, args, { stdio: ['pipe', 'pipe', 'pipe'] });

  let stderr = '';
  child.stderr?.setEncoding('utf8');
  child.stderr?.on('data', (chunk: string) => {
    stderr = `${stderr}${chunk}`.slice(-4000);
  });

  const rpc = new AppServerRpc(child);
  const timeoutMs = options.timeoutMs ?? 300_000;
  const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
  const queue: DeskEvent[] = [];
  let wake: (() => void) | null = null;
  let done = false;
  let failure: Error | null = null;
  const streamedAgent = new Set<string>();
  const summarized = new Set<string>();

  const push = (event: DeskEvent) => {
    queue.push(event);
    wake?.();
    wake = null;
  };

  const fail = (error: Error) => {
    failure = error;
    done = true;
    rpc.failAll(error);
    wake?.();
    wake = null;
  };

  child.on('exit', (code) => {
    if (!done) fail(new Error(stderr.trim() || `codex app-server exited ${code}`));
  });
  child.on('error', (error) => fail(error));

  const off = rpc.onMessage((message) => {
    const params = message.params as {
      item?: {
        id?: string;
        type?: string;
        text?: string;
        tool?: string;
        server?: string;
        summary?: Array<string | { text?: string }> | null;
      };
      itemId?: string;
      delta?: string;
      turn?: { status?: string; error?: { message?: string } };
    } | undefined;

    if (message.method === 'item/agentMessage/delta' && params?.itemId && params.delta) {
      streamedAgent.add(params.itemId);
      push({ type: 'assistant_delta', id: params.itemId, text: params.delta });
      return;
    }
    if (message.method === 'item/reasoning/summaryTextDelta' && params?.itemId && params.delta) {
      summarized.add(params.itemId);
      push({ type: 'reasoning_delta', id: params.itemId, text: params.delta });
      return;
    }
    if (message.method === 'item/reasoning/textDelta' && params?.itemId && params.delta && !summarized.has(params.itemId)) {
      push({ type: 'reasoning_delta', id: params.itemId, text: params.delta });
      return;
    }
    if (message.method === 'item/completed' && params?.item) {
      const item = params.item;
      const type = item.type || '';
      if ((type === 'agentMessage' || type === 'agent_message') && item.text) {
        // The final event replaces the streamed bubble in the UI and lands in
        // chat history once. Deltas are only for live display.
        push({ type: 'assistant', id: item.id, text: item.text });
      } else if (type === 'reasoning') {
        const summary = (item.summary || []) as Array<string | { text?: string }>;
        const text = summary.map((part) => (typeof part === 'string' ? part : part.text || '')).join('\n').trim();
        if (text) push({ type: 'reasoning', id: item.id, text });
      } else if (type === 'mcpToolCall' || type === 'mcp_tool_call') {
        push({ type: 'action', op: item.tool || 'tool', text: `${item.server || 'mcp'}.${item.tool || 'tool'}` });
        if (SCREEN_CHANGING_TOOLS.has(item.tool || '')) {
          const file = captureActiveWindow(bin, options.container, options.shotsDir);
          if (file) push({ type: 'shot', file, text: 'Active window' });
        }
      } else if (type === 'error') {
        push({ type: 'error', text: item.text || 'codex error' });
      }
    }
    if (message.method === 'turn/completed') {
      if (params?.turn?.status === 'failed') {
        failure = new Error(params.turn.error?.message || 'codex turn failed');
      }
      done = true;
      wake?.();
      wake = null;
    }
  });

  try {
    await rpc.request('initialize', {
      clientInfo: { name: 'micro-flow-desk', title: 'Micro Flow Desk', version: '1.0.0' },
    });
    rpc.notify('initialized', {});
    const thread = await rpc.request<{ thread?: { id?: string } }>('thread/start', {
      cwd: '/home/neko',
      ephemeral: true,
      developerInstructions: DESK_INSTRUCTIONS,
    });
    const threadId = thread.thread?.id;
    if (!threadId) throw new Error('codex app-server returned no thread id');

    const turn = rpc.request('turn/start', {
      threadId,
      input: [{ type: 'text', text: options.message }],
      effort: 'high',
      summary: 'detailed',
    });
    turn.catch((error: unknown) => {
      fail(error instanceof Error ? error : new Error(String(error)));
    });

    while (!done || queue.length > 0) {
      if (queue.length === 0) {
        await new Promise<void>((resolve) => { wake = resolve; });
      }
      while (queue.length > 0) {
        const event = queue.shift();
        if (event) yield event;
      }
    }
    if (failure) throw failure;
    await turn.catch(() => undefined);
    yield { type: 'done' };
  } finally {
    clearTimeout(timer);
    off();
    rpc.failAll(new Error('codex desk turn ended'));
    if (child.exitCode === null) child.kill('SIGTERM');
  }
}
