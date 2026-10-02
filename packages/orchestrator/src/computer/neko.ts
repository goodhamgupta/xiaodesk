import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { WebSocket } from 'ws';
import { planDesk, type DeskAction, type DeskPlan } from './plan.js';
import type { DeskEvent } from './desk.js';

const CONTAINER = process.env.NEKO_NAME || 'workshop-neko';
const DISPLAY = process.env.NEKO_DISPLAY || ':99.0';
const HOME = '/home/neko';
const FIXTURES = process.env.NEKO_FIXTURES_URL || 'http://127.0.0.1:4317';

const scriptReady = new Set<string>();

function run(cmd: string, args: string[], timeoutMs: number): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString('utf8');
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? 1, stdout, stderr });
    });
  });
}

function dockerBin(): string {
  return process.env.DOCKER_BIN || 'docker';
}

async function ensureScript(repoRoot: string, container: string): Promise<void> {
  if (scriptReady.has(container)) return;
  const src = join(repoRoot, 'scripts/neko/desk-act.py');
  const copied = await run(dockerBin(), ['cp', src, `${container}:/tmp/desk-act.py`], 20000);
  if (copied.code !== 0) throw new Error(copied.stderr.trim() || 'docker cp desk-act.py failed');
  scriptReady.add(container);
}

async function guestAction(action: DeskAction | { op: 'shot' }, container: string): Promise<{ ok: boolean; detail: string }> {
  const payload = Buffer.from(JSON.stringify(action)).toString('base64');
  const result = await run(dockerBin(), [
    'exec',
    '-u', 'neko',
    '-e', `DISPLAY=${DISPLAY}`,
    '-e', `HOME=${HOME}`,
    '-e', 'XDG_RUNTIME_DIR=/tmp/runtime-neko',
    '-e', 'MOZ_DISABLE_CONTENT_SANDBOX=1',
    container,
    'python3', '/tmp/desk-act.py', payload,
  ], 40000);
  const line = result.stdout.trim().split('\n').filter(Boolean).pop() || '';
  if (!line) return { ok: false, detail: result.stderr.trim() || `neko action failed (${result.code})` };
  try {
    const parsed = JSON.parse(line) as { ok?: boolean; detail?: string };
    return { ok: Boolean(parsed.ok), detail: parsed.detail || (parsed.ok ? 'ok' : 'failed') };
  } catch {
    return { ok: false, detail: line.slice(0, 400) };
  }
}

const REACTION_IDS = new Set([
  'thumbs-up', 'clap', 'love', 'party', 'wave', 'flame', 'thinking', 'okay',
  'celebrate', 'cool', 'happy', 'sad', 'rofl', 'hundred',
]);

export function sendNekoEmote(emote: string, wsUrl = process.env.NEKO_WS || 'ws://127.0.0.1:8341/ws?password=neko&username=codex'): Promise<void> {
  if (!REACTION_IDS.has(emote)) return Promise.reject(new Error(`unknown reaction ${emote}`));
  const url = wsUrl;
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    let sent = false;
    const timer = setTimeout(() => {
      ws.close();
      reject(new Error('neko reaction timed out'));
    }, 8000);
    const finish = (error?: Error) => {
      clearTimeout(timer);
      ws.close();
      if (error) reject(error);
      else resolve();
    };
    ws.on('message', (buf) => {
      let msg: { event?: string };
      try {
        msg = JSON.parse(buf.toString()) as { event?: string };
      } catch {
        return;
      }
      if (msg.event === 'system/init' && !sent) {
        sent = true;
        ws.send(JSON.stringify({ event: 'chat/emote', emote }));
      }
      if (msg.event === 'chat/emote' && sent) finish();
    });
    ws.on('error', (error) => finish(error instanceof Error ? error : new Error(String(error))));
  });
}

export async function runNekoDock(repoRoot: string, op: 'chrome' | 'terminal' | 'files', container = CONTAINER): Promise<{ ok: boolean; detail: string }> {
  await ensureScript(repoRoot, container);
  const action: DeskAction = op === 'chrome'
    ? { op: 'chrome', url: 'about:blank' }
    : op === 'terminal'
      ? { op: 'terminal' }
      : { op: 'files', path: HOME };
  return guestAction(action, container);
}

export async function* runNekoChat(options: {
  message: string;
  repoRoot: string;
  shotsDir: string;
  plan?: DeskPlan;
  container?: string;
  wsUrl?: string;
}): AsyncGenerator<DeskEvent> {
  const container = options.container || CONTAINER;
  const plan = options.plan ?? planDesk(options.message, { home: HOME, fixturesUrl: FIXTURES });
  yield { type: 'assistant', text: plan.say };
  if (!plan.actions.length) {
    yield { type: 'done' };
    return;
  }
  try {
    await ensureScript(options.repoRoot, container);
  } catch (error) {
    yield { type: 'error', text: error instanceof Error ? error.message : String(error) };
    yield { type: 'done' };
    return;
  }
  for (const action of plan.actions) {
    if (action.op === 'react') {
      try {
        await sendNekoEmote(action.emote || '', options.wsUrl);
        yield { type: 'action', op: 'react', text: `reaction ${action.emote}` };
      } catch (error) {
        yield { type: 'error', text: error instanceof Error ? error.message : String(error) };
        yield { type: 'done' };
        return;
      }
      continue;
    }
    const result = await guestAction(action, container);
    if (!result.ok) {
      yield { type: 'error', text: result.detail };
      yield { type: 'done' };
      return;
    }
    yield { type: 'action', op: action.op, text: result.detail };
  }
  const shot = await guestAction({ op: 'shot' }, container);
  if (shot.ok) {
    mkdirSync(options.shotsDir, { recursive: true });
    const file = `neko__${Date.now()}.png`;
    const fetched = await run(dockerBin(), ['cp', `${container}:/tmp/desk-shot.png`, join(options.shotsDir, file)], 20000);
    if (fetched.code === 0) yield { type: 'shot', file, text: 'Screen after the turn' };
  }
  yield { type: 'done' };
}
