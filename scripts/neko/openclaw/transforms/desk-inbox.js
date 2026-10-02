import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const inbox = process.env.OPENCLAW_DESK_INBOX || '/workspace/runs/openclaw/inbox.jsonl';

export function transform(ctx) {
  const payload = (ctx && ctx.payload) || {};
  const text = String(payload.text || payload.message || '').trim();
  const from = String(payload.from || payload.node || 'vm').trim() || 'vm';
  if (!text) return null;
  mkdirSync(dirname(inbox), { recursive: true });
  appendFileSync(inbox, `${JSON.stringify({ at: Date.now(), from, text })}\n`);
  return null;
}
