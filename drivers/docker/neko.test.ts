import { describe, expect, it } from 'vitest';
import { existsSync } from 'fs';
import { nekoContainerName, nekoRunArgs, resolveNekoImage } from './neko.js';

describe('neko container args', () => {
  it('publishes ports on macOS and uses host networking on Linux', () => {
    const args = nekoRunArgs({
      name: 'neko-ccarenvabc',
      image: 'workshop-neko:desk',
      bind: '127.0.0.1:8361',
      natIp: '172.30.0.2',
      httpPort: 8361,
      vncPort: 5960,
      udpMux: 53200,
      tcpMux: 53300,
      display: ':99.0',
      repoRoot: '/workspace',
    });
    expect(args.slice(0, 4)).toEqual(['run', '-d', '--name', 'neko-ccarenvabc']);
    if (process.platform === 'darwin') {
      expect(args).toContain('-p');
      expect(args).toContain('127.0.0.1:8361:8361');
      expect(args).toContain('127.0.0.1:5960:5960');
      expect(args).not.toContain('--network');
    } else {
      expect(args).toContain('--network');
      expect(args).toContain('host');
    }
    expect(args).toContain('DISPLAY=:99.0');
    expect(args).toContain('NEKO_VNC_PORT=5960');
    expect(args).toContain('NEKO_WEBRTC_UDPMUX=53200');
    expect(args).toContain('NEKO_WEBRTC_TCPMUX=53300');
    expect(args).toContain('NEKO_WEBRTC_EPR=53200-53208');
    expect(args).not.toContain('/workspace:/workspace');
    expect(args).not.toContain('/usr/local/bin/node:/usr/local/bin/node:ro');
    if (existsSync('/opt/openclaw')) {
      expect(args).toContain('/opt/openclaw:/opt/openclaw:ro');
    } else {
      expect(args).not.toContain('/opt/openclaw:/opt/openclaw:ro');
    }
    expect(args).toContain('OPENCLAW_NODE_NAME=neko-ccarenvabc');
    expect(args[args.length - 1]).toBe('workshop-neko:desk');
    expect(nekoContainerName('ccarenv_0123456789abcdef')).toMatch(/^neko-[a-z0-9_.-]+$/);
    expect(nekoContainerName('ccarenv_0123456789abcdef')).not.toBe('workshop-neko');
  });

  it('prefers the committed desk image and honors NEKO_IMAGE', () => {
    expect(resolveNekoImage(['ghcr.io/m1k1o/neko/xfce:latest'], '')).toBe('ghcr.io/m1k1o/neko/xfce:latest');
    expect(resolveNekoImage(['workshop-neko:desk', 'ghcr.io/m1k1o/neko/xfce:latest'], '')).toBe('workshop-neko:desk');
    expect(resolveNekoImage(['workshop-neko:desk'], 'ghcr.io/m1k1o/neko/xfce:latest')).toBe('ghcr.io/m1k1o/neko/xfce:latest');
  });
});
