import { connect as connectTcp } from 'net';
import { createServer as createHttpServer, type IncomingMessage, type Server } from 'http';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import express from 'express';
import { WebSocketServer, WebSocket, type RawData } from 'ws';
import type { Duplex } from 'stream';
import type { DashboardState, VmDisplay } from '../types.js';
import { dashboardPage } from './page.js';

const novncRoot = join(dirname(fileURLToPath(import.meta.url)), '../../vendor/novnc');

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

  constructor(private port: number = 4200) {
    this.setupRoutes();
  }

  private setupRoutes(): void {
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
  }

  start(): void {
    this.server = createHttpServer(this.app);
    this.wss = new WebSocketServer({ noServer: true });
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

  private bridgeVnc(guestId: string, req: IncomingMessage, socket: Duplex, head: Buffer): void {
    const display = this.displays.get(guestId);
    if (!display || !this.wss) {
      socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    const tcp = connectTcp(display.vncPort, '127.0.0.1');
    const fail = () => {
      tcp.destroy();
      socket.destroy();
    };
    tcp.once('error', fail);
    tcp.once('connect', () => {
      tcp.removeListener('error', fail);
      const bridge = new WebSocketServer({ noServer: true });
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
