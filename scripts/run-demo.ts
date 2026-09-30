import { spawn, type ChildProcess } from 'child_process';
import { createRequire } from 'module';
import { mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { parse } from 'yaml';
import { readFileSync } from 'fs';
import { WorkQueue } from '../packages/orchestrator/src/queue/work-queue.js';
import { MemoryController, createDefaultConfig } from '../packages/orchestrator/src/admission/memory-controller.js';
import { FanOutRunner } from '../packages/orchestrator/src/runner/fan-out-runner.js';
import { DashboardServer } from '../packages/orchestrator/src/dashboard/server.js';
import { renderDashboard, renderJobResult } from '../packages/orchestrator/src/dashboard/cli.js';
import type { DashboardState, JobCard, JobResult } from '../packages/orchestrator/src/types.js';
import { EvalRunner } from '../packages/evals/src/index.js';
import { ProcessGuestDriver, repoRoot } from '../drivers/process/driver.js';
import { DockerGuestDriver } from '../drivers/docker/driver.js';
import { MicrovmGuestDriver } from '../drivers/microvm/driver.js';
import { LumeGuestDriver } from '../drivers/lume/driver.js';

const require = createRequire(import.meta.url);
const FIXTURES_PORT = Number(process.env.FIXTURES_PORT || 4317);
const DASHBOARD_PORT = Number(process.env.DASHBOARD_PORT || 4318);

interface PackFile {
  pack: JobCard['pack'];
  jobs: JobCard[];
}

function argValue(flag: string): string | undefined {
  const index = process.argv.indexOf(flag);
  if (index === -1) return undefined;
  return process.argv[index + 1];
}

function hasFlag(flag: string): boolean {
  return process.argv.includes(flag);
}

function loadPack(path: string): JobCard[] {
  const doc = parse(readFileSync(path, 'utf8')) as PackFile;
  return doc.jobs.map((job) => ({ ...job, pack: job.pack || doc.pack }));
}

function selectJobs(all: JobCard[]): JobCard[] {
  const batchPath = argValue('--batch') || join(repoRoot, 'tasks/batch-24.yaml');
  const batch = parse(readFileSync(batchPath, 'utf8')) as { job_ids: string[] };
  const wanted = new Set(batch.job_ids);
  let jobs = all.filter((job) => wanted.has(job.id));
  const only = argValue('--jobs');
  if (only) {
    const ids = new Set(only.split(',').map((id) => id.trim()));
    jobs = all.filter((job) => ids.has(job.id));
  }
  const limit = argValue('--limit');
  if (limit) jobs = jobs.slice(0, Number(limit));
  if (jobs.length === 0) throw new Error('no jobs selected');
  return jobs;
}

async function healthy(port: number): Promise<boolean> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/health`);
    return response.ok;
  } catch {
    return false;
  }
}

async function ensureFixtures(): Promise<ChildProcess | null> {
  if (await healthy(FIXTURES_PORT)) return null;
  const tsxCli = require.resolve('tsx/cli');
  mkdirSync(join(repoRoot, 'runs'), { recursive: true });
  const child = spawn(process.execPath, [tsxCli, join(repoRoot, 'apps/fixtures/src/index.ts')], {
    cwd: repoRoot,
    env: { ...process.env, FIXTURES_PORT: String(FIXTURES_PORT) },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: false,
  });
  child.stdout?.on('data', (chunk) => process.stdout.write(`[fixtures] ${chunk}`));
  child.stderr?.on('data', (chunk) => process.stderr.write(`[fixtures] ${chunk}`));
  for (let i = 0; i < 50; i++) {
    if (await healthy(FIXTURES_PORT)) return child;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  child.kill('SIGTERM');
  throw new Error(`fixtures did not become healthy on :${FIXTURES_PORT}`);
}

function snapshot(queue: WorkQueue, memory: MemoryController, config: ReturnType<typeof createDefaultConfig>): DashboardState {
  const stats = queue.getStats();
  return {
    config,
    stats,
    active_guests: memory.getActiveGuests(),
    recent_results: queue.getRecentResults(12),
    queue_depth: queue.pendingCount,
    memory_usage_mb: memory.usedMemoryMb,
  };
}

async function main(): Promise<void> {
  const lowRam = hasFlag('--low-ram');
  const concurrency = argValue('--concurrency');
  const driverName = (argValue('--driver') || 'lume') as 'process' | 'docker' | 'microvm' | 'lume';
  const browserMode = (argValue('--browser') || 'chromium') as 'chromium' | 'lightpanda';
  const appServerMode = (argValue('--app-server') || 'mock') as 'mock' | 'real';
  const exitWhenDone = hasFlag('--exit');
  const vm = driverName === 'lume' || driverName === 'microvm';

  const config = createDefaultConfig({
    fixtures_url: `http://127.0.0.1:${FIXTURES_PORT}`,
    driver: driverName,
    browser_mode: browserMode,
    max_concurrent_guests: concurrency ? Number(concurrency) : (vm ? 1 : (lowRam ? 2 : 4)),
    total_memory_budget_mb: vm ? (lowRam ? 4096 : 8 * 1024) : (lowRam ? 2000 : 24 * 1024),
    reserved_host_memory_mb: vm ? (lowRam ? 2048 : 4 * 1024) : (lowRam ? 600 : 6 * 1024),
    memory_per_guest_mb: vm ? 1536 : 700,
    default_timeout_ms: vm ? 720_000 : 90_000,
  });

  console.log(`driver=${driverName} app-server=${appServerMode} browser=${browserMode}`);
  console.log(`admission: max ${config.max_concurrent_guests} guests, ${config.memory_per_guest_mb}MB each, budget ${config.total_memory_budget_mb}MB, host reserve ${config.reserved_host_memory_mb}MB`);

  const fixtures = await ensureFixtures();
  const reset = await fetch(`${config.fixtures_url}/api/reset`, { method: 'POST' });
  if (!reset.ok) throw new Error(`fixture reset failed: HTTP ${reset.status}`);

  const jobs = selectJobs([
    ...loadPack(join(repoRoot, 'tasks/onboarding.yaml')),
    ...loadPack(join(repoRoot, 'tasks/support.yaml')),
    ...loadPack(join(repoRoot, 'tasks/booking.yaml')),
  ]);
  console.log(`enqueued ${jobs.length} jobs`);

  const queue = new WorkQueue();
  const memory = new MemoryController(config);
  const dashboard = hasFlag('--no-dashboard') ? null : new DashboardServer(DASHBOARD_PORT);
  dashboard?.start();
  const displayHooks = {
    onDisplay: (info: { guestId: string; vncPort: number; vncPassword?: string; jobName?: string }) => {
      dashboard?.registerDisplay(info);
    },
    onDisplayEnd: (guestId: string) => {
      dashboard?.unregisterDisplay(guestId);
    },
  };
  const driver = driverName === 'docker'
    ? new DockerGuestDriver()
    : driverName === 'microvm'
      ? new MicrovmGuestDriver({ browserMode, ...displayHooks })
      : driverName === 'lume'
        ? new LumeGuestDriver({ browserMode, ...displayHooks })
        : new ProcessGuestDriver({ appServerMode, browserMode });
  const evals = new EvalRunner({
    fixturesUrl: config.fixtures_url,
    dbPath: join(repoRoot, 'apps/fixtures/data/fixtures.db'),
  });
  const runner = new FanOutRunner(queue, memory, config, driver, {
    evaluate: (job) => evals.evaluate(job),
  });

  let lastBackpressure = '';
  runner.on('backpressure', (decision: { reason?: string }) => {
    const line = decision.reason || 'admission closed';
    if (line !== lastBackpressure) {
      lastBackpressure = line;
      console.log(`backpressure: ${line} (queue ${queue.pendingCount})`);
    }
  });
  runner.on('job:completed', ({ result }: { result: JobResult }) => {
    console.log(renderJobResult(result));
  });

  const timer = setInterval(() => {
    const state = snapshot(queue, memory, config);
    dashboard?.broadcast(state);
  }, 500);

  queue.enqueueBatch(jobs);
  runner.start();
  await runner.waitUntilDrained(vm ? 60 * 60_000 : 15 * 60_000);
  clearInterval(timer);

  const state = snapshot(queue, memory, config);
  dashboard?.broadcast(state);
  const stats = queue.getStats();
  const summary = {
    passed: stats.passed,
    failed: stats.failed,
    timeout: stats.timeout,
    peak_concurrent: memory.getPeakActive(),
    backpressure_events: runner.getBackpressureEvents(),
    effective_max_concurrent: memory.effectiveMaxConcurrent,
    results: queue.getRecentResults(100),
  };
  mkdirSync(join(repoRoot, 'runs'), { recursive: true });
  writeFileSync(join(repoRoot, 'runs/latest.json'), JSON.stringify(summary, null, 2));

  console.log('\n' + renderDashboard(state));
  console.log(`peak concurrent guests: ${summary.peak_concurrent} (cap ${summary.effective_max_concurrent})`);
  console.log(`backpressure events: ${summary.backpressure_events}`);
  console.log(`fixtures:  http://127.0.0.1:${FIXTURES_PORT}`);
  if (dashboard) console.log(`dashboard: http://127.0.0.1:${DASHBOARD_PORT}`);

  if (stats.failed > 0 || stats.timeout > 0 || stats.passed !== jobs.length) {
    console.error(`demo failed: ${stats.passed}/${jobs.length} passed`);
    if (exitWhenDone) {
      fixtures?.kill('SIGTERM');
      dashboard?.stop();
      process.exit(1);
    }
  }

  if (exitWhenDone) {
    fixtures?.kill('SIGTERM');
    dashboard?.stop();
    process.exit(stats.passed === jobs.length ? 0 : 1);
  }

  console.log('dashboard is staying up. Ctrl-C to stop.');
  fixtures?.on('exit', () => undefined);
  await new Promise(() => undefined);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
