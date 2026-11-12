import { spawn } from 'child_process';
import { existsSync } from 'fs';
import { join } from 'path';
import type { AgentSession } from '../../packages/agents-api/src/types.js';
import { DedupedCompute } from '../../packages/agents-api/src/dedup.js';

export interface NekoDisplayInfo {
  guestId: string;
  jobName?: string;
  nekoUrl: string;
  httpPort?: number;
  vncPort?: number;
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
  httpPort: number;
  vncPort: number;
  udpMux: number;
  tcpMux: number;
  display: string;
  repoRoot: string;
}

const PREFERRED_IMAGE = 'workshop-neko:desk';
const FALLBACK_IMAGE = 'ghcr.io/m1k1o/neko/xfce:latest';

export function nekoContainerName(environmentId: string): string {
  const slug = environmentId.replace(/[^a-zA-Z0-9_.-]/g, '').slice(-32);
  return `neko-${slug || 'desk'}`;
}

export function nekoRunArgs(spec: NekoRunSpec): string[] {
  const epr = `${spec.udpMux}-${spec.udpMux + 8}`;
  const mac = process.platform === 'darwin';
  // Docker Desktop and Podman Machine do not give a Linux container the
  // macOS loopback. Publish ports on the Mac instead of using host networking.
  const network = mac
    ? [
        '-p', `127.0.0.1:${spec.httpPort}:${spec.httpPort}`,
        '-p', `127.0.0.1:${spec.vncPort}:${spec.vncPort}`,
        '-p', `0.0.0.0:${spec.udpMux}:${spec.udpMux}/udp`,
        '-p', `0.0.0.0:${spec.tcpMux}:${spec.tcpMux}/tcp`,
      ]
    : ['--network', 'host'];
  const bind = mac ? `0.0.0.0:${spec.httpPort}` : spec.bind;
  const natIp = mac ? (process.env.NEKO_NAT_IP || '127.0.0.1') : spec.natIp;
  const openclaw = existsSync('/opt/openclaw') ? ['-v', '/opt/openclaw:/opt/openclaw:ro'] : [];
  return [
    'run', '-d',
    '--name', spec.name,
    ...network,
    '--shm-size', '2g',
    ...openclaw,
    '-e', `OPENCLAW_NODE_NAME=${spec.name}`,
    '-e', `OPENCLAW_GATEWAY_URL=${process.env.OPENCLAW_GATEWAY_URL || 'ws://host.docker.internal:18789'}`,
    '-e', `DISPLAY=${spec.display}`,
    '-e', `NEKO_SERVER_BIND=${bind}`,
    '-e', `NEKO_SERVER_PATH_PREFIX=/neko/${spec.name}`,
    '-e', `WORKSHOP_FIXTURES_URL=${process.env.WORKSHOP_FIXTURES_URL || (mac ? 'http://host.docker.internal:4317' : 'http://127.0.0.1:4317')}`,
    '-e', `NEKO_VNC_PORT=${spec.vncPort}`,
    '-e', 'NEKO_DESKTOP_SCREEN=1280x800@30',
    '-e', 'NEKO_MEMBER_MULTIUSER_USER_PASSWORD=neko',
    '-e', 'NEKO_MEMBER_MULTIUSER_ADMIN_PASSWORD=admin',
    '-e', `NEKO_WEBRTC_EPR=${epr}`,
    '-e', `NEKO_WEBRTC_UDPMUX=${spec.udpMux}`,
    '-e', `NEKO_WEBRTC_TCPMUX=${spec.tcpMux}`,
    '-e', 'NEKO_WEBRTC_ICELITE=true',
    '-e', 'NEKO_WEBRTC_ICETRICKLE=false',
    '-e', `NEKO_WEBRTC_NAT1TO1=${natIp}`,
    '-e', 'NEKO_WEBRTC_ICESERVERS_FRONTEND=[]',
    '-e', 'NEKO_WEBRTC_ICESERVERS_BACKEND=[]',
    '-e', 'NEKO_SESSION_COOKIE_SECURE=false',
    '-e', 'NEKO_IMPLICIT_CONTROL=true',
    '-e', 'NEKO_CONTROL_PROTECTION=false',
    '-e', `CUA_DRIVER_PERMISSION_MODE=${process.env.CUA_DRIVER_PERMISSION_MODE || 'unrestricted'}`,
    spec.image,
  ];
}

