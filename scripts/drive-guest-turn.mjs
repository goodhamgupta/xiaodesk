#!/usr/bin/env node
// Host side of one OSWorld turn. Speaks app-server JSON-RPC to a guest
// process over SSH, or to a local mock when --stdio is set. Holds the
// session until turn/completed so the remote server is not SIGHUPed.
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);

function flag(name) {
  const index = argv.indexOf(name);
  if (index < 0 || index + 1 >= argv.length) return undefined;
  return argv[index + 1];
}

const useStdio = argv.includes('--stdio');
const port = flag('--port');
const key = flag('--key');
const taskPath = flag('--task');
const jobInline = flag('--job');
const timeoutMs = Number(flag('--timeout-ms') || 30 * 60 * 1000);

let job = { id: 'osworld', goal: 'osworld' };
if (jobInline) job = JSON.parse(jobInline);
else if (taskPath) job = JSON.parse(readFileSync(taskPath, 'utf8'));
const goal = String(job.goal || job.id || 'osworld');

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

let child;
if (useStdio) {
  child = spawn(process.execPath, [join(here, 'guest/app-server.mjs')], {
    env: { ...process.env, GUEST_JOB_JSON: JSON.stringify(job) },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
} else {
  if (!port || !key) {
    console.error('usage: drive-guest-turn.mjs --port PORT --key KEY [--task FILE] | --stdio [--job JSON]');
    process.exit(2);
  }
  const remote = jobInline
    ? `GUEST_JOB_JSON=${shellQuote(JSON.stringify(job))} bash -lc 'exec node /tmp/app-server.mjs 2>>/tmp/osworld.log'`
    : "bash -lc 'exec node /tmp/app-server.mjs 2>>/tmp/osworld.log'";
  child = spawn('ssh', [
    '-i', key,
    '-p', String(port),
    '-o', 'StrictHostKeyChecking=no',
    '-o', 'UserKnownHostsFile=/dev/null',
    '-o', 'IdentitiesOnly=yes',
    '-o', 'BatchMode=yes',
    '-o', 'LogLevel=ERROR',
    'lume@127.0.0.1',
    remote,
  ], { stdio: ['pipe', 'pipe', 'pipe'] });
}

let stderr = '';
child.stderr.setEncoding('utf8');
child.stderr.on('data', (chunk) => {
  stderr = (stderr + chunk).slice(-4000);
  process.stderr.write(chunk);
});

const pending = new Map();
const notes = [];
let wake = null;
let nextId = 1;
let buffer = '';

function send(message) {
  child.stdin.write(`${JSON.stringify(message)}\n`);
}

function request(method, params) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    send({ id, method, params });
  });
}

child.stdout.setEncoding('utf8');
child.stdout.on('data', (chunk) => {
  buffer += chunk;
  let newline = buffer.indexOf('\n');
  while (newline >= 0) {
    const line = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    newline = buffer.indexOf('\n');
    if (!line) continue;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      process.stderr.write(`non-json rpc line: ${line}\n`);
      continue;
    }
    if (message.id !== undefined && (message.result !== undefined || message.error)) {
      const waiter = pending.get(message.id);
      pending.delete(message.id);
      if (!waiter) continue;
      if (message.error) waiter.reject(new Error(message.error.message || JSON.stringify(message.error)));
      else waiter.resolve(message.result);
      continue;
    }
    if (message.method) {
      notes.push(message);
      process.stderr.write(`${message.method}\n`);
      if (wake) {
        const fn = wake;
        wake = null;
        fn();
      }
    }
  }
});

let exited = false;
child.on('exit', (code) => {
  exited = true;
  const error = new Error(`app-server exited (${code}). ${stderr}`);
  for (const waiter of pending.values()) waiter.reject(error);
  pending.clear();
  if (wake) wake();
});

function pullNote(predicate) {
  const index = notes.findIndex(predicate);
  if (index < 0) return null;
  return notes.splice(index, 1)[0];
}

async function waitNote(predicate) {
  for (;;) {
    const found = pullNote(predicate);
    if (found) return found;
    if (exited) throw new Error(`app-server closed before ${predicate.name || 'notification'}. ${stderr}`);
    await new Promise((resolve) => {
      wake = resolve;
    });
  }
}

const timer = setTimeout(() => {
  child.kill('SIGKILL');
}, timeoutMs);
timer.unref?.();

try {
  const init = await request('initialize', {
    clientInfo: { name: 'microvm-workshop', title: 'MicroVM Workshop', version: '1.0.0' },
  });
  if (!init?.userAgent) throw new Error(`initialize returned no userAgent: ${JSON.stringify(init)}`);
  send({ method: 'initialized', params: {} });
  const started = await request('thread/start', { cwd: '/tmp', ephemeral: true });
  const threadId = started?.thread?.id;
  if (!threadId) throw new Error(`thread/start returned no thread id: ${JSON.stringify(started)}`);
  await request('turn/start', {
    threadId,
    input: [{ type: 'text', text: goal }],
  });
  const completed = await waitNote((message) => message.method === 'turn/completed');
  const status = completed.params?.turn?.status || 'unknown';
  const out = {
    status,
    userAgent: init.userAgent,
    threadId,
    error: completed.params?.turn?.error?.message,
  };
  process.stdout.write(`${JSON.stringify(out)}\n`);
  clearTimeout(timer);
  child.kill('SIGTERM');
  process.exit(status === 'completed' ? 0 : 1);
} catch (error) {
  clearTimeout(timer);
  console.error(error instanceof Error ? error.message : error);
  child.kill('SIGKILL');
  process.exit(1);
}
