import { describe, expect, it } from 'vitest';
import { planDesk } from './plan.js';

describe('desk planner', () => {
  it('opens chrome at a url', () => {
    const plan = planDesk('open chrome and go to https://example.com');
    expect(plan.actions).toEqual([{ op: 'chrome', url: 'https://example.com' }]);
  });

  it('types a command in the terminal', () => {
    const plan = planDesk('open the terminal and run echo hello from the bot');
    expect(plan.actions).toEqual([{ op: 'terminal', command: 'echo hello from the bot' }]);
  });

  it('opens the file browser at a path', () => {
    const plan = planDesk('open the file browser at /home/lume/Desktop');
    expect(plan.actions).toEqual([{ op: 'files', path: '/home/lume/Desktop' }]);
  });

  it('chains chrome and a terminal command', () => {
    const plan = planDesk('open chrome to https://example.com then open the terminal and run date');
    expect(plan.actions.map((action) => action.op)).toEqual(['chrome', 'terminal']);
    expect(plan.actions[1].command).toBe('date');
  });

  it('writes a desktop file and shows it', () => {
    const plan = planDesk('create a file called hello.txt on the desktop that says hi from the desk');
    expect(plan.actions[0].op).toBe('terminal');
    expect(plan.actions[0].command).toContain('/home/lume/Desktop/hello.txt');
    expect(plan.actions[0].command).toContain('hi from the desk');
    expect(plan.actions[1]).toEqual({ op: 'files', path: '/home/lume/Desktop' });
  });

  it('asks for an app when the message is not a desktop action', () => {
    const plan = planDesk('thanks');
    expect(plan.actions).toEqual([]);
    expect(plan.say).toMatch(/Chrome/);
  });
});
