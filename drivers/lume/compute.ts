import { spawn, type ChildProcess } from 'child_process';
import { existsSync, mkdirSync, openSync, readFileSync } from 'fs';
import { join } from 'path';
import type { AgentSession } from '../../packages/agents-api/src/types.js';
import { DedupedCompute } from '../../packages/agents-api/src/dedup.js';

export function repoRootFrom(here: string): string {
  return join(here, '../..');
}

export interface VmDisplayInfo {
  guestId: string;
  vncPort: number;
  vncPassword?: string;
  jobName?: string;
}

export interface DisplayHooks {
  onDisplay?(info: VmDisplayInfo): void;
  onDisplayEnd?(guestId: string): void;
}

export function buildQemuArgs(input: {
  accel: 'kvm' | 'tcg';
  memoryMb: number;
  overlay: string;
  sshPort: number;
  vncPort: number;
  serialLog: string;
}): string[] {
  const cpu = input.accel === 'kvm'
    ? ['-enable-kvm', '-cpu', 'host']
    : ['-machine', 'accel=tcg', '-cpu', 'qemu64'];
  const vncDisplay = input.vncPort - 5900;
  return [
    ...cpu,
    '-m', String(input.memoryMb),
    '-smp', '2',
    '-vga', 'std',
    '-display', 'none',
    '-vnc', `127.0.0.1:${vncDisplay},share=force-shared`,
    '-monitor', 'none',
    '-serial', `file:${input.serialLog}`,
    '-no-reboot',
    '-drive', `file=${input.overlay},if=virtio,format=qcow2,cache=writethrough`,
    '-nic', `user,model=virtio-net-pci,hostfwd=tcp:127.0.0.1:${input.sshPort}-:22`,
  ];
}

export function lumeCreateArgs(name: string): string[] {
  return ['create', name, '--os', 'linux', '--cpu', '2', '--memory', '2GB', '--disk-size', '12GB'];
}

export function lumeRunArgs(name: string, vncPort = 0): string[] {
  return ['run', name, '--display', 'none', '--detach', '--vnc-port', String(vncPort)];
}

export function lumeStopArgs(name: string): string[] {
  return ['stop', name];
}

function sshArgs(port: number, keyPath: string): string[] {
  return [
    '-i', keyPath,
    '-p', String(port),
    '-o', 'StrictHostKeyChecking=no',
    '-o', 'UserKnownHostsFile=/dev/null',
    '-o', 'IdentitiesOnly=yes',
    '-o', 'ConnectTimeout=3',
    '-o', 'BatchMode=yes',
  ];
}

function run(cmd: string, args: string[], input?: string): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => { stdout += chunk; });
    child.stderr.on('data', (chunk: string) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code: code ?? 1, stdout, stderr }));
    if (input !== undefined) child.stdin.end(input);
    else child.stdin.end();
  });
}

export interface ComputeBackend {
  readonly name: 'kvm' | 'lume';
  readonly guestHost: string;
  ensure(session: AgentSession, executorKey: string): Promise<void>;
  stop(environmentId: string): Promise<void>;
}

export function selectBackendKind(): 'kvm' | 'lume' {
  if (process.platform === 'darwin') return 'lume';
  if (process.platform === 'linux') return 'kvm';
  throw new Error(`no microVM backend for ${process.platform}. Use --driver process.`);
}

function execServerScript(opts: {
  executorKey: string;
  fixtures: string;
  remote: string;
  environmentId: string;
  browserMode: string;
}): string {
  return [
    '#!/bin/bash',
    'set -euo pipefail',
    'export PATH=/usr/local/bin:$PATH',
    `export CODEX_API_KEY=${shellQuote(opts.executorKey)}`,
    `export FIXTURES_URL=${shellQuote(opts.fixtures)}`,
    'export PLAYWRIGHT_BROWSERS_PATH=/opt/ms-playwright',
    'export DISPLAY=:0',
    'export BROWSER_HEADLESS=false',
    `export BROWSER_MODE=${shellQuote(opts.browserMode)}`,
    'if ! xdpyinfo >/dev/null 2>&1; then',
    '  for _ in $(seq 1 45); do xdpyinfo >/dev/null 2>&1 && break; sleep 1; done',
    'fi',
    'cd /workspace',
    'setsid /workspace/bin/codex exec-server \\',
    `  --remote ${shellQuote(opts.remote)} \\`,
    `  --environment-id ${shellQuote(opts.environmentId)} \\`,
    '  >/tmp/exec-server.log 2>&1 </dev/null &',
    'sleep 0.3',
    'exit 0',
    '',
  ].join('\n');
}

function displayOf(session: AgentSession): { guestId: string; jobName?: string } {
  const job = session.metadata.job as { name?: string } | undefined;
  return {
    guestId: String(session.metadata.guest_id || session.environment.id),
    jobName: job?.name,
  };
}

export class KvmBackend implements ComputeBackend {
  readonly name = 'kvm' as const;
  readonly guestHost: string;
  private dedup = new DedupedCompute();
  private stopping = new Set<string>();
  private guests = new Map<string, { proc: ChildProcess; overlay: string; guestId: string }>();
  private nextPort = 25100;
  private nextVnc = 5910;
  private accel: 'kvm' | 'tcg' | null = null;

