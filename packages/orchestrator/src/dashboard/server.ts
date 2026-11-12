import { spawn } from 'node:child_process';
import { connect as connectTcp } from 'net';
import { createServer as createHttpServer, request as httpRequest, type IncomingMessage, type Server, type ServerResponse } from 'http';
import { mkdirSync, readFileSync, readdirSync, statSync, existsSync } from 'fs';
import { homedir } from 'os';
import { basename, dirname, join } from 'path';
import { fileURLToPath } from 'url';
import express, { type Response } from 'express';
import { WebSocketServer, WebSocket, type RawData } from 'ws';
import type { Duplex } from 'stream';
import type { DashboardState, VmDisplay } from '../types.js';
import { dashboardPage } from './page.js';
import { nekoPage } from './neko-page.js';
import { listSnapshots, loadVm, saveVm } from '../vm/qmp.js';
import { startVncRecording, type RecordingHandle } from '../vm/vnc-record.js';
import { runDeskChat, runGuestDock, type DeskEvent } from '../computer/desk.js';
import { planFleet } from '../computer/fleet.js';
import { runNekoChat, runNekoDock, runNekoUrl, sendNekoEmote } from '../computer/neko.js';
import { gatewayUp, listNodes, nodeState, postDeskHook, runDeskTool } from '../computer/openclaw.js';
import { planDesk } from '../computer/plan.js';
import { codexDeskAvailable, runCodexDesk } from '../computer/codex.js';

export interface DashboardOptions {
  recordingsDir?: string;
  controlFile?: string;
  repoRoot?: string;
}

interface ChatLine {
  role: 'user' | 'assistant' | 'reasoning' | 'action' | 'error';
  text: string;
  file?: string;
}

const novncRoot = join(dirname(fileURLToPath(import.meta.url)), '../../vendor/novnc');

function fail(res: Response, error: unknown): void {
  const status = typeof error === 'object' && error && 'status' in error ? Number((error as { status: number }).status) : 500;
  const message = error instanceof Error ? error.message : 'request failed';
  res.status(status || 500).json({ error: message });
}

interface RegisteredDisplay extends VmDisplay {
  vncPort: number;
  httpPort?: number;
}

export class DashboardServer {
  private app = express();
  private server: Server | null = null;
  private wss: WebSocketServer | null = null;
  private clients: Set<WebSocket> = new Set();
  private latestState: DashboardState | null = null;
  private displays = new Map<string, RegisteredDisplay>();

