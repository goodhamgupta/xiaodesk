import { connect, type Socket } from 'net';

export function assertSnapshotName(name: string): string {
  if (!/^[A-Za-z0-9_-]{1,40}$/.test(name)) {
    throw Object.assign(new Error('snapshot name must match [A-Za-z0-9_-]{1,40}'), { status: 400 });
  }
  return name;
}

interface QmpMessage {
  QMP?: unknown;
  event?: string;
  error?: { desc?: string };
  return?: unknown;
}

export class Qmp {
  private buf = '';
  private pending: Array<{ resolve: (value: unknown) => void; reject: (error: Error) => void }> = [];
  private handshake: (() => void) | null = null;
  private failed: Error | null = null;

  private constructor(private socket: Socket) {}

  static async connect(socketPath: string, timeoutMs = 10000): Promise<Qmp> {
    const socket = connect(socketPath);
    const qmp = new Qmp(socket);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`QMP handshake timed out on ${socketPath}`)), timeoutMs);
      qmp.handshake = () => {
        clearTimeout(timer);
        resolve();
      };
      socket.once('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
      socket.on('data', (chunk) => qmp.onData(chunk));
    });
    await qmp.exec('qmp_capabilities');
    return qmp;
  }

  async exec(execute: string, args?: Record<string, unknown>, timeoutMs = 180000): Promise<unknown> {
    if (this.failed) throw this.failed;
    const payload = args ? { execute, arguments: args } : { execute };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`QMP ${execute} timed out`));
      }, timeoutMs);
      this.pending.push({
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      this.socket.write(`${JSON.stringify(payload)}\n`);
    });
  }

  close(): void {
    this.socket.destroy();
  }

  private onData(chunk: Buffer): void {
    this.buf += chunk.toString('utf8');
    let newline = this.buf.indexOf('\n');
    while (newline >= 0) {
      const line = this.buf.slice(0, newline).trim();
      this.buf = this.buf.slice(newline + 1);
      newline = this.buf.indexOf('\n');
      if (!line) continue;
      let message: QmpMessage;
      try {
        message = JSON.parse(line) as QmpMessage;
      } catch {
        continue;
      }
      if (message.QMP) {
        this.handshake?.();
        this.handshake = null;
        continue;
      }
      if (message.event) continue;
      const waiter = this.pending.shift();
      if (!waiter) continue;
      if (message.error) {
        const error = new Error(message.error.desc || 'QMP error');
        this.failed = error;
        waiter.reject(error);
        continue;
      }
      waiter.resolve(message.return);
    }
  }
}

function hmpFailed(text: string): boolean {
  return /error|not supported|failed|not found|does not have/i.test(text);
}

export async function saveVm(socketPath: string, name: string): Promise<string> {
  assertSnapshotName(name);
  const qmp = await Qmp.connect(socketPath);
  try {
    await qmp.exec('stop');
    try {
      const text = String(await qmp.exec('human-monitor-command', { 'command-line': `savevm ${name}` }) ?? '');
      if (hmpFailed(text)) throw new Error(text.trim() || 'savevm failed');
      return text.trim() || `saved ${name}`;
    } finally {
      await qmp.exec('cont').catch(() => undefined);
    }
  } finally {
    qmp.close();
  }
}

export async function loadVm(socketPath: string, name: string): Promise<string> {
  assertSnapshotName(name);
  const qmp = await Qmp.connect(socketPath);
  try {
    await qmp.exec('stop');
    try {
      const text = String(await qmp.exec('human-monitor-command', { 'command-line': `loadvm ${name}` }) ?? '');
      if (hmpFailed(text)) throw new Error(text.trim() || 'loadvm failed');
      return text.trim() || `restored ${name}`;
    } finally {
      await qmp.exec('cont').catch(() => undefined);
    }
  } finally {
    qmp.close();
  }
}

export async function listSnapshots(socketPath: string): Promise<{ raw: string; names: string[] }> {
  const qmp = await Qmp.connect(socketPath);
  try {
    const raw = String(await qmp.exec('human-monitor-command', { 'command-line': 'info snapshots' }) ?? '');
    const names: string[] = [];
    for (const line of raw.split(/\r?\n/)) {
      const match = line.trim().match(/^(?:\d+|--)\s+([A-Za-z0-9_-]{1,40})\b/);
      if (match) names.push(match[1]);
    }
    return { raw: raw.trim(), names };
  } finally {
    qmp.close();
  }
}
