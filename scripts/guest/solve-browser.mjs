#!/usr/bin/env node
// Headed Chrome on DISPLAY=:0. Drives the fixture apps through CDP so the VGA
// framebuffer shows the clicks. Node 22 has fetch and WebSocket; the guest
// image does not ship the Playwright npm package.
import { spawn, execFile } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const task = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const base = task.fixtures_url || process.env.FIXTURES_URL || 'http://10.0.2.2:4317';
const params = task.params || {};

function status(text) {
  if (process.env.OSWORLD_HOLD === '1' && text === 'ok') return;
  writeFileSync('/tmp/osworld-status', `${text}\n`);
}

function log(message) {
  console.log(message);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function chromeBin() {
  const root = '/opt/ms-playwright';
  if (!existsSync(root)) throw new Error('playwright chromium is not installed');
  for (const dir of readdirSync(root)) {
    const candidate = join(root, dir, 'chrome-linux64', 'chrome');
    if (existsSync(candidate)) return candidate;
  }
  throw new Error('chrome binary missing under /opt/ms-playwright');
}

function placeChrome() {
  const env = { ...process.env, DISPLAY: ':0' };
  for (const klass of ['Chromium', 'chrome', 'Google-chrome']) {
    execFile('xdotool', ['search', '--class', klass, 'windowsize', '1280', '800', 'windowmove', '0', '0', 'windowactivate'], { env }, () => {});
  }
}

class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    ws.addEventListener('message', (event) => {
      const message = JSON.parse(event.data);
      if (!message.id || !this.pending.has(message.id)) return;
      const { resolve, reject } = this.pending.get(message.id);
      this.pending.delete(message.id);
      if (message.error) reject(new Error(JSON.stringify(message.error)));
      else resolve(message.result);
    });
  }

  send(method, params = {}, timeoutMs = 20000) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`CDP timeout ${method}`)), timeoutMs);
      this.pending.set(id, {
        resolve: (value) => { clearTimeout(timer); resolve(value); },
        reject: (error) => { clearTimeout(timer); reject(error); },
      });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  async evaluate(expression) {
    const result = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.text || JSON.stringify(result.exceptionDetails));
    }
    return result.result?.value;
  }
}

async function connectCdp() {
  let wsUrl = '';
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      const list = await fetch('http://127.0.0.1:9222/json/list').then((res) => res.json());
      const page = list.find((entry) => entry.type === 'page' && entry.webSocketDebuggerUrl);
      if (page) {
        wsUrl = page.webSocketDebuggerUrl;
        break;
      }
    } catch {
      /* chrome is still binding the port */
    }
    await sleep(200);
  }
  if (!wsUrl) throw new Error('Chrome DevTools did not publish a page');
  const ws = new WebSocket(wsUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve);
    ws.addEventListener('error', () => reject(new Error('CDP websocket failed')));
  });
  const cdp = new Cdp(ws);
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  return { cdp, ws };
}

function boxExpression(selector) {
  return `(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return null;
    el.scrollIntoView({ block: 'center', inline: 'center' });
    const r = el.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2, href: location.href };
  })()`;
}

async function waitFor(cdp, selector, timeoutMs = 20000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const found = await cdp.evaluate(`!!document.querySelector(${JSON.stringify(selector)})`);
    if (found) return;
    await sleep(200);
  }
  const href = await cdp.evaluate('location.href').catch(() => '');
  throw new Error(`timed out waiting for ${selector} at ${href}`);
}

async function click(cdp, selector) {
  await waitFor(cdp, selector);
  const box = await cdp.evaluate(boxExpression(selector));
  if (!box) throw new Error(`missing ${selector}`);
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: box.x, y: box.y });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: box.x, y: box.y, button: 'left', clickCount: 1 });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: box.x, y: box.y, button: 'left', clickCount: 1 });
  await sleep(350);
}

async function fill(cdp, selector, value) {
  await click(cdp, selector);
  await cdp.send('Input.dispatchKeyEvent', {
    type: 'keyDown', modifiers: 2, key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65,
  });
  await cdp.send('Input.dispatchKeyEvent', {
    type: 'keyUp', modifiers: 2, key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65,
  });
  await cdp.send('Input.insertText', { text: String(value) });
  await sleep(200);
}