  private recording: RecordingHandle | null = null;
  private chats = new Map<string, ChatLine[]>();
  private deskBusy = new Set<string>();
  private nekoTargets = new Map<string, { container: string; wsUrl: string }>();
  private inboxLines = 0;
  private inboxTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private port: number = 4200,
    private options: DashboardOptions = {},
  ) {
    this.setupRoutes();
  }

  private setupRoutes(): void {
    // Proxy neko's HTTP surface before express.json() consumes request bodies.
    this.app.get('/neko/:id', (req, res, next) => {
      if (req.path.endsWith('/')) {
        next();
        return;
      }
      res.redirect(301, `/neko/${encodeURIComponent(String(req.params.id))}/`);
    });
    this.app.use('/neko/:id', (req, res) => {
      this.proxyNekoHttp(req, res).catch((error) => fail(res, error));
    });
    this.app.use(express.json({ limit: '32kb' }));
    this.app.use('/api/neko', (req, res, next) => {
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Headers', 'content-type');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      if (req.method === 'OPTIONS') {
        res.status(204).end();
        return;
      }
      next();
    });
    this.app.use('/novnc', express.static(novncRoot));

    this.app.get('/', (_req, res) => {
      res.type('html').send(nekoPage());
    });

    this.app.get('/vms', (_req, res) => {
      res.type('html').send(dashboardPage());
    });

    this.app.get('/api/neko', (_req, res) => {
      res.json({
        url: process.env.NEKO_URL || 'http://127.0.0.1:8341',
        container: process.env.NEKO_NAME || 'workshop-neko',
        display: process.env.NEKO_DISPLAY || ':99.0',
        user: 'neko',
        password: 'neko',
        admin_password: 'admin',
      });
    });

    this.app.get('/api/openclaw', (_req, res) => {
      this.openClawStatus().then(
        (body) => res.json(body),
        (error) => fail(res, error),
      );
    });

    this.app.get('/api/codex', (_req, res) => {
      this.codexStatus().then(
        (body) => res.json(body),
        (error) => fail(res, error),
      );
    });

    this.app.get('/api/neko/chat', (req, res) => {
      const guest = String(req.query.guest || '');
      const key = !guest || guest === 'workshop-neko' ? 'neko' : guest;
      res.json({ messages: this.chats.get(key) || [] });
    });

    this.app.post('/api/neko/dock', (req, res) => {
      const op = String(req.body?.op || '');
      const mapped = op === 'browser' ? 'chrome' : op;
      if (mapped !== 'chrome' && mapped !== 'terminal' && mapped !== 'files') {
        res.status(400).json({ error: 'op must be browser, terminal, or files' });
        return;
      }
      let container = process.env.NEKO_NAME || 'workshop-neko';
      try {
        container = this.nekoContainer(String(req.body?.container || ''));
      } catch (error) {
        fail(res, error);
        return;
      }
      if (this.deskBusy.has(container)) {
        res.status(409).json({ error: 'this desktop is already working on a message' });
        return;
      }
      this.deskBusy.add(container);
      runNekoDock(this.repoRoot(), mapped, container).then(
        (result) => {
          this.deskBusy.delete(container);
          if (!result.ok) res.status(502).json({ error: result.detail });
          else res.json(result);
        },
        (error) => {
          this.deskBusy.delete(container);
          fail(res, error);
        },
      );
    });

    this.app.post('/api/neko/fixtures', (req, res) => {
      let container = process.env.NEKO_NAME || 'workshop-neko';
      try {
        container = this.nekoContainer(String(req.body?.container || ''));
      } catch (error) {
        fail(res, error);
        return;
      }
      if (this.deskBusy.has(container)) {
        res.status(409).json({ error: 'this desktop is already working on a message' });
        return;
      }
      const url = process.env.WORKSHOP_FIXTURES_URL
        || (process.platform === 'darwin' ? 'http://host.docker.internal:4317' : 'http://127.0.0.1:4317');
      this.deskBusy.add(container);
      runNekoUrl(this.repoRoot(), url, container).then(
        (result) => {
          this.deskBusy.delete(container);
          if (!result.ok) res.status(502).json({ error: result.detail });
          else res.json(result);
        },
        (error) => {
          this.deskBusy.delete(container);
          fail(res, error);
        },
      );
    });

    this.app.post('/api/neko/chat', (req, res) => {
      this.streamNekoChat(String(req.body?.message || ''), String(req.body?.guest_id || ''), res).catch((error) => {
        if (!res.headersSent) fail(res, error);
        else res.end();
      });
    });

    this.app.get('/events', (req, res) => {
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.flushHeaders();
      const send = () => {
        if (this.latestState) res.write(`data: ${JSON.stringify(this.publicState(this.latestState))}\n\n`);
      };
      send();
      const timer = setInterval(send, 1000);
      req.on('close', () => clearInterval(timer));
    });

    this.app.get('/api/state', (_req, res) => {
      if (this.latestState) {
        res.json(this.publicState(this.latestState));
      } else {
        res.status(503).json({ error: 'No state available' });
      }
    });

    this.app.get('/api/recordings', (_req, res) => {
      res.json(this.listRecordings());
    });

    this.app.get('/api/recordings/:file', (req, res) => {
      const file = this.recordingPath(req.params.file);
      if (!file) {
        res.status(404).json({ error: 'recording not found' });
        return;
      }
      res.sendFile(file);
    });

    this.app.post('/api/vms/:id/dock', (req, res) => {
      const op = String(req.body?.op || '');
      const mapped = op === 'browser' ? 'chrome' : op;
      if (mapped !== 'chrome' && mapped !== 'terminal' && mapped !== 'files') {
        res.status(400).json({ error: 'op must be browser, terminal, or files' });
        return;
      }
      let guestId = '';
      try {
        guestId = this.guestId(req.params.id);
      } catch (error) {
        fail(res, error);
        return;
      }
      const display = this.displays.get(guestId);
      if (!display) {
        res.status(404).json({ error: 'guest display is not registered' });
        return;
      }
      if (display.kind === 'neko') {
        if (this.deskBusy.has(guestId)) {
          res.status(409).json({ error: 'this desktop is already working on a message' });
          return;
        }
        this.deskBusy.add(guestId);
        const container = this.nekoTargets.get(guestId)?.container || guestId;
        runNekoDock(this.repoRoot(), mapped, container).then(
          (result) => {
            this.deskBusy.delete(guestId);
            if (!result.ok) res.status(502).json({ error: result.detail });
            else res.json(result);
          },
          (error) => {
            this.deskBusy.delete(guestId);
            fail(res, error);
          },
        );
        return;
      }
      if (this.deskBusy.has(guestId)) {
        res.status(409).json({ error: 'this desktop is already working on a message' });
        return;
      }
      let link: { sshPort: number };
      try {
        link = this.guestLink(guestId);
      } catch (error) {
        fail(res, error);
        return;
      }
      const root = this.repoRoot();
      this.deskBusy.add(guestId);
      runGuestDock({
        guestId,
        sshPort: link.sshPort,
        keyPath: join(root, 'images/guest_ed25519'),
        repoRoot: root,
        op: mapped,
      }).then(
        (result) => {
          this.deskBusy.delete(guestId);
          if (!result.ok) res.status(502).json({ error: result.detail });
          else res.json(result);
        },
        (error) => {
          this.deskBusy.delete(guestId);
          fail(res, error);
        },
      );
    });

    this.app.post('/api/vms/:id/record/start', (req, res) => {
      this.beginRecording(req.params.id).then(
        (body) => res.json(body),
        (error) => fail(res, error),
      );
    });

    this.app.post('/api/vms/:id/record/stop', (req, res) => {
      this.endRecording(req.params.id).then(
        (body) => res.json(body),
        (error) => fail(res, error),
      );
    });

    this.app.get('/api/vms/:id/snapshots', (req, res) => {
      this.withControl(req.params.id, (row) => listSnapshots(row.qmp)).then(
        (body) => res.json(body),
        (error) => fail(res, error),
      );
    });

    this.app.post('/api/vms/:id/snapshot', (req, res) => {
      const name = String(req.body?.name || '');
      this.withControl(req.params.id, async (row) => {
        const message = await saveVm(row.qmp, name);
        return { name, message };
      }).then(
        (body) => res.json(body),
        (error) => fail(res, error),
      );
    });

    this.app.post('/api/vms/:id/restore', (req, res) => {
      const name = String(req.body?.name || '');
      this.withControl(req.params.id, async (row) => {
        const message = await loadVm(row.qmp, name);
        return { name, message };
      }).then(
        (body) => res.json(body),
        (error) => fail(res, error),
      );
    });

    this.app.get('/api/vms/:id/chat', (req, res) => {
      try {
        const guestId = this.guestId(req.params.id);
        res.json({ messages: this.chats.get(guestId) || [] });
      } catch (error) {
        fail(res, error);
      }
    });

    this.app.post('/api/vms/:id/chat', (req, res) => {
      this.streamChat(req.params.id, String(req.body?.message || ''), res).catch((error) => {
        if (!res.headersSent) fail(res, error);
        else res.end();
      });
    });

    this.app.get('/api/desk-shots/:file', (req, res) => {
      const file = this.shotPath(req.params.file);
      if (!file) {
        res.status(404).json({ error: 'shot not found' });
        return;
      }
      res.sendFile(file);
    });
  }

  start(): void {
    this.server = createHttpServer(this.app);
    this.wss = new WebSocketServer({ noServer: true, perMessageDeflate: false });
    this.server.on('upgrade', (req, socket, head) => {
      this.routeUpgrade(req, socket, head);
    });
    this.wss.on('connection', (ws) => {
      this.clients.add(ws);
      ws.send(JSON.stringify({ type: 'state', data: this.publicState(this.snapshot()) }));
      ws.on('close', () => this.clients.delete(ws));
    });
    this.server.listen(this.port, '0.0.0.0', () => {
      console.log(`Dashboard server running at http://localhost:${this.port}`);
    });
    this.inboxTimer = setInterval(() => this.pollInbox(), 1000);
  }

  registerDisplay(info: { guestId: string; vncPort?: number; vncPassword?: string; jobName?: string; status?: string; kind?: 'vnc' | 'neko'; nekoUrl?: string; httpPort?: number; container?: string }): void {
    this.displays.set(info.guestId, {
      guest_id: info.guestId,
      job_name: info.jobName,
      status: info.status || (info.kind === 'neko' ? 'webrtc — click the picture to control' : 'booting'),
      vnc_password: info.vncPassword,
      vncPort: info.vncPort ?? 0,
      httpPort: info.httpPort,
      kind: info.kind || (info.nekoUrl ? 'neko' : 'vnc'),
      neko_url: info.nekoUrl,
    });
    if (info.container) {
      const wsUrl = info.nekoUrl && /^https?:/i.test(info.nekoUrl)
        ? `ws://${new URL(info.nekoUrl).host}/ws?password=neko&username=codex`
        : '';
      this.nekoTargets.set(info.guestId, {
        container: info.container,
        wsUrl,
      });
    }
    this.push();
  }

  unregisterDisplay(guestId: string): void {
    this.displays.delete(guestId);
    this.nekoTargets.delete(guestId);
    this.push();
  }

  stop(): void {
    if (this.inboxTimer) clearInterval(this.inboxTimer);
    this.inboxTimer = null;
    for (const client of this.clients) {
      client.close();
    }
    this.clients.clear();
    this.wss?.close();
    this.server?.close();
  }

  broadcast(state: DashboardState): void {
    this.latestState = state;
    this.push();
  }

  private codexStatus(): Promise<{
    binary: boolean;
    api_key: boolean;
    running: boolean;
    mcp: string;
    chat: string;
  }> {
    const look = (cmd: string, args: string[]) => new Promise<string>((resolve) => {
      const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'ignore'] });
      let out = '';
      const timer = setTimeout(() => child.kill('SIGKILL'), 2000);
      child.stdout.on('data', (chunk) => {
        out += chunk.toString('utf8');
      });
      child.on('close', () => {
        clearTimeout(timer);
        resolve(out.trim());
      });
      child.on('error', () => {
        clearTimeout(timer);
        resolve('');
      });
    });
    return Promise.all([look('bash', ['-lc', 'command -v codex || true']), look('bash', ['-lc', 'pgrep -x codex || true'])]).then(([binary, running]) => {
      const auth = process.env.OPENAI_API_KEY || existsSync(join(homedir(), '.codex', 'auth.json'));
      return {
        binary: Boolean(binary),
        api_key: Boolean(auth),
        running: Boolean(running),
        mcp: '.codex/config.toml',
        chat: binary && auth && codexDeskAvailable() ? 'codex' : 'local planner',
      };
    });
  }

  private nekoVncPort(): number {
    const port = Number(process.env.NEKO_VNC_PORT || 5930);
    return Number.isInteger(port) && port > 0 ? port : 5930;
  }

  private nekoHttpPort(id: string): number | undefined {
    if (id === 'workshop-neko') return Number(process.env.NEKO_PORT || 8341);
    if (id === (process.env.NEKO_SECONDARY_NAME || 'workshop-neko-2')) return Number(process.env.NEKO_SECONDARY_PORT || 8342);
    return this.displays.get(id)?.httpPort;
  }

  private async proxyNekoHttp(req: IncomingMessage & { params?: { id?: string }; originalUrl?: string }, res: ServerResponse): Promise<void> {
    const id = String(req.params?.id || '');
    const port = this.nekoHttpPort(id);
    if (!port) {
      res.statusCode = 404;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ error: 'neko display is not registered' }));
      return;
    }
    const path = (req.originalUrl || req.url || '/').replace(/\/{2,}/g, '/');
    const headers: Record<string, string | string[] | undefined> = { ...req.headers, host: `127.0.0.1:${port}` };
    delete headers.connection;
    const upstream = httpRequest({ host: '127.0.0.1', port, path, method: req.method, headers }, (reply) => {
      const replyHeaders = { ...reply.headers };
      if (replyHeaders['set-cookie']) {
        replyHeaders['set-cookie'] = replyHeaders['set-cookie'].map((cookie) => {
          if (/;\s*path=/i.test(cookie)) return cookie.replace(/;\s*path=[^;]*/i, `; Path=/neko/${id}/`);
          return `${cookie}; Path=/neko/${id}/`;
        });
      }
      if (replyHeaders.location && replyHeaders.location.startsWith('/') && !replyHeaders.location.startsWith(`/neko/${id}`)) {
        replyHeaders.location = `/neko/${id}${replyHeaders.location}`;
      }
      res.writeHead(reply.statusCode || 502, replyHeaders);
      reply.pipe(res);
    });
    upstream.on('error', () => {
      if (!res.headersSent) {
        res.statusCode = 502;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ error: 'neko proxy failed' }));
      } else {
        res.end();
      }
    });
    req.pipe(upstream);
  }

  private nekoDisplay(): VmDisplay {
    return {
      guest_id: 'workshop-neko',
      job_name: 'Neko desk',
      status: 'webrtc — click the picture to control',
      kind: 'neko',
      neko_url: '/neko/workshop-neko/?usr=neko&pwd=neko&embed=1',
    };
  }

  private secondaryNekoDisplay(): VmDisplay {
    const name = process.env.NEKO_SECONDARY_NAME || 'workshop-neko-2';
    return {
      guest_id: name,
      job_name: 'Neko desk 2',
      status: 'webrtc — click the picture to control',
      kind: 'neko',
      neko_url: `/neko/${name}/?usr=neko&pwd=neko&embed=1`,
    };
  }

  private publicState(state: DashboardState): DashboardState {
    const active = new Map(state.active_guests.map((guest) => [guest.id, guest]));
    return {
      ...state,
      displays: [
        this.nekoDisplay(),
        this.secondaryNekoDisplay(),
        ...[...this.displays.values()].map((display) => {
          const guest = active.get(display.guest_id);
          return {
            guest_id: display.guest_id,
            job_name: display.job_name || guest?.job_name,
            status: guest?.status || display.status,
            vnc_password: display.vnc_password,
            kind: display.kind || 'vnc',
            neko_url: display.neko_url,
          };
        }),
      ],
    };
  }

  private snapshot(): DashboardState {
    return this.latestState ?? {
      config: {
        max_concurrent_guests: 0,
        memory_per_guest_mb: 0,
        total_memory_budget_mb: 0,
        reserved_host_memory_mb: 0,
        fixtures_url: '',
        driver: 'lume' as const,
        browser_mode: 'chromium' as const,
        default_timeout_ms: 0,
      },
      stats: { pending: 0, running: 0, completed: 0, passed: 0, failed: 0, cancelled: 0, timeout: 0 },
      active_guests: [],
      recent_results: [],
      queue_depth: 0,
      memory_usage_mb: 0,
    };
  }

  private push(): void {
    const message = JSON.stringify({ type: 'state', data: this.publicState(this.snapshot()) });
    for (const client of this.clients) {
      if (client.readyState === WebSocket.OPEN) client.send(message);
    }
  }

  private routeUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    const url = new URL(req.url || '/', 'http://127.0.0.1');
    const neko = url.pathname.match(/^\/neko\/([^/]+)(\/.*)$/);
    if (neko) {
      this.bridgeNeko(decodeURIComponent(neko[1]), req, socket, head, `${url.pathname}${url.search}`);
      return;
    }
    const match = url.pathname.match(/^\/vm\/([^/]+)\/vnc$/);
    if (match) {
      this.bridgeVnc(decodeURIComponent(match[1]), req, socket, head);
      return;
    }
    this.wss?.handleUpgrade(req, socket, head, (ws) => {
      this.wss?.emit('connection', ws, req);
    });
  }

  private bridgeNeko(id: string, req: IncomingMessage, socket: Duplex, head: Buffer, path: string): void {
    const port = this.nekoHttpPort(id);
    if (!port) {
      socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    const tcp = connectTcp({ port, host: '127.0.0.1' });
    tcp.setNoDelay(true);
    const fail = () => {
      tcp.destroy();
      socket.destroy();
    };
    tcp.once('error', fail);
    tcp.once('connect', () => {
      tcp.removeListener('error', fail);
      tcp.on('error', fail);
      socket.on('error', fail);
      const headers: string[] = [];
      for (let i = 0; i < req.rawHeaders.length; i += 2) {
        const key = req.rawHeaders[i];
        const value = req.rawHeaders[i + 1];
        if (/^host$/i.test(key)) continue;
        if (/^origin$/i.test(key)) {
          headers.push(`${key}: http://127.0.0.1:${port}`);
          continue;
        }
        headers.push(`${key}: ${value}`);
      }
      headers.push(`Host: 127.0.0.1:${port}`);
      tcp.write(`GET ${path.replace(/\/{2,}/g, '/')} HTTP/1.1\r\n${headers.join('\r\n')}\r\n\r\n`);
      if (head.length > 0) tcp.write(head);
      tcp.pipe(socket);
      socket.pipe(tcp);
    });
  }

  private recordingsDir(): string {
    return this.options.recordingsDir || join(dirname(fileURLToPath(import.meta.url)), '../../../../runs/recordings');
  }

  private listRecordings(): Array<{ file: string; guest_id: string; bytes: number; mtime_ms: number }> {
    const dir = this.recordingsDir();
    try {
      return readdirSync(dir)
        .filter((file) => file.endsWith('.mp4'))
        .map((file) => {
          const info = statSync(join(dir, file));
          const guest = file.split('__')[0] || file;
          return { file, guest_id: guest, bytes: info.size, mtime_ms: info.mtimeMs };
        })
        .sort((a, b) => b.mtime_ms - a.mtime_ms);
    } catch {
      return [];
    }
  }

  private recordingPath(file: string): string | null {
    const base = basename(file);
    if (!/^[a-z0-9][a-z0-9._-]{0,120}\.mp4$/i.test(base)) return null;
    const full = join(this.recordingsDir(), base);
    try {
      if (!statSync(full).isFile()) return null;
    } catch {
      return null;
    }
    return full;
  }

  private repoRoot(): string {
    if (this.options.repoRoot) return this.options.repoRoot;
    if (this.options.controlFile) return join(this.options.controlFile, '../..');
    return join(dirname(fileURLToPath(import.meta.url)), '../../../..');
  }

  private guestLink(guestId: string): { sshPort: number } {
    const display = this.displays.get(guestId);
    if (!display) throw Object.assign(new Error('guest display is not registered'), { status: 404 });
    let sshPort = display.vncPort - 5941 + 24841;
    const file = this.options.controlFile;
    if (file) {
      try {
        const parsed = JSON.parse(readFileSync(file, 'utf8')) as Record<string, { sshPort?: number; vncPort?: number }>;
        const row = parsed[guestId];
        if (row?.sshPort) sshPort = Number(row.sshPort);
        else if (row?.vncPort) sshPort = Number(row.vncPort) - 5941 + 24841;
      } catch {
        /* the display port mapping is the fallback */
      }
    }
    if (!Number.isInteger(sshPort) || sshPort < 1 || sshPort > 65535) {
      throw Object.assign(new Error('this guest has no SSH port'), { status: 409 });
    }
    return { sshPort };
  }

  private remember(guestId: string, line: ChatLine): void {
    const rows = this.chats.get(guestId) || [];
    rows.push(line);
    this.chats.set(guestId, rows.slice(-80));
  }

  private async openClawStatus(): Promise<{ gateway: boolean; model: boolean; nodes: string; node_names: string[] }> {
    const up = await gatewayUp();
    if (!up) return { gateway: false, model: Boolean(process.env.OPENAI_API_KEY), nodes: 'gateway down', node_names: [] };
    try {
      const listed = await listNodes({ repoRoot: this.repoRoot() });
      const nodeNames = listed.nodes
        .filter((node) => node.connected !== false)
        .map((node) => node.displayName || '')
        .filter(Boolean);
      return { gateway: true, model: Boolean(process.env.OPENAI_API_KEY), nodes: listed.text, node_names: nodeNames };
    } catch (error) {
      return {
        gateway: true,
        model: Boolean(process.env.OPENAI_API_KEY),
        nodes: error instanceof Error ? error.message : 'nodes unavailable',
        node_names: [],
      };
    }
  }

  private pollInbox(): void {
    const file = join(this.repoRoot(), 'runs/openclaw/inbox.jsonl');
    let raw = '';
    try {
      raw = readFileSync(file, 'utf8');
    } catch {
      return;
    }
    const lines = raw.split('\n').filter(Boolean);
    let seen = this.inboxLines;
    for (const line of lines.slice(this.inboxLines)) {
      try {
        const row = JSON.parse(line) as { from?: string; text?: string };
        if (row.text) this.remember('neko', { role: 'assistant', text: `From ${row.from || 'vm'}: ${row.text}` });
        seen += 1;
      } catch {
        break;
      }
    }
    this.inboxLines = seen;
  }

  private wsForContainer(container: string): string | undefined {
    if (!container || container === (process.env.NEKO_NAME || 'workshop-neko')) {
      return process.env.NEKO_WS || 'ws://127.0.0.1:8341/ws?password=neko&username=codex';
    }
    for (const target of this.nekoTargets.values()) {
      if (target.container === container) return target.wsUrl;
    }
    return undefined;
  }

  private async *runFleet(fleet: ReturnType<typeof planFleet>, container: string, wsUrl?: string): AsyncGenerator<DeskEvent> {
    const paths = { repoRoot: this.repoRoot() };
    if (!(await gatewayUp())) {
      yield { type: 'error', text: 'OpenClaw gateway is not up. Run scripts/openclaw-up.sh on the host.' };
      yield { type: 'done' };
      return;
    }
    if (fleet.kind === 'tell') {
      const text = fleet.text || 'ping';
      await postDeskHook(paths, container, text);
      yield { type: 'assistant', text: `Sent to the main chat from ${container}.` };
      yield { type: 'done' };
      return;
    }
    if (fleet.kind === 'nodes') {
      const listed = await listNodes(paths);
      yield { type: 'assistant', text: listed.text };
      yield { type: 'done' };
      return;
    }
    const node = fleet.node || container;
    if (fleet.kind === 'state') {
      yield { type: 'assistant', text: await nodeState(paths, node) };
      yield { type: 'done' };
      return;
    }
    const plan = planDesk(fleet.text, {
      home: '/home/neko',
      fixturesUrl: process.env.NEKO_FIXTURES_URL || 'http://127.0.0.1:4317',
    });
    if (!plan.actions.length) {
      yield { type: 'assistant', text: plan.say };
      yield { type: 'done' };
      return;
    }
    yield { type: 'assistant', text: `${node}: ${plan.say}` };
    for (const action of plan.actions) {
      if (action.op === 'react' && action.emote) {
        const socket = wsUrl && node === container ? wsUrl : this.wsForContainer(node);
        if (!socket) throw new Error(`${node} has no neko reaction socket`);
        await sendNekoEmote(action.emote, socket);
        yield { type: 'action', op: 'react', text: `reaction ${action.emote} on ${node}` };
        continue;
      }
      const detail = await runDeskTool(paths, node, { ...action });
      yield { type: 'action', op: action.op, text: detail };
    }
    yield { type: 'done' };
  }

  private nekoContainer(requested: string): string {
    if (!requested) return process.env.NEKO_NAME || 'workshop-neko';
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,63}$/.test(requested)) {
      throw Object.assign(new Error('invalid neko container'), { status: 400 });
    }
    return requested;
  }

  private nekoTarget(guestId: string): { container: string; wsUrl?: string; busyKey: string } {
    if (!guestId || guestId === 'workshop-neko') {
      const container = process.env.NEKO_NAME || 'workshop-neko';
      return { container, busyKey: container };
    }
    const known = this.nekoTargets.get(guestId);
    if (!known) throw Object.assign(new Error('neko display is not registered'), { status: 404 });
    return { container: known.container, wsUrl: known.wsUrl, busyKey: known.container };
  }

  private async streamNekoChat(message: string, guestId: string, res: Response): Promise<void> {
    const target = this.nekoTarget(guestId);
    const chatKey = !guestId || guestId === 'workshop-neko' ? 'neko' : guestId;
    const text = message.trim();
    if (!text) throw Object.assign(new Error('message is empty'), { status: 400 });
    if (text.length > 4000) throw Object.assign(new Error('message is too long'), { status: 400 });
    if (this.deskBusy.has(target.busyKey)) throw Object.assign(new Error('this desktop is already working on a message'), { status: 409 });
    const root = this.repoRoot();
    this.deskBusy.add(target.busyKey);
    this.remember(chatKey, { role: 'user', text });
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();
    const send = (event: DeskEvent) => {
      res.write(`data: ${JSON.stringify(event)}\n\n`);
      if (event.type === 'assistant' || event.type === 'error' || event.type === 'reasoning') {
        this.remember(chatKey, { role: event.type, text: event.text || '' });
      } else if (event.type === 'action') {
        this.remember(chatKey, { role: 'action', text: event.text || event.op || '' });
      } else if (event.type === 'shot' && event.file) {
        this.remember(chatKey, { role: 'action', text: event.text || 'screen', file: event.file });
      }
    };
    try {
      const fleet = planFleet(text);
      if (fleet.kind !== 'desk') {
        for await (const event of this.runFleet(fleet, target.container, target.wsUrl)) send(event);
      } else if (codexDeskAvailable()) {
        for await (const event of runCodexDesk({
          message: text,
          container: target.container,
          repoRoot: root,
          shotsDir: join(root, 'runs/desk-shots'),
        })) {
          send(event);
        }
      } else {
        for await (const event of runNekoChat({
          message: text,
          repoRoot: root,
          shotsDir: join(root, 'runs/desk-shots'),
          container: target.container,
          wsUrl: target.wsUrl,
        })) {
          send(event);
        }
      }
    } catch (error) {
      send({ type: 'error', text: error instanceof Error ? error.message : String(error) });
      send({ type: 'done' });
    } finally {
      this.deskBusy.delete(target.busyKey);
      res.end();
    }
  }

  private async streamChat(id: string, message: string, res: Response): Promise<void> {
    const guestId = this.guestId(id);
    const text = message.trim();
    if (!text) throw Object.assign(new Error('message is empty'), { status: 400 });
    if (text.length > 4000) throw Object.assign(new Error('message is too long'), { status: 400 });
    if (!this.displays.has(guestId)) throw Object.assign(new Error('guest display is not registered'), { status: 404 });
    // A Docker/neko guest is not an SSH guest. Route its chat through the
    // container's desk tool instead of the lume SSH path.
    if (this.nekoTargets.has(guestId)) {
      await this.streamNekoChat(text, guestId, res);
      return;
    }
    if (this.deskBusy.has(guestId)) throw Object.assign(new Error('this desktop is already working on a message'), { status: 409 });
    const link = this.guestLink(guestId);
    const root = this.repoRoot();
    this.deskBusy.add(guestId);
    this.remember(guestId, { role: 'user', text });
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();
    const send = (event: DeskEvent) => {
      res.write(`data: ${JSON.stringify(event)}\n\n`);
      if (event.type === 'assistant' || event.type === 'error' || event.type === 'reasoning') {
        this.remember(guestId, { role: event.type, text: event.text || '' });
      } else if (event.type === 'action') {
        this.remember(guestId, { role: 'action', text: event.text || event.op || '' });
      } else if (event.type === 'shot' && event.file) {
        this.remember(guestId, { role: 'action', text: event.text || 'screen', file: event.file });
      }
    };
    try {
      for await (const event of runDeskChat({
        guestId,
        message: text,
        sshPort: link.sshPort,
        keyPath: join(root, 'images/guest_ed25519'),
        repoRoot: root,
        shotsDir: join(root, 'runs/desk-shots'),
      })) {
        send(event);
      }
    } catch (error) {
      send({ type: 'error', text: error instanceof Error ? error.message : String(error) });
      send({ type: 'done' });
    } finally {
      this.deskBusy.delete(guestId);
      res.end();
    }
  }

  private shotsDir(): string {
    return join(this.repoRoot(), 'runs/desk-shots');
  }

  private shotPath(file: string): string | null {
    const base = basename(file);
    if (!/^[a-z0-9][a-z0-9._-]{0,120}\.png$/i.test(base)) return null;
    const full = join(this.shotsDir(), base);
    try {
      if (!statSync(full).isFile()) return null;
    } catch {
      return null;
    }
    return full;
  }

  private guestId(id: string): string {
    const decoded = decodeURIComponent(id);
    if (!/^[a-z0-9-]{1,64}$/.test(decoded)) {
      throw Object.assign(new Error('bad guest id'), { status: 400 });
    }
    return decoded;
  }

  private async beginRecording(id: string): Promise<{ file: string; guest_id: string }> {
    const guestId = this.guestId(id);
    const display = this.displays.get(guestId);
    if (!display) throw Object.assign(new Error('guest display is not registered'), { status: 404 });
    if (this.recording) throw Object.assign(new Error(`already recording ${this.recording.guestId}`), { status: 409 });
    const dir = this.recordingsDir();
    mkdirSync(dir, { recursive: true });
    const fileName = `${guestId}__${Date.now()}.mp4`;
    const handle = await startVncRecording({
      host: '127.0.0.1',
      port: display.vncPort,
      file: join(dir, fileName),
      guestId,
    });
    this.recording = handle;
    return { file: fileName, guest_id: guestId };
  }

  private async endRecording(id: string): Promise<{ file: string; guest_id: string }> {
    const guestId = this.guestId(id);
    const current = this.recording;
    if (!current || current.guestId !== guestId) {
      throw Object.assign(new Error('this guest is not recording'), { status: 409 });
    }
    this.recording = null;
    await current.stop();
    return { file: basename(current.file), guest_id: guestId };
  }

  private async withControl<T>(id: string, fn: (row: { qmp: string }) => Promise<T>): Promise<T> {
    const guestId = this.guestId(id);
    const file = this.options.controlFile;
    if (!file) throw Object.assign(new Error('snapshot control file is not configured'), { status: 409 });
    let parsed: Record<string, { qmp?: string }>;
    try {
      parsed = JSON.parse(readFileSync(file, 'utf8')) as Record<string, { qmp?: string }>;
    } catch {
      throw Object.assign(new Error('this guest was booted without a QMP socket; reboot the wall to arm snapshots'), { status: 409 });
    }
    const row = parsed[guestId];
    if (!row?.qmp) {
      throw Object.assign(new Error('this guest has no QMP socket; reboot the wall so snapshots are armed'), { status: 409 });
    }
    return fn({ qmp: row.qmp });
  }

  private bridgeVnc(guestId: string, req: IncomingMessage, socket: Duplex, head: Buffer): void {
    const display = this.displays.get(guestId);
    const port = guestId === 'workshop-neko' ? this.nekoVncPort() : display?.vncPort;
    if (!port || !this.wss || (guestId !== 'workshop-neko' && (!display || display.kind === 'neko'))) {
      socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    const tcp = connectTcp({ port, host: '127.0.0.1' });
    tcp.setNoDelay(true);
    const fail = () => {
      tcp.destroy();
      socket.destroy();
    };
    tcp.once('error', fail);
    tcp.once('connect', () => {
      tcp.removeListener('error', fail);
      const bridge = new WebSocketServer({ noServer: true, perMessageDeflate: false });
      bridge.handleUpgrade(req, socket, head, (ws) => {
        const writeTcp = (data: RawData) => {
          if (Array.isArray(data)) tcp.write(Buffer.concat(data));
          else if (Buffer.isBuffer(data)) tcp.write(data);
          else tcp.write(Buffer.from(data));
        };
        ws.on('message', writeTcp);
        tcp.on('data', (chunk) => {
          if (ws.readyState === WebSocket.OPEN) ws.send(chunk);
        });
        const close = () => {
          tcp.destroy();
          if (ws.readyState === WebSocket.OPEN) ws.close();
        };
        tcp.on('close', close);
        tcp.on('error', close);
        ws.on('close', () => tcp.destroy());
        ws.on('error', () => tcp.destroy());
      });
    });
  }
}
