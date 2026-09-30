import { describe, expect, it } from 'vitest';
import { assertSnapshotName } from './qmp.js';
import { blitRaw, type PixelFormat } from './vnc-record.js';

const fmt: PixelFormat = {
  bitsPerPixel: 32,
  bigEndian: false,
  redMax: 255,
  greenMax: 255,
  blueMax: 255,
  redShift: 16,
  greenShift: 8,
  blueShift: 0,
};

describe('snapshot names', () => {
  it('accepts a short tag', () => {
    expect(assertSnapshotName('lab1')).toBe('lab1');
  });

  it('rejects spaces and empty names', () => {
    expect(() => assertSnapshotName('lab 1')).toThrow(/snapshot name/);
    expect(() => assertSnapshotName('')).toThrow(/snapshot name/);
  });
});

describe('raw framebuffer blit', () => {
  it('unpacks little-endian 32-bit pixels into rgb24', () => {
    const raw = Buffer.alloc(8);
    raw.writeUInt32LE(0x00ff0000, 0);
    raw.writeUInt32LE(0x0000ff00, 4);
    const frame = Buffer.alloc(6);
    blitRaw(frame, 2, 0, 0, 2, 1, raw, fmt);
    expect([...frame]).toEqual([255, 0, 0, 0, 255, 0]);
  });
});
