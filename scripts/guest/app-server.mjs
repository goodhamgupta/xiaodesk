#!/usr/bin/env node
// In-guest stand-in for `codex app-server`. Stdout is JSON-RPC only.
// Solver stdout/stderr go to /tmp/osworld.log so they cannot corrupt the stream.
// This image has no codex binary. A real binary is still `codex app-server`.
import { spawn } from 'node:child_process';
import { closeSync, openSync, readFileSync, writeFileSync } from 'node:fs';

const LOG = '/tmp/osworld.log';
const STATUS = '/tmp/osworld-status';

let initialized = false;
let initSeen = false;
const threads = new Map();

function write(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function reply(id, result) {
  write({ id, result });
}

function fail(id, code, message) {
  write({ id, error: { code, message } });
}

function notify(method, params) {
  write({ method, params });
}

function loadJob() {
  if (process.env.GUEST_JOB_JSON) return JSON.parse(process.env.GUEST_JOB_JSON);
  const path = process.argv[2] || '/tmp/task.json';
  return JSON.parse(readFileSync(path, 'utf8'));
}

function status(text) {
  writeFileSync(STATUS, `${text}\n`);
}

function solverSpec(job) {
  if (job.kind === 'noop' || job.pack === 'noop') {
    if (job.stdout_probe) {
      return { cmd: process.execPath, args: ['-e', 'console.log("solver-stdout")'], label: 'probe' };
    }
    return null;
  }
  if (job.kind === 'workflow' || job.browser_task) {
    return { cmd: 'bash', args: ['/tmp/run-flow.sh'], label: 'workflow' };
  }
  if (job.kind === 'browser' || job.pack === 'onboarding' || job.pack === 'support' || job.pack === 'booking') {
    return { cmd: process.execPath, args: ['/tmp/solve-browser.mjs', '/tmp/task.json'], label: 'browser' };
  }
  return { cmd: 'python3', args: ['/tmp/solve_calc.py', '/tmp/task.json'], label: 'calc' };
}

function runSolver(spec) {
  const logFd = openSync(LOG, 'a');
  return new Promise((resolve) => {
    const child = spawn(spec.cmd, spec.args, {
      env: { ...process.env, DISPLAY: ':0' },
      stdio: ['ignore', logFd, logFd],
    });
    closeSync(logFd);
    child.on('error', (error) => resolve({ code: 1, error: error.message }));
    child.on('exit', (code) => resolve({ code: code ?? 1 }));
  });
}

async function handleTurn(id, params) {
  const threadId = String(params.threadId || '');
  if (!threads.has(threadId)) {
    fail(id, -32602, `Unknown thread ${threadId}`);
    return;
  }
  const turn = { id: `turn_${Date.now()}`, threadId, status: 'inProgress' };
  reply(id, { turn });
  notify('turn/started', { turn });
  status('running');

  let job;
  try {
    job = loadJob();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    status('fail');
    notify('turn/completed', { turn: { ...turn, status: 'failed', error: { message } } });
    return;
  }

  const spec = solverSpec(job);
  try {
    if (spec) {
      notify('item/completed', { item: { type: 'solver', id: `item_${Date.now()}`, text: spec.label } });
      const result = await runSolver(spec);
      if (result.code !== 0) {
        const message = result.error || `solver ${spec.label} exited ${result.code}`;
        status('fail');
        notify('turn/completed', { turn: { ...turn, status: 'failed', error: { message } } });
        return;
      }
    }
    status('ok');
    notify('turn/completed', { turn: { ...turn, status: 'completed' } });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(message);
    status('fail');
    notify('turn/completed', { turn: { ...turn, status: 'failed', error: { message } } });
  }
}

async function handle(message) {
  const { id, method, params = {} } = message;
  if (method === 'initialize') {
    if (initSeen) {
      fail(id, -32600, 'Already initialized');
      return;
    }
    initSeen = true;
    reply(id, {
      userAgent: 'microvm-workshop-mock-app-server/1.0.0',
      platformFamily: 'lab',
      platformOs: process.platform,
    });
    return;
  }
  if (method === 'initialized') {
    initialized = true;
    return;
  }
  if (!initialized) {
    fail(id, -32600, 'Not initialized');
    return;
  }
  if (method === 'thread/start') {
    const thread = {
      id: `thr_${Math.random().toString(36).slice(2, 10)}`,
      ephemeral: true,
      path: null,
      status: 'idle',
      cwd: params.cwd ?? null,
    };
    threads.set(thread.id, thread);
    notify('thread/started', { thread });
    reply(id, { thread });
    return;
  }
  if (method === 'turn/start') {
    if (id === undefined) {
      fail(id, -32600, 'turn/start requires an id');
      return;
    }
    await handleTurn(id, params);
    return;
  }
  fail(id, -32601, `Method not found: ${method}`);
}

const incoming = [];
let pumping = false;

async function pump() {
  if (pumping) return;
  pumping = true;
  while (incoming.length) {
    const message = incoming.shift();
    try {
      await handle(message);
    } catch (error) {
      console.error(error);
      if (message.id !== undefined) {
        fail(message.id, -32000, error instanceof Error ? error.message : String(error));
      }
    }
  }
  pumping = false;
}

let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let newline = buffer.indexOf('\n');
  while (newline >= 0) {
    const line = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    newline = buffer.indexOf('\n');
    if (!line) continue;
    try {
      incoming.push(JSON.parse(line));
    } catch (error) {
      console.error(error);
    }
  }
  void pump();
});

process.stdin.on('end', () => {
  setTimeout(() => process.exit(0), 50);
});
