import { describe, expect, it } from 'vitest';
import { buildQemuArgs, guestFixturesUrl, lumeCreateArgs, lumeRunArgs, selectBackendKind } from './compute.js';

describe('microvm command lines', () => {
  it('builds a kvm guest that reaches the host at 10.0.2.2 and a lume run with the display off', () => {
    const args = buildQemuArgs({
      accel: 'kvm',
      memoryMb: 1536,
      overlay: '/tmp/overlay.qcow2',
      sshPort: 25111,
      vncPort: 5911,
      serialLog: '/tmp/serial.log',
    });
    expect(args).toContain('-enable-kvm');
    expect(args.join(' ')).toContain('hostfwd=tcp:127.0.0.1:25111-:22');
    expect(args.join(' ')).toContain('127.0.0.1:11,share=force-shared');
    expect(args).not.toContain('-nographic');
    const tcg = buildQemuArgs({
      accel: 'tcg',
      memoryMb: 1536,
      overlay: '/tmp/overlay.qcow2',
      sshPort: 25111,
      vncPort: 5911,
      serialLog: '/tmp/serial.log',
    });
    expect(tcg.join(' ')).toContain('accel=tcg');
    expect(lumeCreateArgs('workshop-a')).toEqual(['create', 'workshop-a', '--os', 'linux', '--cpu', '2', '--memory', '2GB', '--disk-size', '12GB']);
    expect(lumeRunArgs('workshop-a', 5999)).toContain('--display');
    expect(lumeRunArgs('workshop-a', 5999)).toContain('none');
    expect(lumeRunArgs('workshop-a', 5999)).toContain('5999');
    expect(guestFixturesUrl('http://127.0.0.1:4317', '10.0.2.2')).toBe('http://10.0.2.2:4317');
    expect(selectBackendKind()).toBe(process.platform === 'darwin' ? 'lume' : 'kvm');
  });
});