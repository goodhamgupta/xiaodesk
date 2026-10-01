import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = join(dirname(fileURLToPath(import.meta.url)), '../../..');
const server = join(root, 'scripts/guest/app-server.mjs');
const driver = join(root, 'scripts/drive-guest-turn.mjs');

function speak(job: Record<string, unknown>): Promise<{ stdout: string; stderr: string; code: number | null }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [server], {
      env: { ...process.env, GUEST_JOB_JSON: JSON.stringify(job) },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let started = false;
    let closed = false;
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    const send = (message: unknown) => child.stdin.write(`${JSON.stringify(message)}\n`);
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
      if (started) return;
      const thread = stdout
        .split('\n')
        .slice(0, -1)
        .filter(Boolean)
        .map((line) => JSON.parse(line))
        .find((msg) => msg.id === 2 && msg.result?.thread?.id);
      if (!thread) return;
      started = true;
      send({
        id: 3,
        method: 'turn/start',
        params: { threadId: thread.result.thread.id, input: [{ type: 'text', text: 'noop' }] },
      });
    });
    child.stdout.on('data', () => {
      if (closed || !stdout.includes('"turn/completed"')) return;
      closed = true;
      child.stdin.end();
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    send({
      id: 1,
      method: 'initialize',
      params: { clientInfo: { name: 'microvm-workshop', title: 'MicroVM Workshop', version: '1.0.0' } },
    });
    send({ method: 'initialized' });
    send({ id: 2, method: 'thread/start', params: { cwd: '/tmp', ephemeral: true } });
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`timeout\n${stdout}\n${stderr}`));
    }, 8000);
    child.on('error', reject);
    child.on('exit', (code) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, code });
    });
    setTimeout(() => child.stdin.end(), 4000);
  });
}

describe('guest app-server turn', () => {
  it('completes a noop turn and keeps solver stdout off the rpc stream', async () => {
    const { stdout } = await speak({ id: 'noop', kind: 'noop', goal: 'noop', stdout_probe: true });
    expect(stdout).not.toContain('solver-stdout');
    const messages = stdout.split('\n').filter(Boolean).map((line) => JSON.parse(line));
    const init = messages.find((msg) => msg.id === 1);
    expect(init.result.userAgent).toBe('microvm-workshop-mock-app-server/1.0.0');
    const done = messages.find((msg) => msg.method === 'turn/completed');
    expect(done.params.turn.status).toBe('completed');
  });

  it('rejects a request that arrives before initialized', async () => {
    const child = spawn(process.execPath, [server], {
      env: { ...process.env, GUEST_JOB_JSON: JSON.stringify({ id: 'noop', kind: 'noop', goal: 'noop' }) },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stdin.write(`${JSON.stringify({ id: 7, method: 'thread/start', params: {} })}\n`);
    await new Promise((resolve) => setTimeout(resolve, 200));
    child.kill('SIGKILL');
    const message = JSON.parse(stdout.trim().split('\n')[0]);
    expect(message.error.message).toMatch(/Not initialized/);
  });

  it('drives the local mock through the host client', async () => {
    const child = spawn(process.execPath, [
      driver,
      '--stdio',
      '--job',
      JSON.stringify({ id: 'noop', kind: 'noop', goal: 'noop from driver' }),
      '--timeout-ms',
      '8000',
    ], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    const code = await new Promise<number | null>((resolve) => child.on('exit', resolve));
    expect(stderr).toContain('turn/completed');
    expect(code).toBe(0);
    expect(JSON.parse(stdout).status).toBe('completed');
  });
});
