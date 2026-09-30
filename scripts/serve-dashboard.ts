import { readFileSync } from 'fs';
import { join } from 'path';
import { DashboardServer } from '../packages/orchestrator/src/dashboard/server.js';
import { createDefaultConfig } from '../packages/orchestrator/src/admission/memory-controller.js';
import { repoRoot } from '../drivers/process/driver.js';
import type { DashboardState, JobResult } from '../packages/orchestrator/src/types.js';

const port = Number(process.env.DASHBOARD_PORT || 4318);
const summary = JSON.parse(readFileSync(join(repoRoot, 'runs/latest.json'), 'utf8')) as {
  passed: number;
  failed: number;
  timeout: number;
  peak_concurrent: number;
  results: JobResult[];
};

const state: DashboardState = {
  config: createDefaultConfig({
    max_concurrent_guests: 2,
    total_memory_budget_mb: 2000,
    reserved_host_memory_mb: 600,
    memory_per_guest_mb: 700,
  }),
  stats: {
    pending: 0,
    running: 0,
    completed: summary.passed + summary.failed + summary.timeout,
    passed: summary.passed,
    failed: summary.failed,
    cancelled: 0,
    timeout: summary.timeout,
  },
  active_guests: [],
  recent_results: summary.results,
  queue_depth: 0,
  memory_usage_mb: 0,
};

const server = new DashboardServer(port, {
  recordingsDir: join(repoRoot, 'runs/recordings'),
  controlFile: join(repoRoot, 'runs/vm-control.json'),
});
server.start();
server.broadcast(state);
const listed = (process.env.VNC_DISPLAYS || '')
  .split(',')
  .map((item) => item.trim())
  .filter(Boolean);
if (listed.length > 0) {
  for (const item of listed) {
    const [guestId, portText, ...nameParts] = item.split('@');
    const vncPort = Number(portText);
    if (!guestId || !Number.isFinite(vncPort)) continue;
    server.registerDisplay({
      guestId,
      vncPort,
      jobName: nameParts.join('@') || guestId,
      status: 'live framebuffer',
    });
  }
} else {
  const vncPort = Number(process.env.VNC_PORT || 0);
  if (vncPort > 0) {
    server.registerDisplay({
      guestId: process.env.VNC_GUEST_ID || 'guest-1',
      vncPort,
      jobName: process.env.VNC_JOB_NAME || 'guest desktop',
      status: 'live framebuffer',
    });
  }
}
setInterval(() => server.broadcast(state), 1000);
console.log(`dashboard at http://127.0.0.1:${port} displays=${process.env.VNC_DISPLAYS || process.env.VNC_PORT || 'none'}`);
