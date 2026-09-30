import { connect, type Socket } from 'net';
import { spawn, type ChildProcess } from 'child_process';
import { mkdirSync } from 'fs';
import { dirname } from 'path';

export interface PixelFormat {
  bitsPerPixel: number;
  bigEndian: boolean;
  redMax: number;
  greenMax: number;
  blueMax: number;
  redShift: number;
  greenShift: number;
  blueShift: number;
}

export function blitRaw(
  frame: Buffer,
  width: number,
  x: number,
  y: number,
  rectW: number,
  rectH: number,
  raw: Buffer,
  fmt: PixelFormat,
): void {
  const bpp = fmt.bitsPerPixel / 8;
  for (let row = 0; row < rectH; row += 1) {
    for (let col = 0; col < rectW; col += 1) {
      const src = (row * rectW + col) * bpp;
      let pixel = 0;
      if (fmt.bitsPerPixel === 32) pixel = fmt.bigEndian ? raw.readUInt32BE(src) : raw.readUInt32LE(src);
      else if (fmt.bitsPerPixel === 16) pixel = fmt.bigEndian ? raw.readUInt16BE(src) : raw.readUInt16LE(src);
      else pixel = raw[src] ?? 0;
      const dst = ((y + row) * width + (x + col)) * 3;
      frame[dst] = channel(pixel, fmt.redShift, fmt.redMax);
      frame[dst + 1] = channel(pixel, fmt.greenShift, fmt.greenMax);
      frame[dst + 2] = channel(pixel, fmt.blueShift, fmt.blueMax);
    }
  }
}

function channel(pixel: number, shift: number, max: number): number {
  const value = (pixel >>> shift) & max;
  return max === 255 ? value : Math.round((value * 255) / (max || 1));
}

export interface RecordingHandle {
  file: string;
  guestId: string;
  stop: () => Promise<void>;
}

export function startVncRecording(options: {
  host: string;
  port: number;
  file: string;
  guestId: string;
}): Promise<RecordingHandle> {
  mkdirSync(dirname(options.file), { recursive: true });
  return new Promise((resolve, reject) => {
    const socket = connect({ host: options.host, port: options.port });
    socket.setNoDelay(true);
    const recorder = new RfbRecorder(socket, options.file, (error) => {
      if (!settled) {
        settled = true;
        reject(error);
      }
    });
    let settled = false;
    socket.once('error', (error) => {
      if (!settled) {
        settled = true;
        reject(error);
      }
    });
    recorder.onceReady(() => {
      if (settled) return;
      settled = true;
      resolve({
        file: options.file,
        guestId: options.guestId,
        stop: () => recorder.stop(),
      });
    });
  });
}

class RfbRecorder {
  private buf = Buffer.alloc(0);
  private phase: 'banner' | 'security' | 'result' | 'init' | 'name' | 'msgs' | 'rects' | 'raw' = 'banner';
  private securityCount = 0;
  private nameLength = 0;
  private rectsLeft = 0;
  private raw: { x: number; y: number; w: number; h: number; need: number } | null = null;
  private fmt: PixelFormat = {
    bitsPerPixel: 32,
    bigEndian: false,
    redMax: 255,
    greenMax: 255,
    blueMax: 255,
    redShift: 16,
    greenShift: 8,
    blueShift: 0,
  };
  private width = 0;
  private height = 0;
  private frame: Buffer | null = null;
  private ffmpeg: ChildProcess | null = null;
  private timer: NodeJS.Timeout | null = null;
  private ready: (() => void) | null = null;
  private stopped = false;
  private fail: (error: Error) => void;

  constructor(
    private socket: Socket,
    private file: string,
    fail: (error: Error) => void,
  ) {
    this.fail = fail;
    socket.on('data', (chunk) => {
      this.buf = Buffer.concat([this.buf, chunk]);
      try {
        this.pump();
      } catch (error) {
        this.fail(error instanceof Error ? error : new Error(String(error)));
        this.socket.destroy();
      }
    });
    socket.on('close', () => {
      if (!this.ffmpeg && !this.stopped) this.fail(new Error('VNC closed before the first frame'));
    });
  }

  onceReady(cb: () => void): void {
    this.ready = cb;
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.socket.destroy();
    const ffmpeg = this.ffmpeg;
    if (!ffmpeg) return;
    await new Promise<void>((resolve) => {
      ffmpeg.once('close', () => resolve());
      ffmpeg.stdin?.end();
      setTimeout(() => {
        ffmpeg.kill('SIGKILL');
        resolve();
      }, 8000);
    });
  }

