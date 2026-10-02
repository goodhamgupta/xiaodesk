import { spawn } from 'child_process';
import { existsSync } from 'fs';
import { join } from 'path';
import type { AgentSession } from '../../packages/agents-api/src/types.js';
import { DedupedCompute } from '../../packages/agents-api/src/dedup.js';

export interface NekoDisplayInfo {
  guestId: string;
  jobName?: string;
  nekoUrl: string;
  container: string;
}

export interface NekoHooks {
  onDisplay?(info: NekoDisplayInfo): void;
  onDisplayEnd?(guestId: string): void;
}

export interface NekoRunSpec {
  name: string;
  image: string;
  bind: string;
  natIp: string;
  udpMux: number;
  tcpMux: number;
  display: string;
  repoRoot: string;
  nodePath: string;
}

const PREFERRED_IMAGE = 'workshop-neko:desk';
const FALLBACK_IMAGE = 'ghcr.io/m1k1o/neko/xfce:latest';

export function nekoContainerName(environmentId: string): string {
  const slug = environmentId.replace(/[^a-zA-Z0-9_.-]/g, '').slice(-32);
  return `neko-${slug || 'desk'}`;
}

export function nekoRunArgs(spec: NekoRunSpec): string[] {
  const epr = `${spec.udpMux}-${spec.udpMux + 8}`;
  return [
    'run', '-d',
    '--name', spec.name,
    '--network', 'host',
    '--shm-size', '2g',
    '-v', `${spec.repoRoot}:/workspace`,
    '-v', `${spec.nodePath}:/usr/local/bin/node:ro`,
    '-v', '/opt/openclaw:/opt/openclaw:ro',
    '-e', `OPENCLAW_NODE_NAME=${spec.name}`,
    '-e', `DISPLAY=${spec.display}`,
    '-e', `NEKO_SERVER_BIND=${spec.bind}`,
    '-e', 'NEKO_DESKTOP_SCREEN=1280x800@30',
    '-e', 'NEKO_MEMBER_MULTIUSER_USER_PASSWORD=neko',
    '-e', 'NEKO_MEMBER_MULTIUSER_ADMIN_PASSWORD=admin',
    '-e', `NEKO_WEBRTC_EPR=${epr}`,
    '-e', `NEKO_WEBRTC_UDPMUX=${spec.udpMux}`,
    '-e', `NEKO_WEBRTC_TCPMUX=${spec.tcpMux}`,
    '-e', 'NEKO_WEBRTC_ICELITE=true',
    '-e', 'NEKO_WEBRTC_ICETRICKLE=false',
    '-e', `NEKO_WEBRTC_NAT1TO1=${spec.natIp}`,
    '-e', 'NEKO_WEBRTC_ICESERVERS_FRONTEND=[]',
    '-e', 'NEKO_WEBRTC_ICESERVERS_BACKEND=[]',
    '-e', 'NEKO_SESSION_COOKIE_SECURE=false',
    spec.image,
  ];
}

