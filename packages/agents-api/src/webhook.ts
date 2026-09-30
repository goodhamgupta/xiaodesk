import { createHmac, timingSafeEqual } from 'crypto';

export function decodeWebhookSecret(secret: string): Buffer {
  const raw = secret.startsWith('whsec_') ? secret.slice('whsec_'.length) : secret;
  return Buffer.from(raw, 'base64');
}

export function signWebhook(secret: string, webhookId: string, timestamp: string, body: string): string {
  const mac = createHmac('sha256', decodeWebhookSecret(secret))
    .update(`${webhookId}.${timestamp}.${body}`)
    .digest('base64');
  return `v1,${mac}`;
}

function header(headers: Record<string, string | string[] | undefined>, name: string): string | undefined {
  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() !== wanted) continue;
    if (Array.isArray(value)) return value[0];
    return value;
  }
  return undefined;
}

export function verifyWebhook(
  secret: string,
  headers: Record<string, string | string[] | undefined>,
  body: string,
  nowSec = Date.now() / 1000,
): void {
  const id = header(headers, 'webhook-id');
  const timestamp = header(headers, 'webhook-timestamp');
  const signature = header(headers, 'webhook-signature');
  if (!id || !timestamp || !signature) {
    throw new Error('missing webhook signature headers');
  }
  const ts = Number(timestamp);
  if (!Number.isFinite(ts) || Math.abs(nowSec - ts) > 300) {
    throw new Error('webhook timestamp out of tolerance');
  }
  const expected = signWebhook(secret, id, timestamp, body).slice('v1,'.length);
  const expectedBuf = Buffer.from(expected);
  let matched = false;
  for (const part of signature.split(' ')) {
    const comma = part.indexOf(',');
    if (comma === -1) continue;
    const version = part.slice(0, comma);
    const value = part.slice(comma + 1);
    if (version !== 'v1' || !value) continue;
    const actual = Buffer.from(value);
    if (actual.length === expectedBuf.length && timingSafeEqual(actual, expectedBuf)) {
      matched = true;
    }
  }
  if (!matched) throw new Error('invalid webhook signature');
}
