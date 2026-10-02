import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { planDesk, type DeskAction, type DeskPlan } from './plan.js';

export interface DeskEvent {
  type: 'assistant' | 'action' | 'shot' | 'error' | 'done';
  text?: string;
  op?: string;
  file?: string;
}

const ready = new Set<string>();

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

function sshArgs(keyPath: string, port: number, remote: string): string[] {
  return [
    '-i', keyPath,
    '-p', String(port),
    '-o', 'StrictHostKeyChecking=no',
    '-o', 'UserKnownHostsFile=/dev/null',
    '-o', 'IdentitiesOnly=yes',
    '-o', 'BatchMode=yes',
    '-o', 'ConnectTimeout=8',
    'lume@127.0.0.1',
    remote,
  ];
}

function scpArgs(keyPath: string, port: number, src: string, dest: string): string[] {
  return [
    '-i', keyPath,
    '-P', String(port),
    '-o', 'StrictHostKeyChecking=no',
    '-o', 'UserKnownHostsFile=/dev/null',
    '-o', 'IdentitiesOnly=yes',
    '-o', 'BatchMode=yes',
    src,
    `lume@127.0.0.1:${dest}`,
  ];
}

async function ensureGuest(port: number, keyPath: string, repoRoot: string, guestId: string): Promise<void> {
  if (ready.has(guestId)) return;
  const guestDir = join(repoRoot, 'scripts/guest');
  const copies: Array<[string, string]> = [
    [join(guestDir, 'desk-act.mjs'), '/tmp/desk-act.mjs'],
    [join(guestDir, 'desk-menu.xml'), '/tmp/desk-menu.xml'],
    [join(guestDir, 'desk-chrome.sh'), '/tmp/desk-chrome.sh'],
  ];
  for (const [src, dest] of copies) {
    const copied = await run('scp', scpArgs(keyPath, port, src, dest), 20000);
    if (copied.code !== 0) throw new Error(copied.stderr.trim() || `scp failed (${copied.code})`);
  }
  const setup = await run('ssh', sshArgs(keyPath, port, [
    'sudo -n cp /tmp/desk-menu.xml /etc/xdg/openbox/menu.xml',
    'sudo -n cp /tmp/desk-chrome.sh /usr/local/bin/desk-chrome',
    'sudo -n chmod 755 /usr/local/bin/desk-chrome',
    'mkdir -p "$HOME/Desktop" "$HOME/Downloads" "$HOME/.config/desk-chrome" "$HOME/.config/pcmanfm/default"',
    'DISPLAY=:0 openbox --reconfigure || true',
  ].join(' && ')), 20000);
  if (setup.code !== 0) throw new Error(setup.stderr.trim() || 'desk setup failed');
  ready.add(guestId);
}

async function guestAction(port: number, keyPath: string, action: DeskAction | { op: 'shot' }): Promise<{ ok: boolean; detail: string }> {
  const payload = Buffer.from(JSON.stringify(action)).toString('base64');
  const result = await run('ssh', sshArgs(keyPath, port, `node /tmp/desk-act.mjs ${payload}`), 70000);
  const line = result.stdout.trim().split('\n').filter(Boolean).pop() || '';
  if (!line) {
    return { ok: false, detail: result.stderr.trim() || `guest action failed (${result.code})` };
  }
  try {
    const parsed = JSON.parse(line) as { ok?: boolean; detail?: string };
    return { ok: Boolean(parsed.ok), detail: parsed.detail || (parsed.ok ? 'ok' : 'failed') };
  } catch {
    return { ok: false, detail: line.slice(0, 400) };
  }
}

export async function* runDeskChat(options: {
  guestId: string;
  message: string;
  sshPort: number;
  keyPath: string;
  repoRoot: string;
  shotsDir: string;
  plan?: DeskPlan;
}): AsyncGenerator<DeskEvent> {
  const plan = options.plan ?? planDesk(options.message);
  yield { type: 'assistant', text: plan.say };
  if (!plan.actions.length) {
    yield { type: 'done' };
    return;
  }
  try {
    await ensureGuest(options.sshPort, options.keyPath, options.repoRoot, options.guestId);
  } catch (error) {
    yield { type: 'error', text: error instanceof Error ? error.message : String(error) };
    yield { type: 'done' };
    return;
  }
  for (const action of plan.actions) {
    const result = await guestAction(options.sshPort, options.keyPath, action);
    if (!result.ok) {
      yield { type: 'error', text: result.detail };
      yield { type: 'done' };
      return;
    }
    yield { type: 'action', op: action.op, text: result.detail };
  }
  const shot = await guestAction(options.sshPort, options.keyPath, { op: 'shot' });
  if (shot.ok) {
    mkdirSync(options.shotsDir, { recursive: true });
    const file = `${options.guestId}__${Date.now()}.png`;
    const fetch = await run('scp', [
      '-i', options.keyPath,
      '-P', String(options.sshPort),
      '-o', 'StrictHostKeyChecking=no',
      '-o', 'UserKnownHostsFile=/dev/null',
      '-o', 'IdentitiesOnly=yes',
      '-o', 'BatchMode=yes',
      'lume@127.0.0.1:/tmp/desk-shot.png',
      join(options.shotsDir, file),
    ], 20000);
    if (fetch.code === 0) yield { type: 'shot', file, text: 'Screen after the turn' };
  }
  yield { type: 'done' };
}