export function resolveNekoImage(listed: string[], override = process.env.NEKO_IMAGE): string {
  if (override) return override;
  if (listed.includes(PREFERRED_IMAGE)) return PREFERRED_IMAGE;
  return FALLBACK_IMAGE;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function run(cmd: string, args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => { stdout += chunk; });
    child.stderr.on('data', (chunk: string) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

export class NekoBackend {
  readonly name = 'neko' as const;
  readonly guestHost = '127.0.0.1';
  private dedup = new DedupedCompute();
  private stopping = new Set<string>();
  private names = new Map<string, { container: string; guestId: string }>();
  private dockerPrefix: string[] | null = null;
  private nextHttp = 8361;
  private nextUdp = 53200;
  private nextTcp = 53300;
  private nextDisplay = 120;

  constructor(
    private root: string,
    private hooks: NekoHooks = {},
  ) {}

  ensure(session: AgentSession, executorKey: string): Promise<void> {
    return this.dedup.ensure(session.environment.id, () => this.boot(session, executorKey));
  }

  async stop(environmentId: string): Promise<void> {
    this.stopping.add(environmentId);
    this.dedup.forget(environmentId);
    const row = this.names.get(environmentId);
    this.names.delete(environmentId);
    if (row) this.hooks.onDisplayEnd?.(row.guestId);
    if (!row) return;
    const docker = await this.docker();
    const removed = await this.dockerRun(docker, ['rm', '-f', row.container]);
    if (removed.code !== 0 && !/no such container/i.test(removed.stderr)) {
      throw new Error(`docker rm ${row.container} failed: ${removed.stderr || removed.stdout}`);
    }
  }

  private async boot(session: AgentSession, executorKey: string): Promise<void> {
    const id = session.environment.id;
    if (this.stopping.has(id)) throw new Error(`environment ${id} is stopping`);
    const docker = await this.docker();
    const listed = await this.dockerRun(docker, ['images', '--format', '{{.Repository}}:{{.Tag}}']);
    if (listed.code !== 0) throw new Error(`docker images failed: ${listed.stderr || listed.stdout}`);
    const image = resolveNekoImage(listed.stdout.split('\n').map((line) => line.trim()).filter(Boolean));
    const name = nekoContainerName(id);
    const httpPort = this.nextHttp++;
    const udpMux = this.nextUdp;
    this.nextUdp += 10;
    const tcpMux = this.nextTcp++;
    const display = `:${this.nextDisplay++}.0`;
    const bind = `127.0.0.1:${httpPort}`;
    const natIp = await this.natIp();
    const job = session.metadata.job as { name?: string } | undefined;
    const guestId = String(session.metadata.guest_id || id);
    this.names.set(id, { container: name, guestId });

    await this.dockerRun(docker, ['rm', '-f', name]);
    const started = await this.dockerRun(docker, nekoRunArgs({
      name,
      image,
      bind,
      natIp,
      udpMux,
      tcpMux,
      display,
      repoRoot: this.root,
      nodePath: process.execPath,
    }));
    if (started.code !== 0) {
      throw new Error(`docker run ${name} failed: ${started.stderr || started.stdout}`);
    }
    console.log(`neko ${id} container=${name} http://${bind} udp=${udpMux} tcp=${tcpMux} nat=${natIp} image=${image}`);
    try {
      if (this.stopping.has(id)) throw new Error(`environment ${id} stopped during boot`);
      await this.waitForHttp(`http://${bind}/`, 90_000);
      await this.installSkin(docker, name);
      const nekoUrl = `http://${bind}/?usr=neko&pwd=neko`;
      this.hooks.onDisplay?.({ guestId, jobName: job?.name, nekoUrl, container: name });
      await this.startExecutor(docker, name, session, executorKey, display);
      await this.waitForRegistered(docker, name, 45_000);
      await this.startOpenClaw(docker, name, display);
    } catch (error) {
      await this.stop(id);
      throw error;
    }
  }

  private async installSkin(docker: string[], name: string): Promise<void> {
    const css = join(this.root, 'scripts/neko/ui/desk.css');
    const js = join(this.root, 'scripts/neko/ui/desk.js');
    const cssCopy = await this.dockerRun(docker, ['cp', css, `${name}:/var/www/desk.css`]);
    if (cssCopy.code !== 0) throw new Error(`install desk.css failed: ${cssCopy.stderr}`);
    const jsCopy = await this.dockerRun(docker, ['cp', js, `${name}:/var/www/desk.js`]);
    if (jsCopy.code !== 0) throw new Error(`install desk.js failed: ${jsCopy.stderr}`);
    const boot = `window.DESK_CONTAINER=${JSON.stringify(name)};`;
    const stamped = await this.dockerRun(docker, ['exec', name, 'sh', '-c', [
      `printf %s ${shellQuote(boot)} > /var/www/desk-boot.js`,
      'grep -q desk-boot.js /var/www/index.html || sed -i \'s#</body>#<script src="desk-boot.js"></script><link rel="stylesheet" href="desk.css?v=3"><script src="desk.js?v=3"></script></body>#\' /var/www/index.html',
    ].join(' && ')]);
    if (stamped.code !== 0) throw new Error(`install neko skin failed: ${stamped.stderr || stamped.stdout}`);
  }

  private async startExecutor(docker: string[], name: string, session: AgentSession, executorKey: string, display: string): Promise<void> {
    const fixtures = String(session.metadata.fixtures_url || 'http://127.0.0.1:4317');
    const browserMode = String(session.metadata.browser_mode || 'chromium');
    const command = [
      'exec /workspace/bin/codex exec-server',
      `--remote ${shellQuote(session.environment.remote_url)}`,
      `--environment-id ${shellQuote(session.environment.id)}`,
      '>/tmp/exec-server.log 2>&1',
    ].join(' ');
    const started = await this.dockerRun(docker, [
      'exec', '-d',
      '-u', 'root',
      '-w', '/workspace',
      '-e', `CODEX_API_KEY=${executorKey}`,
      '-e', `DISPLAY=${display}`,
      '-e', 'PATH=/usr/local/bin:/usr/bin:/bin',
      '-e', `FIXTURES_URL=${fixtures}`,
      '-e', `BROWSER_MODE=${browserMode}`,
      '-e', 'BROWSER_HEADLESS=true',
      name,
      'sh', '-lc', command,
    ]);
    if (started.code !== 0) {
      throw new Error(`failed to start codex exec-server: ${started.stderr || started.stdout}`);
    }
  }

  private async startOpenClaw(docker: string[], name: string, display: string): Promise<void> {
    if (!existsSync('/opt/openclaw/bin/openclaw')) return;
    const started = await this.dockerRun(docker, [
      'exec', '-d',
      '-u', 'root',
      '-e', `OPENCLAW_NODE_NAME=${name}`,
      '-e', `DISPLAY=${display}`,
      name,
      'bash', '/workspace/scripts/neko/openclaw-node.sh',
    ]);
    if (started.code !== 0) {
      console.log(`openclaw node ${name} did not start: ${started.stderr || started.stdout}`);
    }
  }

  private async waitForRegistered(docker: string[], name: string, timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    let last = '';
    while (Date.now() < deadline) {
      const log = await this.dockerRun(docker, ['exec', name, 'sh', '-c', 'tail -n 50 /tmp/exec-server.log 2>/dev/null || true']);
      last = `${log.stdout}\n${log.stderr}`.trim();
      if (/registered /.test(last)) return;
      await sleep(500);
    }
    throw new Error(`codex exec-server did not register in ${name}: ${last || 'no log'}`);
  }

  private async waitForHttp(url: string, timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    let last = 'no response';
    while (Date.now() < deadline) {
      try {
        const response = await fetch(url, { signal: AbortSignal.timeout(1500) });
        if (response.ok) return;
        last = `HTTP ${response.status}`;
      } catch (error) {
        last = error instanceof Error ? error.message : String(error);
      }
      await sleep(500);
    }
    throw new Error(`neko ${url} did not become ready: ${last}`);
  }

  private async natIp(): Promise<string> {
    if (process.env.NEKO_NAT_IP) return process.env.NEKO_NAT_IP;
    const route = await run('ip', ['-4', 'route', 'get', '1.1.1.1']);
    const match = route.stdout.match(/\bsrc\s+(\d+\.\d+\.\d+\.\d+)/);
    return match?.[1] || '127.0.0.1';
  }

  private async docker(): Promise<string[]> {
    if (this.dockerPrefix) return this.dockerPrefix;
    const bin = process.env.DOCKER_BIN || 'docker';
    const probe = await run(bin, ['info']);
    this.dockerPrefix = probe.code === 0 ? [bin] : ['sudo', '-n', bin];
    return this.dockerPrefix;
  }

  private dockerRun(prefix: string[], args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
    const [cmd, ...rest] = prefix;
    return run(cmd, [...rest, ...args]);
  }
}
