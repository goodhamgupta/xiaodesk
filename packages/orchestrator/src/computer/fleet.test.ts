import { describe, expect, it } from 'vitest';
import { deskHookBody, mcpDeskParams, mcpResultText, mcpShellParams, planFleet, summarizeNodes } from './fleet.js';

describe('openclaw fleet planner', () => {
  it('sends a VM line to the main chat', () => {
    expect(planFleet('tell main the terminal is open')).toEqual({ kind: 'tell', text: 'the terminal is open' });
    expect(deskHookBody('workshop-neko', 'the terminal is open')).toEqual({
      from: 'workshop-neko',
      text: 'the terminal is open',
    });
  });

  it('lists nodes and reads one VM', () => {
    expect(planFleet('nodes').kind).toBe('nodes');
    expect(planFleet('state of workshop-neko')).toEqual({ kind: 'state', node: 'workshop-neko', text: '' });
    expect(planFleet('on workshop-neko state')).toEqual({ kind: 'state', node: 'workshop-neko', text: 'state' });
  });

  it('routes a desktop task to one node', () => {
    const plan = planFleet('on workshop-neko open the terminal and run uname -a');
    expect(plan).toEqual({ kind: 'on', node: 'workshop-neko', text: 'open the terminal and run uname -a' });
    expect(mcpDeskParams({ op: 'terminal', command: 'uname -a' })).toEqual({
      server: 'desk',
      tool: 'desk',
      arguments: { op: 'terminal', command: 'uname -a' },
    });
    expect(mcpShellParams('uname -a').tool).toBe('sh');
  });

  it('leaves ordinary desk messages on the local planner', () => {
    expect(planFleet('open the terminal').kind).toBe('desk');
  });

  it('summarizes paired nodes and MCP text', () => {
    expect(summarizeNodes([{ displayName: 'workshop-neko', connected: true, approvalState: 'approved' }])).toBe(
      'workshop-neko: connected, approved',
    );
    expect(mcpResultText({ content: [{ text: '{"ok":true}' }] })).toBe('{"ok":true}');
    expect(summarizeNodes([])).toMatch(/No OpenClaw nodes/);
  });
});
