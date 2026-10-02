import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { mcpResultText, summarizeNodes, type NodeRow } from './fleet.js';

const PORT = 18789;

export interface OpenClawPaths {
  repoRoot: string;
  bin?: string;
}

function clawBin(paths: OpenClawPaths): string {
  return paths.bin || process.env.OPENCLAW_BIN || '/opt/openclaw/bin/openclaw';
}

function envFor(paths: OpenClawPaths): NodeJS.ProcessEnv {
  const run = join(paths.repoRoot, 'runs/openclaw');
  return {
    ...process.env,
    PATH: `${join('/opt/openclaw/bin')}:${process.env.PATH || ''}`,
    OPENCLAW_STATE_DIR: process.env.OPENCLAW_STATE_DIR || join(run, 'state'),
    OPENCLAW_CONFIG_PATH: process.env.OPENCLAW_CONFIG_PATH || join(run, 'openclaw.json'),
    OPENCLAW_DESK_INBOX: process.env.OPENCLAW_DESK_INBOX || join(run, 'inbox.jsonl'),
  };
}

function readToken(paths: OpenClawPaths, name: 'gateway.token' | 'hook.token'): string {
  const file = join(paths.repoRoot, 'runs/openclaw', name);
  try {
    return readFileSync(file, 'utf8').trim();
  } catch {
    return '';
  }
}

function run(cmd: string, args: string[], env: NodeJS.ProcessEnv, timeoutMs: number): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.stdout.on('data', (chunk) => { stdout += chunk.toString('utf8'); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8'); });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? 1, stdout, stderr });
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      resolve({ code: 1, stdout, stderr: error.message });
    });
  });
}

export async function gatewayUp(): Promise<boolean> {
  try {
    const response = await fetch(`http://127.0.0.1:${PORT}/readyz`, { signal: AbortSignal.timeout(800) });
    return response.ok;
  } catch {
    return false;
  }
}

export async function postDeskHook(paths: OpenClawPaths, from: string, text: string): Promise<void> {
  const token = readToken(paths, 'hook.token');
  if (!token) throw new Error('OpenClaw hook token is missing. Run scripts/openclaw-up.sh.');
  const response = await fetch(`http://127.0.0.1:${PORT}/hooks/desk`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from, text }),
    signal: AbortSignal.timeout(8000),
  });
  if (response.status !== 200 && response.status !== 204) {
    const body = await response.text();
    throw new Error(body.trim() || `hook failed: HTTP ${response.status}`);
  }
}

export async function listNodes(paths: OpenClawPaths): Promise<{ text: string; nodes: NodeRow[] }> {
  const result = await run(clawBin(paths), ['nodes', 'status', '--json'], envFor(paths), 12000);
  if (result.code !== 0) throw new Error(result.stderr.trim() || result.stdout.trim() || 'openclaw nodes status failed');
  const parsed = JSON.parse(result.stdout) as { nodes?: NodeRow[] };
  const nodes = parsed.nodes || [];
  return { text: summarizeNodes(nodes), nodes };
}

export async function invokeNode(paths: OpenClawPaths, node: string, command: string, params: unknown, timeoutMs = 20000): Promise<unknown> {
  const result = await run(clawBin(paths), [
    'nodes', 'invoke',
    '--node', node,
    '--command', command,
    '--params', JSON.stringify(params),
    '--json',
    '--timeout', String(timeoutMs),
  ], envFor(paths), timeoutMs + 5000);
  if (result.code !== 0) {
    throw new Error(result.stderr.trim() || result.stdout.trim() || `${command} failed on ${node}`);
  }
  return JSON.parse(result.stdout) as unknown;
}

export async function runDeskTool(paths: OpenClawPaths, node: string, action: Record<string, unknown>): Promise<string> {
  const invoked = await invokeNode(paths, node, 'mcp.tools.call.v1', {
    server: 'desk',
    tool: 'desk',
    arguments: action,
  }, 45000) as { ok?: boolean; payload?: unknown; error?: { message?: string } };
  if (invoked && invoked.ok === false) throw new Error(invoked.error?.message || `desk tool failed on ${node}`);
  return mcpResultText(invoked) || mcpResultText((invoked as { payload?: unknown }).payload) || 'ok';
}

export async function nodeState(paths: OpenClawPaths, node: string): Promise<string> {
  const which = await invokeNode(paths, node, 'system.which', { bins: ['uname', 'python3', 'openclaw'] });
  const listing = await invokeNode(paths, node, 'fs.listDir', { path: '/home/neko' });
  const whichText = mcpResultText(which) || JSON.stringify((which as { payload?: unknown }).payload ?? which);
  const listText = JSON.stringify((listing as { payload?: unknown }).payload ?? listing);
  return `${node}\n${whichText}\n${listText}`.slice(0, 2000);
}