  constructor(
    private root: string,
    private memoryMb = 1536,
    guestHost = '10.0.2.2',
    private hooks: DisplayHooks = {},
  ) {
    this.guestHost = guestHost;
  }

  ensure(session: AgentSession, executorKey: string): Promise<void> {
    const id = session.environment.id;
    return this.dedup.ensure(id, () => this.boot(session, executorKey));
  }

  async stop(environmentId: string): Promise<void> {
    this.stopping.add(environmentId);
    this.dedup.forget(environmentId);
    const guest = this.guests.get(environmentId);
    this.guests.delete(environmentId);
    if (guest) this.hooks.onDisplayEnd?.(guest.guestId);
    if (!guest) return;
    if (guest.proc.exitCode === null && !guest.proc.killed) guest.proc.kill('SIGTERM');
    await new Promise<void>((resolve) => {
      if (guest.proc.exitCode !== null) {
        resolve();
        return;
      }
      const timer = setTimeout(() => {
        if (guest.proc.exitCode === null) guest.proc.kill('SIGKILL');
      }, 5_000);
      guest.proc.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  private async boot(session: AgentSession, executorKey: string): Promise<void> {
    const id = session.environment.id;
    if (this.stopping.has(id)) throw new Error(`environment ${id} is stopping`);
    const image = join(this.root, 'images/guest-base.qcow2');
    const ready = join(this.root, 'images/guest-base.ready');
    const key = join(this.root, 'images/guest_ed25519');
    if (!existsSync(image) || !existsSync(ready) || !existsSync(key)) {
      throw new Error(`guest image is not built (${image}). Run ./scripts/build-guest-image.sh`);
    }
    const accel = await this.resolveAccel(image);

    const dir = join(this.root, 'runs/overlays');
    mkdirSync(dir, { recursive: true });
    const overlay = join(dir, `${id}.qcow2`);
    const serial = join(this.root, 'runs', `${id}.serial.log`);
    const created = await run('qemu-img', ['create', '-f', 'qcow2', '-b', image, '-F', 'qcow2', overlay]);
    if (created.code !== 0) throw new Error(`qemu-img create failed: ${created.stderr}`);

    const sshPort = this.nextPort++;
    const vncPort = this.nextVnc++;
    const shown = displayOf(session);
    const args = buildQemuArgs({
      accel,
      memoryMb: this.memoryMb,
      overlay,
      sshPort,
      vncPort,
      serialLog: serial,
    });
    const proc = spawn('qemu-system-x86_64', args, { stdio: 'ignore' });
    this.guests.set(id, { proc, overlay, guestId: shown.guestId });
    this.hooks.onDisplay?.({ guestId: shown.guestId, vncPort, jobName: shown.jobName });
    proc.on('exit', (code) => {
      if (this.guests.get(id)?.proc === proc) {
        console.error(`qemu ${id} exited (${code})`);
      }
    });
    console.log(`qemu ${id} accel=${accel} ssh=127.0.0.1:${sshPort} vnc=127.0.0.1:${vncPort}`);

    try {
      await this.waitForSsh(sshPort, key, proc, accel === 'kvm' ? 120_000 : 300_000);
      if (this.stopping.has(id)) throw new Error(`environment ${id} stopped during boot`);
      const fixtures = String(session.metadata.fixtures_url || `http://${this.guestHost}:4317`);
      const script = execServerScript({
        executorKey,
        fixtures,
        remote: session.environment.remote_url,
        environmentId: id,
        browserMode: String(session.metadata.browser_mode || 'chromium'),
      });
      const started = await run('ssh', [...sshArgs(sshPort, key), 'lume@127.0.0.1', 'bash', '-s'], script);
      if (started.code !== 0) {
        throw new Error(`failed to start codex exec-server: ${started.stderr || started.stdout}`);
      }
    } catch (error) {
      await this.stop(id);
      throw error;
    }
  }

  private async resolveAccel(image: string): Promise<'kvm' | 'tcg'> {
    if (this.accel) return this.accel;
    const fromEnv = process.env.QEMU_ACCEL;
    if (fromEnv === 'kvm' || fromEnv === 'tcg') {
      this.accel = fromEnv;
      return fromEnv;
    }
    const marker = join(this.root, 'images/qemu-accel');
    if (existsSync(marker)) {
      const value = readFileSync(marker, 'utf8').trim();
      if (value === 'kvm' || value === 'tcg') {
        this.accel = value;
        return value;
      }
    }
    if (!existsSync('/dev/kvm')) {
      this.accel = 'tcg';
      return 'tcg';
    }
    const probe = join(this.root, 'runs/accel-probe.qcow2');
    const log = join(this.root, 'runs/accel-probe.log');
    mkdirSync(join(this.root, 'runs'), { recursive: true });
    const created = await run('qemu-img', ['create', '-f', 'qcow2', '-b', image, '-F', 'qcow2', probe]);
    if (created.code !== 0) {
      this.accel = 'tcg';
      return 'tcg';
    }
    const logFd = openSync(log, 'w');
    const proc = spawn('qemu-system-x86_64', [
      '-enable-kvm', '-cpu', 'host', '-m', '256', '-smp', '1', '-nographic', '-no-reboot',
      '-drive', `file=${probe},if=virtio,format=qcow2`,
    ], { stdio: ['ignore', logFd, logFd] });
    await new Promise((resolve) => setTimeout(resolve, 8_000));
    if (proc.exitCode === null) proc.kill('SIGKILL');
    await new Promise((resolve) => {
      if (proc.exitCode !== null) resolve(undefined);
      else proc.once('exit', () => resolve(undefined));
    });
    const text = existsSync(log) ? readFileSync(log, 'utf8') : '';
    this.accel = text.includes('SeaBIOS') ? 'kvm' : 'tcg';
    if (this.accel === 'tcg') {
      console.error('kvm did not reach SeaBIOS on this host. Booting guests with tcg.');
    }
    return this.accel;
  }

  private async waitForSsh(port: number, key: string, proc: ChildProcess, timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (proc.exitCode !== null) throw new Error(`qemu exited (${proc.exitCode}) before ssh`);
      const probe = await run('ssh', [...sshArgs(port, key), 'lume@127.0.0.1', 'true']);
      if (probe.code === 0) return;
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    throw new Error(`ssh to guest on port ${port} timed out`);
  }
}

export class LumeBackend implements ComputeBackend {
  readonly name = 'lume' as const;
  readonly guestHost: string;
  private dedup = new DedupedCompute();
  private names = new Map<string, string>();
  private guestIds = new Map<string, string>();
  private nextVnc = 5910;

  constructor(
    guestHost = process.env.LUME_HOST_IP || '192.168.64.1',
    private hooks: DisplayHooks = {},
  ) {
    this.guestHost = guestHost;
  }

  ensure(session: AgentSession, executorKey: string): Promise<void> {
    return this.dedup.ensure(session.environment.id, () => this.boot(session, executorKey));
  }

  async stop(environmentId: string): Promise<void> {
    this.dedup.forget(environmentId);
    const name = this.names.get(environmentId);
    const guestId = this.guestIds.get(environmentId);
    this.names.delete(environmentId);
    this.guestIds.delete(environmentId);
    if (guestId) this.hooks.onDisplayEnd?.(guestId);
    if (!name) return;
    const stopped = await run('lume', lumeStopArgs(name));
    if (stopped.code !== 0) {
      throw new Error(`lume stop ${name} failed: ${stopped.stderr || stopped.stdout}`);
    }
  }

  private async boot(session: AgentSession, executorKey: string): Promise<void> {
    const which = await run('bash', ['-lc', 'command -v lume']);
    if (which.code !== 0) {
      throw new Error(
        'lume is not on PATH. On Apple Silicon, lume drives Virtualization.framework '
        + '(https://github.com/trycua/lume). This process will not pretend a VM started.',
      );
    }
    const name = `workshop-${session.environment.id.replace(/[^a-z0-9]/gi, '').slice(-12)}`;
    this.names.set(session.environment.id, name);
    const created = await run('lume', lumeCreateArgs(name));
    if (created.code !== 0 && !/already exists/i.test(created.stderr + created.stdout)) {
      throw new Error(`lume create failed: ${created.stderr || created.stdout}`);
    }
    const vncPort = this.nextVnc++;
    const started = await run('lume', lumeRunArgs(name, vncPort));
    if (started.code !== 0 && !/already running/i.test(started.stderr + started.stdout)) {
      throw new Error(`lume run failed: ${started.stderr || started.stdout}`);
    }
    const shown = displayOf(session);
    this.guestIds.set(session.environment.id, shown.guestId);
    const password = await this.readVncPassword(name);
    this.hooks.onDisplay?.({ guestId: shown.guestId, vncPort, vncPassword: password, jobName: shown.jobName });
    const fixtures = String(session.metadata.fixtures_url || `http://${this.guestHost}:4317`);
    const script = execServerScript({
      executorKey,
      fixtures,
      remote: session.environment.remote_url,
      environmentId: session.environment.id,
      browserMode: String(session.metadata.browser_mode || 'chromium'),
    });
    const ssh = await run('lume', ['ssh', name, '--', 'bash', '-s'], script);
    if (ssh.code !== 0) throw new Error(`lume ssh failed: ${ssh.stderr || ssh.stdout}`);
  }

  private async readVncPassword(name: string): Promise<string | undefined> {
    const got = await run('lume', ['get', name]);
    if (got.code !== 0) return undefined;
    const fromUrl = got.stdout.match(/vnc:\/\/(?:[^:@/\s]*:([^@/\s]+)@)?[\w.-]+:\d+/);
    if (fromUrl?.[1]) return decodeURIComponent(fromUrl[1]);
    const fromJson = got.stdout.match(/"vncPassword"\s*:\s*"([^"]*)"/);
    return fromJson?.[1] || undefined;
  }
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function guestFixturesUrl(fixturesUrl: string, guestHost: string): string {
  const url = new URL(fixturesUrl);
  url.hostname = guestHost;
  return url.toString().replace(/\/$/, '');
}

