import express from 'express';
import { WebSocketServer, WebSocket } from 'ws';
import type { Server } from 'http';
import type { DashboardState } from '../types.js';

export class DashboardServer {
  private app = express();
  private server: Server | null = null;
  private wss: WebSocketServer | null = null;
  private clients: Set<WebSocket> = new Set();
  private latestState: DashboardState | null = null;

  constructor(private port: number = 4200) {
    this.setupRoutes();
  }

  private setupRoutes(): void {
    this.app.get('/', (_req, res) => {
      res.send(this.getHtmlDashboard());
    });

    this.app.get('/events', (req, res) => {
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.flushHeaders();
      const send = () => {
        if (this.latestState) res.write(`data: ${JSON.stringify(this.latestState)}\n\n`);
      };
      send();
      const timer = setInterval(send, 1000);
      req.on('close', () => clearInterval(timer));
    });

    this.app.get('/api/state', (_req, res) => {
      if (this.latestState) {
        res.json(this.latestState);
      } else {
        res.status(503).json({ error: 'No state available' });
      }
    });
  }

  start(): void {
    this.server = this.app.listen(this.port, () => {
      console.log(`Dashboard server running at http://localhost:${this.port}`);
    });

    this.wss = new WebSocketServer({ server: this.server });
    this.wss.on('connection', (ws) => {
      this.clients.add(ws);
      if (this.latestState) {
        ws.send(JSON.stringify({ type: 'state', data: this.latestState }));
      }
      ws.on('close', () => this.clients.delete(ws));
    });
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
    const message = JSON.stringify({ type: 'state', data: state });
    for (const client of this.clients) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(message);
      }
    }
  }

  private getHtmlDashboard(): string {
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>MicroVM Workshop - Dashboard</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: system-ui, sans-serif; background: #0f172a; color: #e2e8f0; min-height: 100vh; }
    .container { max-width: 1400px; margin: 0 auto; padding: 1.5rem; }
    h1 { font-size: 1.5rem; margin-bottom: 1.5rem; display: flex; align-items: center; gap: 0.5rem; }
    .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 1rem; margin-bottom: 1.5rem; }
    .card { background: #1e293b; border-radius: 8px; padding: 1.25rem; }
    .card h2 { font-size: 0.875rem; color: #94a3b8; margin-bottom: 1rem; text-transform: uppercase; letter-spacing: 0.05em; }
    .stats { display: grid; grid-template-columns: repeat(3, 1fr); gap: 0.75rem; }
    .stat { text-align: center; }
    .stat .value { font-size: 2rem; font-weight: bold; }
    .stat .label { font-size: 0.75rem; color: #64748b; }
    .stat.queued .value { color: #38bdf8; }
    .stat.running .value { color: #818cf8; }
    .stat.passed .value { color: #4ade80; }
    .stat.failed .value { color: #f87171; }
    .stat.timeout .value { color: #fbbf24; }
    .memory-bar { height: 24px; background: #334155; border-radius: 4px; overflow: hidden; margin-bottom: 0.5rem; }
    .memory-fill { height: 100%; transition: width 0.3s, background 0.3s; }
    .memory-fill.low { background: linear-gradient(90deg, #22c55e, #4ade80); }
    .memory-fill.medium { background: linear-gradient(90deg, #eab308, #fbbf24); }
    .memory-fill.high { background: linear-gradient(90deg, #ef4444, #f87171); }
    .memory-text { font-size: 0.875rem; color: #94a3b8; }
    table { width: 100%; border-collapse: collapse; }
    th, td { padding: 0.75rem; text-align: left; border-bottom: 1px solid #334155; }
    th { color: #64748b; font-weight: 500; font-size: 0.75rem; text-transform: uppercase; }
    .status { padding: 0.25rem 0.5rem; border-radius: 4px; font-size: 0.75rem; font-weight: 600; }
    .status.running { background: #312e81; color: #a5b4fc; }
    .status.starting { background: #422006; color: #fcd34d; }
    .status.passed { background: #14532d; color: #86efac; }
    .status.failed { background: #7f1d1d; color: #fca5a5; }
    .status.timeout { background: #78350f; color: #fde047; }
    .empty { color: #64748b; text-align: center; padding: 2rem; }
    .connection { position: fixed; top: 1rem; right: 1rem; padding: 0.5rem 1rem; border-radius: 4px; font-size: 0.75rem; }
    .connection.connected { background: #14532d; color: #86efac; }
    .connection.disconnected { background: #7f1d1d; color: #fca5a5; }
  </style>
</head>
<body>
  <div id="connection" class="connection disconnected">Connecting...</div>
  <div class="container">
    <h1>🖥️ MicroVM Workshop Dashboard</h1>
    
    <div class="grid">
      <div class="card">
        <h2>📊 Queue Statistics</h2>
        <div class="stats" id="stats">
          <div class="stat queued"><div class="value" id="stat-queued">-</div><div class="label">Queued</div></div>
          <div class="stat running"><div class="value" id="stat-running">-</div><div class="label">Running</div></div>
          <div class="stat passed"><div class="value" id="stat-passed">-</div><div class="label">Passed</div></div>
          <div class="stat failed"><div class="value" id="stat-failed">-</div><div class="label">Failed</div></div>
          <div class="stat timeout"><div class="value" id="stat-timeout">-</div><div class="label">Timeout</div></div>
          <div class="stat"><div class="value" id="stat-total">-</div><div class="label">Total</div></div>
        </div>
      </div>
      
      <div class="card">
        <h2>💾 Memory Usage</h2>
        <div class="memory-bar"><div class="memory-fill low" id="memory-fill" style="width: 0%"></div></div>
        <div class="memory-text" id="memory-text">Loading...</div>
      </div>
    </div>
    
    <div class="grid">
      <div class="card">
        <h2>🏃 Active Guests</h2>
        <table>
          <thead><tr><th>Guest ID</th><th>Job</th><th>Status</th><th>Runtime</th></tr></thead>
          <tbody id="guests"><tr><td colspan="4" class="empty">No active guests</td></tr></tbody>
        </table>
      </div>
      
      <div class="card">
        <h2>📋 Recent Results</h2>
        <table>
          <thead><tr><th>Job ID</th><th>Status</th><th>Duration</th><th>Evals</th></tr></thead>
          <tbody id="results"><tr><td colspan="4" class="empty">No results yet</td></tr></tbody>
        </table>
      </div>
    </div>
  </div>
  
  <script>
    let ws;
    const connEl = document.getElementById('connection');
    
    function connect() {
      ws = new WebSocket('ws://' + location.host);
      ws.onopen = () => { connEl.textContent = 'Connected'; connEl.className = 'connection connected'; };
      ws.onclose = () => { connEl.textContent = 'Disconnected'; connEl.className = 'connection disconnected'; setTimeout(connect, 2000); };
      ws.onmessage = (e) => {
        const msg = JSON.parse(e.data);
        if (msg.type === 'state') updateDashboard(msg.data);
      };
    }
    
    function updateDashboard(state) {
      document.getElementById('stat-queued').textContent = state.stats.pending;
      document.getElementById('stat-running').textContent = state.stats.running;
      document.getElementById('stat-passed').textContent = state.stats.passed;
      document.getElementById('stat-failed').textContent = state.stats.failed;
      document.getElementById('stat-timeout').textContent = state.stats.timeout;
      document.getElementById('stat-total').textContent = state.stats.completed;
      
      const usable = state.config.total_memory_budget_mb - state.config.reserved_host_memory_mb;
      const pct = Math.round((state.memory_usage_mb / usable) * 100);
      const fill = document.getElementById('memory-fill');
      fill.style.width = pct + '%';
      fill.className = 'memory-fill ' + (pct > 80 ? 'high' : pct > 60 ? 'medium' : 'low');
      document.getElementById('memory-text').textContent = 
        state.memory_usage_mb + 'MB / ' + usable + 'MB (' + pct + '%) — ' + state.active_guests.length + ' guests';
      
      const guestsEl = document.getElementById('guests');
      if (state.active_guests.length === 0) {
        guestsEl.innerHTML = '<tr><td colspan="4" class="empty">No active guests</td></tr>';
      } else {
        guestsEl.innerHTML = state.active_guests.map(g => {
          const runtime = Math.round((Date.now() - new Date(g.started_at).getTime()) / 1000);
          return '<tr><td>' + g.id.slice(0, 12) + '</td><td>' + g.job_name + '</td><td><span class="status ' + g.status + '">' + g.status + '</span></td><td>' + runtime + 's</td></tr>';
        }).join('');
      }
      
      const resultsEl = document.getElementById('results');
      if (state.recent_results.length === 0) {
        resultsEl.innerHTML = '<tr><td colspan="4" class="empty">No results yet</td></tr>';
      } else {
        resultsEl.innerHTML = state.recent_results.slice(0, 10).map(r => {
          const dur = r.duration_ms ? Math.round(r.duration_ms / 1000) + 's' : '-';
          const evals = r.eval_results ? r.eval_results.filter(e => e.passed).length + '/' + r.eval_results.length : '-';
          return '<tr><td>' + r.job_id.slice(0, 18) + '</td><td><span class="status ' + r.status + '">' + r.status + '</span></td><td>' + dur + '</td><td>' + evals + '</td></tr>';
        }).join('');
      }
    }
    
    connect();
  </script>
</body>
</html>`;
  }
}
