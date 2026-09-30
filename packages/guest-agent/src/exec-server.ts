import { WebSocket } from 'ws';
import { runGuestJob } from './run-job.js';
import type { JobCard } from './stub/stub-agent.js';

function arg(flag: string): string | undefined {
  const index = process.argv.indexOf(flag);
  if (index === -1) return undefined;
  return process.argv[index + 1];
}

interface Command {
  type: 'command';
  id: string;
  name: string;
  input?: unknown;
  job?: JobCard | null;
  fixtures_url?: string | null;
  browser_mode?: string | null;
}

const remote = arg('--remote');
const environmentId = arg('--environment-id');
const apiKey = process.env.CODEX_API_KEY || '';

if (!remote || !environmentId) {
  console.error('usage: codex exec-server --remote <url> --environment-id <id>');
  process.exit(2);
}
if (!apiKey) {
  console.error('CODEX_API_KEY is required');
  process.exit(2);
}

let ran = false;

function connect(attempt: number): void {
  const ws = new WebSocket(remote!, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });

  ws.on('open', () => {
    ws.send(JSON.stringify({ type: 'register', environment_id: environmentId }));
  });

  ws.on('message', (raw) => {
    const message = JSON.parse(String(raw)) as { type?: string; message?: string };
    if (message.type === 'error') {
      console.error(message.message || 'exec-server rejected');
      process.exit(1);
    }
    if (message.type === 'registered') {
      console.error(`registered ${environmentId}`);
      return;
    }
    if (message.type !== 'command') return;
    const command = message as Command;
    if (command.name !== 'run_job') {
      ws.send(JSON.stringify({
        type: 'command_result',
        id: command.id,
        ok: false,
        error: `unsupported command ${command.name}`,
      }));
      return;
    }
    if (ran) {
      ws.send(JSON.stringify({
        type: 'command_result',
        id: command.id,
        ok: false,
        error: 'a killed command is not restarted',
      }));
      return;
    }
    ran = true;
    if (command.fixtures_url) process.env.FIXTURES_URL = command.fixtures_url;
    if (command.browser_mode) process.env.BROWSER_MODE = command.browser_mode;
    const job = command.job;
    if (!job) {
      ws.send(JSON.stringify({ type: 'command_result', id: command.id, ok: false, error: 'run_job missing job' }));
      return;
    }
    void (async () => {
      try {
        await runGuestJob(job, (event) => {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({
              type: 'event',
              command_id: command.id,
              name: event.type,
              data: event.data,
            }));
          }
        });
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'command_result', id: command.id, ok: true, output: 'ok' }));
        }
      } catch (error) {
        const text = error instanceof Error ? error.message : String(error);
        console.error(text);
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'command_result', id: command.id, ok: false, error: text }));
        }
      }
    })();
  });

  ws.on('close', () => {
    if (ran) return;
    if (attempt >= 5) {
      console.error('exec-server gave up reconnecting');
      process.exit(1);
    }
    setTimeout(() => connect(attempt + 1), 500 * (attempt + 1));
  });

  ws.on('error', (error) => {
    console.error(`exec-server socket: ${error.message}`);
  });
}

connect(0);