export function resolveNekoImage(listed: string[], override = process.env.NEKO_IMAGE): string {
  if (override) return override;
  const preferred = listed.find((row) => row === PREFERRED_IMAGE || row.endsWith(`/${PREFERRED_IMAGE}`));
  if (preferred) return preferred;
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
  private nextVnc = 5960;
  private nextUdp = 53200;
  private nextTcp = 53300;

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
    if (process.env.KEEP_GUEST_CONTAINERS === '1') {
      console.log(`keeping neko ${row.container} (KEEP_GUEST_CONTAINERS=1)`);
      return;
    }
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
    const vncPort = this.nextVnc++;
    const udpMux = this.nextUdp;
    this.nextUdp += 10;
    const tcpMux = this.nextTcp++;
    const display = ':99.0';
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
      httpPort,
      vncPort,
      udpMux,
      tcpMux,
      display,
      repoRoot: this.root,
    }));
    if (started.code !== 0) {
      throw new Error(`docker run ${name} failed: ${started.stderr || started.stdout}`);
    }
    console.log(`neko ${id} container=${name} http://${bind} vnc=http://127.0.0.1:${vncPort} udp=${udpMux} tcp=${tcpMux} nat=${natIp} image=${image}`);
    try {
      if (this.stopping.has(id)) throw new Error(`environment ${id} stopped during boot`);
      await this.waitForHttp(`http://${bind}/neko/${name}/`, 90_000);
      await this.installSkin(docker, name);
      // The dashboard proxies neko's HTTP/WebSocket on its own origin and
      // embeds the WebRTC client. Keep the VNC port for the fallback bridge.
      this.hooks.onDisplay?.({
        guestId,
        jobName: job?.name,
        nekoUrl: `/neko/${name}/?usr=neko&pwd=neko&embed=1`,
        httpPort,
        vncPort,
        container: name,
      });
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
    const fixtures = this.containerUrl(String(session.metadata.fixtures_url || 'http://127.0.0.1:4317'));
    // The server sends metadata.fixtures_url in the run_job command, and
    // exec-server prefers the command field over the process env.
    session.metadata.fixtures_url = fixtures;
    const browserMode = String(session.metadata.browser_mode || 'chromium');
    const headless = process.env.BROWSER_HEADLESS || 'false';
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
      '-e', 'HOME=/root',
      '-e', `FIXTURES_URL=${fixtures}`,
      '-e', `BROWSER_MODE=${browserMode}`,
      '-e', `BROWSER_HEADLESS=${headless}`,
      ...(process.env.OPENAI_API_KEY ? ['-e', `OPENAI_API_KEY=${process.env.OPENAI_API_KEY}`] : []),
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
      '-e', `OPENCLAW_GATEWAY_URL=${process.env.OPENCLAW_GATEWAY_URL || 'ws://host.docker.internal:18789'}`,
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
    // Podman Machine / Docker Desktop publish ports to the Mac. The browser
    // and the ICE candidate use loopback, not the Linux host network.
    if (process.platform === 'darwin') return '127.0.0.1';
    const route = await run('ip', ['-4', 'route', 'get', '1.1.1.1']);
    const match = route.stdout.match(/\bsrc\s+(\d+\.\d+\.\d+\.\d+)/);
    return match?.[1] || '127.0.0.1';
  }

  private containerHost(): string {
    if (process.env.CONTAINER_HOST) return process.env.CONTAINER_HOST;
    if (process.env.AGENTS_PUBLIC_HOST) return process.env.AGENTS_PUBLIC_HOST;
    return process.platform === 'darwin' ? 'host.docker.internal' : '127.0.0.1';
  }

  private containerUrl(url: string): string {
    if (process.platform !== 'darwin') return url;
    return url.replace(/\/\/(?:127\.0\.0\.1|localhost):/, `//${this.containerHost()}:`);
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
