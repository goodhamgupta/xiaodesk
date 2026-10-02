export interface FleetPlan {
  kind: 'tell' | 'nodes' | 'state' | 'on' | 'desk';
  node?: string;
  text: string;
}

const NODE_NAME = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,63}$/;

export function planFleet(message: string): FleetPlan {
  const text = message.trim();
  const tell = text.match(/^(?:tell|message|ping)\s+main\b[:\s-]*(.*)$/i);
  if (tell) return { kind: 'tell', text: (tell[1] || '').trim() };
  if (/^(?:nodes|fleet|openclaw)(?:\s+status)?$/i.test(text)) return { kind: 'nodes', text };
  const state = text.match(/^(?:state|status)\s+(?:of\s+|on\s+)?([a-zA-Z0-9][a-zA-Z0-9_.-]{0,63})$/i);
  if (state && NODE_NAME.test(state[1])) return { kind: 'state', node: state[1], text: '' };
  const on = text.match(/^(?:on|ask|at)\s+([a-zA-Z0-9][a-zA-Z0-9_.-]{0,63})\b[:\s]+([\s\S]+)$/i);
  if (on && NODE_NAME.test(on[1])) {
    const body = on[2].trim();
    if (/^(?:state|status)$/i.test(body)) return { kind: 'state', node: on[1], text: body };
    return { kind: 'on', node: on[1], text: body };
  }
  return { kind: 'desk', text };
}

export function deskHookBody(from: string, text: string): { from: string; text: string } {
  return { from, text };
}

export function mcpDeskParams(action: Record<string, unknown>): { server: string; tool: string; arguments: Record<string, unknown> } {
  return { server: 'desk', tool: 'desk', arguments: action };
}

export function mcpShellParams(command: string): { server: string; tool: string; arguments: { command: string } } {
  return { server: 'desk', tool: 'sh', arguments: { command } };
}

export interface NodeRow {
  displayName?: string;
  connected?: boolean;
  approvalState?: string;
  commands?: string[];
}

export function summarizeNodes(nodes: NodeRow[]): string {
  if (!nodes.length) return 'No OpenClaw nodes are paired. The gateway approves a neko desktop a few seconds after it boots.';
  return nodes.map((node) => {
    const name = node.displayName || 'node';
    const link = node.connected ? 'connected' : 'offline';
    const approval = node.approvalState || 'unknown';
    return `${name}: ${link}, ${approval}`;
  }).join('\n');
}

export function mcpResultText(payload: unknown): string {
  if (!payload || typeof payload !== 'object') return '';
  const record = payload as { content?: Array<{ text?: string }>; text?: string; payload?: unknown };
  const content = record.content?.map((item) => item.text || '').filter(Boolean).join('\n');
  if (content) return content;
  if (typeof record.text === 'string') return record.text;
  if (record.payload) return mcpResultText(record.payload);
  return '';
}