  private pump(): void {
    for (;;) {
      if (this.phase === 'banner') {
        if (this.buf.length < 12) return;
        const banner = this.take(12).toString('ascii');
        if (!banner.startsWith('RFB ')) throw new Error(`unexpected VNC banner ${banner.trim()}`);
        this.socket.write(Buffer.from('RFB 003.008\n'));
        this.phase = 'security';
        continue;
      }
      if (this.phase === 'security') {
        if (this.buf.length < 1) return;
        this.securityCount = this.buf[0];
        if (this.buf.length < 1 + this.securityCount) return;
        const types = [...this.take(1 + this.securityCount).subarray(1)];
        if (!types.includes(1)) throw new Error(`VNC has no None security (types ${types.join(',')})`);
        this.socket.write(Buffer.from([1]));
        this.phase = 'result';
        continue;
      }
      if (this.phase === 'result') {
        if (this.buf.length < 4) return;
        const result = this.take(4).readUInt32BE(0);
        if (result !== 0) throw new Error(`VNC security failed (${result})`);
        this.socket.write(Buffer.from([1]));
        this.phase = 'init';
        continue;
      }
      if (this.phase === 'init') {
        if (this.buf.length < 24) return;
        const header = this.take(24);
        this.width = header.readUInt16BE(0);
        this.height = header.readUInt16BE(2);
        this.fmt = {
          bitsPerPixel: header[4],
          bigEndian: header[6] === 1,
          redMax: header.readUInt16BE(8),
          greenMax: header.readUInt16BE(10),
          blueMax: header.readUInt16BE(12),
          redShift: header[14],
          greenShift: header[15],
          blueShift: header[16],
        };
        this.nameLength = header.readUInt32BE(20);
        this.phase = 'name';
        continue;
      }
      if (this.phase === 'name') {
        if (this.buf.length < this.nameLength) return;
        this.take(this.nameLength);
        this.frame = Buffer.alloc(this.width * this.height * 3);
        this.sendEncodings();
        this.request(false);
        this.startFfmpeg();
        this.phase = 'msgs';
        continue;
      }
      if (this.phase === 'msgs') {
        if (this.buf.length < 1) return;
        const type = this.buf[0];
        if (type === 0) {
          if (this.buf.length < 4) return;
          this.rectsLeft = this.take(4).readUInt16BE(2);
          this.phase = 'rects';
          continue;
        }
        if (type === 1) {
          if (this.buf.length < 6) return;
          const colours = this.buf.readUInt16BE(4);
          const bytes = 6 + colours * 6;
          if (this.buf.length < bytes) return;
          this.take(bytes);
          continue;
        }
        if (type === 2) {
          this.take(1);
          continue;
        }
        if (type === 3) {
          if (this.buf.length < 8) return;
          const length = this.buf.readInt32BE(4);
          const bytes = 8 + Math.max(0, length);
          if (this.buf.length < bytes) return;
          this.take(bytes);
          continue;
        }
        throw new Error(`unsupported VNC server message ${type}`);
      }
      if (this.phase === 'rects') {
        if (this.rectsLeft === 0) {
          this.request(true);
          this.phase = 'msgs';
          continue;
        }
        if (this.buf.length < 12) return;
        const header = this.buf.subarray(0, 12);
        const encoding = header.readInt32BE(8);
        if (encoding !== 0) throw new Error(`VNC encoding ${encoding} is not Raw`);
        this.take(12);
        const w = header.readUInt16BE(4);
        const h = header.readUInt16BE(6);
        const bpp = this.fmt.bitsPerPixel / 8;
        this.raw = { x: header.readUInt16BE(0), y: header.readUInt16BE(2), w, h, need: w * h * bpp };
        this.phase = 'raw';
        continue;
      }
      if (this.phase === 'raw') {
        const raw = this.raw;
        if (!raw) throw new Error('raw rect missing');
        if (this.buf.length < raw.need) return;
        const bytes = this.take(raw.need);
        if (this.frame) blitRaw(this.frame, this.width, raw.x, raw.y, raw.w, raw.h, bytes, this.fmt);
        this.raw = null;
        this.rectsLeft -= 1;
        this.phase = 'rects';
        continue;
      }
    }
  }

  private take(n: number): Buffer {
    const out = this.buf.subarray(0, n);
    this.buf = this.buf.subarray(n);
    return out;
  }

  private sendEncodings(): void {
    const msg = Buffer.alloc(8);
    msg[0] = 2;
    msg.writeUInt16BE(1, 2);
    msg.writeInt32BE(0, 4);
    this.socket.write(msg);
  }

  private request(incremental: boolean): void {
    const msg = Buffer.alloc(10);
    msg[0] = 3;
    msg[1] = incremental ? 1 : 0;
    msg.writeUInt16BE(this.width, 6);
    msg.writeUInt16BE(this.height, 8);
    this.socket.write(msg);
  }

  private startFfmpeg(): void {
    const evenW = this.width - (this.width % 2);
    const evenH = this.height - (this.height % 2);
    const ffmpeg = spawn('ffmpeg', [
      '-loglevel', 'error',
      '-y',
      '-f', 'rawvideo',
      '-pix_fmt', 'rgb24',
      '-s', `${evenW}x${evenH}`,
      '-r', '4',
      '-i', 'pipe:0',
      '-an',
      '-c:v', 'libx264',
      '-preset', 'ultrafast',
      '-pix_fmt', 'yuv420p',
      '-movflags', '+faststart',
      this.file,
    ], { stdio: ['pipe', 'ignore', 'pipe'] });
    this.ffmpeg = ffmpeg;
    let stderr = '';
    ffmpeg.stderr.on('data', (chunk) => {
      stderr += chunk.toString('utf8');
    });
    ffmpeg.on('error', (error) => {
      if (!this.stopped) this.fail(error);
    });
    ffmpeg.on('exit', (code) => {
      if (!this.stopped && code !== 0) this.fail(new Error(stderr.trim() || `ffmpeg exited ${code}`));
    });
    this.timer = setInterval(() => this.writeFrame(evenW, evenH), 250);
    this.writeFrame(evenW, evenH);
    this.ready?.();
  }

  private writeFrame(evenW: number, evenH: number): void {
    const frame = this.frame;
    const ffmpeg = this.ffmpeg;
    const stdin = ffmpeg?.stdin;
    if (!frame || !stdin || stdin.destroyed || stdin.writableLength > 8_000_000) return;
    try {
      if (evenW === this.width && evenH === this.height) {
        stdin.write(frame);
        return;
      }
      const cropped = Buffer.alloc(evenW * evenH * 3);
      for (let row = 0; row < evenH; row += 1) {
        frame.copy(cropped, row * evenW * 3, row * this.width * 3, row * this.width * 3 + evenW * 3);
      }
      stdin.write(cropped);
    } catch {
      /* ffmpeg closed the pipe */
    }
  }
}
