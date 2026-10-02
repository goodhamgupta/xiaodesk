import { connect as connectTcp } from 'net';
import { createServer as createHttpServer, type IncomingMessage, type Server } from 'http';
import { mkdirSync, readFileSync, readdirSync, statSync } from 'fs';
import { basename, dirname, join } from 'path';
import { fileURLToPath } from 'url';
import express, { type Response } from 'express';
import { WebSocketServer, WebSocket, type RawData } from 'ws';
import type { Duplex } from 'stream';
import type { DashboardState, VmDisplay } from '../types.js';
import { dashboardPage } from './page.js';
import { listSnapshots, loadVm, saveVm } from '../vm/qmp.js';
import { startVncRecording, type RecordingHandle } from '../vm/vnc-record.js';
import { runDeskChat, type DeskEvent } from '../computer/desk.js';

export interface DashboardOptions {
  recordingsDir?: string;
  controlFile?: string;
  repoRoot?: string;
}

interface ChatLine {
  role: 'user' | 'assistant' | 'action' | 'error';
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

  constructor(
    private port: number = 4200,
    private options: DashboardOptions = {},
  ) {
    this.setupRoutes();
  }

  private setupRoutes(): void {
    this.app.use(express.json({ limit: '32kb' }));
    this.app.use('/novnc', express.static(novncRoot));

    this.app.get('/', (_req, res) => {
      res.type('html').send(dashboardPage());
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
  }

  registerDisplay(info: { guestId: string; vncPort: number; vncPassword?: string; jobName?: string; status?: string }): void {
    this.displays.set(info.guestId, {
      guest_id: info.guestId,
      job_name: info.jobName,
      status: info.status || 'booting',
      vnc_password: info.vncPassword,
      vncPort: info.vncPort,
    });
    this.push();
  }

  unregisterDisplay(guestId: string): void {
    this.displays.delete(guestId);
    this.push();
  }

  stop(): void {
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

  private publicState(state: DashboardState): DashboardState {
    const active = new Map(state.active_guests.map((guest) => [guest.id, guest]));
    return {
      ...state,
      displays: [...this.displays.values()].map((display) => {
        const guest = active.get(display.guest_id);
        return {
          guest_id: display.guest_id,
          job_name: display.job_name || guest?.job_name,
          status: guest?.status || display.status,
          vnc_password: display.vnc_password,
        };
      }),
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
    const match = url.pathname.match(/^\/vm\/([^/]+)\/vnc$/);
    if (match) {
      this.bridgeVnc(decodeURIComponent(match[1]), req, socket, head);
      return;
    }
    this.wss?.handleUpgrade(req, socket, head, (ws) => {
      this.wss?.emit('connection', ws, req);
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

  private async streamChat(id: string, message: string, res: Response): Promise<void> {
    const guestId = this.guestId(id);
    const text = message.trim();
    if (!text) throw Object.assign(new Error('message is empty'), { status: 400 });
    if (text.length > 4000) throw Object.assign(new Error('message is too long'), { status: 400 });
    if (!this.displays.has(guestId)) throw Object.assign(new Error('guest display is not registered'), { status: 404 });
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
      if (event.type === 'assistant' || event.type === 'error') {
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
    if (!display || !this.wss) {
      socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    const tcp = connectTcp({ port: display.vncPort, host: '127.0.0.1' });
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