async function choose(cdp, selector, value) {
  await click(cdp, selector);
  const applied = await cdp.evaluate(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    el.value = ${JSON.stringify(String(value))};
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return el.value;
  })()`);
  if (applied !== String(value)) throw new Error(`${selector} stayed ${applied}`);
  await sleep(250);
}

async function goto(cdp, url) {
  log(`goto ${url}`);
  await cdp.send('Page.navigate', { url });
  const start = Date.now();
  while (Date.now() - start < 20000) {
    const state = await cdp.evaluate('document.readyState').catch(() => 'loading');
    if (state === 'complete') break;
    await sleep(150);
  }
  await sleep(400);
  placeChrome();
}

async function runOnboarding(cdp) {
  await goto(cdp, `${base}/onboarding`);
  await fill(cdp, '[data-testid="name-input"]', params.name);
  await fill(cdp, '[data-testid="email-input"]', params.email);
  await click(cdp, '[data-testid="continue-btn"]');
  await waitFor(cdp, `[data-testid="plan-${params.plan}"]`);
  await click(cdp, `label.plan:has([data-testid="plan-${params.plan}"])`);
  await click(cdp, '[data-testid="continue-btn"]');
  await waitFor(cdp, '[data-testid="accept-checkbox"]');
  await click(cdp, '[data-testid="accept-checkbox"]');
  await click(cdp, '[data-testid="continue-btn"]');
  await waitFor(cdp, '[data-testid="download-btn"]');
  await click(cdp, '[data-testid="download-btn"]');
  await sleep(1200);
  const user = await cdp.evaluate(`fetch('/onboarding/api/user').then((res) => res.json())`);
  if (user?.user?.email !== params.email || user?.user?.plan !== params.plan) {
    throw new Error(`onboarding row mismatch ${JSON.stringify(user)}`);
  }
  if (!user.user.terms_accepted_at) throw new Error('terms were not accepted');
  if (!Array.isArray(user.downloads) || user.downloads.length < 1) throw new Error('welcome PDF was not recorded');
}

async function runSupport(cdp) {
  await goto(cdp, `${base}/support/ticket/${params.ticket_id}`);
  await choose(cdp, '[data-testid="status-select"]', params.status);
  if (params.priority) await choose(cdp, '[data-testid="priority-select"]', params.priority);
  if (params.assignee !== undefined) await choose(cdp, '[data-testid="assignee-select"]', params.assignee);
  await fill(cdp, '[data-testid="tags-input"]', params.tags);
  await click(cdp, '[data-testid="update-ticket"]');
  await waitFor(cdp, '[data-testid="reply-input"]');
  await fill(cdp, '[data-testid="reply-input"]', params.reply);
  await click(cdp, '[data-testid="submit-reply"]');
  await waitFor(cdp, '[data-testid="replies-container"]');
  await sleep(600);
  const ticket = await cdp.evaluate(`fetch('/support/api/ticket/${params.ticket_id}').then((res) => res.json())`);
  if (ticket.status !== params.status) throw new Error(`status ${ticket.status}`);
  if (params.assignee && ticket.assignee !== params.assignee) throw new Error(`assignee ${ticket.assignee}`);
  const replies = ticket.replies || [];
  if (!replies.some((reply) => reply.content === params.reply)) throw new Error('reply missing');
}

async function runBooking(cdp) {
  const query = new URLSearchParams();
  query.set('date', params.date);
  query.set('min_capacity', String(params.party_size));
  if (params.max_price) query.set('max_price', String(params.max_price));
  if (params.accessibility) query.set('accessibility', 'true');
  await goto(cdp, `${base}/booking?${query}`);
  await waitFor(cdp, 'a.btn:not(.disabled)');
  await click(cdp, 'a.btn:not(.disabled)');
  await waitFor(cdp, '.slot');
  await click(cdp, '.slot');
  const selected = await cdp.evaluate(`document.getElementById('selected_slot') && document.getElementById('selected_slot').value`);
  if (!selected) {
    await cdp.evaluate(`(() => { const slot = document.querySelector('.slot'); slot.click(); return document.getElementById('selected_slot').value; })()`);
  }
  await fill(cdp, '[data-testid="guest-name"]', params.guest_name);
  await fill(cdp, '[data-testid="guest-email"]', params.guest_email);
  await fill(cdp, '[data-testid="party-size"]', String(params.party_size));
  await click(cdp, '[data-testid="confirm-booking"]');
  await waitFor(cdp, '[data-testid="confirmation-id"]');
  const body = await cdp.evaluate(`fetch('/booking/api/reservations?guest_email=${encodeURIComponent(params.guest_email)}').then((res) => res.json())`);
  const row = (body.reservations || [])[0];
  if (!row || row.party_size !== params.party_size || row.date !== params.date) {
    throw new Error(`reservation mismatch ${JSON.stringify(body)}`);
  }
}

async function main() {
  status('running');
  rmSync('/tmp/chrome-profile', { recursive: true, force: true });
  const bin = chromeBin();
  log(`chrome ${bin}`);
  const chrome = spawn(bin, [
    '--no-sandbox',
    '--disable-dev-shm-usage',
    '--disable-gpu',
    '--ozone-platform=x11',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-fre',
    '--disable-features=TranslateUI',
    '--window-size=1280,800',
    '--window-position=0,0',
    '--start-maximized',
    '--user-data-dir=/tmp/chrome-profile',
    '--remote-debugging-port=9222',
    'about:blank',
  ], {
    env: { ...process.env, DISPLAY: ':0', HOME: process.env.HOME || '/home/lume' },
    detached: true,
    stdio: 'ignore',
  });
  chrome.unref();
  writeFileSync('/tmp/chrome.pid', `${chrome.pid}\n`);
  const placer = setInterval(placeChrome, 1500);
  let ws;
  try {
    const session = await connectCdp();
    ws = session.ws;
    placeChrome();
    if (task.pack === 'onboarding') await runOnboarding(session.cdp);
    else if (task.pack === 'support') await runSupport(session.cdp);
    else if (task.pack === 'booking') await runBooking(session.cdp);
    else throw new Error(`unknown browser pack ${task.pack}`);
    status('ok');
    log('ok');
  } finally {
    clearInterval(placer);
    try { ws?.close(); } catch { /* already closed */ }
    try { process.kill(-chrome.pid, 'SIGTERM'); } catch { /* chrome already left */ }
  }
}

main().catch((error) => {
  console.error(error);
  status('fail');
  process.exit(1);
});
