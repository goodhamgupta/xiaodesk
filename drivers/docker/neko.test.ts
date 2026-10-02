import { describe, expect, it } from 'vitest';
import { nekoContainerName, nekoRunArgs, resolveNekoImage } from './neko.js';

describe('neko container args', () => {
  it('builds a host-network container with a unique mux and the agents workspace mounted', () => {
    const args = nekoRunArgs({
      name: 'neko-ccarenvabc',
      image: 'workshop-neko:desk',
      bind: '127.0.0.1:8361',
      natIp: '172.30.0.2',
      udpMux: 53200,
      tcpMux: 53300,
      display: ':120.0',
      repoRoot: '/workspace',
      nodePath: '/usr/local/bin/node',
    });
    expect(args.slice(0, 4)).toEqual(['run', '-d', '--name', 'neko-ccarenvabc']);
    expect(args).toContain('--network');
    expect(args).toContain('host');
    expect(args).toContain('DISPLAY=:120.0');
    expect(args).toContain('NEKO_SERVER_BIND=127.0.0.1:8361');
    expect(args).toContain('NEKO_WEBRTC_UDPMUX=53200');
    expect(args).toContain('NEKO_WEBRTC_TCPMUX=53300');
    expect(args).toContain('NEKO_WEBRTC_NAT1TO1=172.30.0.2');
    expect(args).toContain('NEKO_WEBRTC_EPR=53200-53208');
    expect(args).toContain('/workspace:/workspace');
    expect(args).toContain('/usr/local/bin/node:/usr/local/bin/node:ro');
    expect(args).toContain('/opt/openclaw:/opt/openclaw:ro');
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
