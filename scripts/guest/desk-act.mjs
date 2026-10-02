#!/usr/bin/env node
// One desktop action on DISPLAY=:0. Stdout is a single JSON object.
import { spawn, execFile } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const env = { ...process.env, DISPLAY: ':0', HOME: process.env.HOME || '/home/lume' };
const home = env.HOME;

function out(payload) {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

function exec(cmd, args, timeout = 15000) {
  return new Promise((resolve) => {
    execFile(cmd, args, { env, timeout }, (error, stdout, stderr) => {
      resolve({
        ok: !error,
        stdout: String(stdout || ''),
        stderr: String(stderr || ''),
        error: error ? error.message : '',
      });
    });
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function chromeBin() {
  const root = '/opt/ms-playwright';
  if (!existsSync(root)) return '';
  for (const dir of readdirSync(root)) {
    const candidate = join(root, dir, 'chrome-linux64', 'chrome');
    if (existsSync(candidate)) return candidate;
  }
  return '';
}

function launch(cmd, args) {
  const child = spawn(cmd, args, { env, detached: true, stdio: 'ignore' });
  child.unref();
  return child.pid;
}

async function windowIds(klass) {
  const found = await exec('xdotool', ['search', '--class', klass]);
  return found.stdout.split('\n').map((line) => line.trim()).filter(Boolean);
}

async function windowTitle(id) {
  const name = await exec('xdotool', ['getwindowname', id]);
  return name.stdout.trim();
}

async function geometry(id) {
  const geo = await exec('xdotool', ['getwindowgeometry', '--shell', id]);
  const width = Number((geo.stdout.match(/^WIDTH=(\d+)/m) || [])[1] || 0);
  const height = Number((geo.stdout.match(/^HEIGHT=(\d+)/m) || [])[1] || 0);
  return { width, height };
}

async function place(klass, resize, skipTitles = []) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const ids = await windowIds(klass);
    let id = '';
    for (const candidate of ids) {
      const title = await windowTitle(candidate);
      if (!title) continue;
      if (skipTitles.includes(title)) continue;
      id = candidate;
    }
    if (!id && ids.length && skipTitles.length === 0) id = ids[ids.length - 1];
    if (id) {
      if (resize) await exec('xdotool', ['windowsize', id, '1280', '800']);
      await exec('xdotool', ['windowmove', id, '0', '0']);
      await exec('xdotool', ['windowmap', id]);
      await exec('xdotool', ['windowraise', id]);
      await exec('xdotool', ['windowactivate', '--sync', id]);
      const box = await geometry(id);
      if (!resize || (box.width >= 640 && box.height >= 480)) {
        await sleep(resize ? 200 : 500);
        return id;
      }
    }
    await sleep(300);
  }
  return '';
}

async function activate(klass) {
  const ids = await windowIds(klass);
  if (!ids.length) return '';
  const id = ids[ids.length - 1];
  await exec('xdotool', ['windowmap', id]);
  await exec('xdotool', ['windowactivate', '--sync', id]);
  await sleep(150);
  return id;
}

async function typeText(id, text) {
  const args = ['type', '--delay', '16', '--window', id, '--', text];
  const typed = await exec('xdotool', args, 60000);
  if (!typed.ok) throw new Error(typed.error || typed.stderr || 'xdotool type failed');
}

async function focusBig(klass, skipTitles = []) {
  const ids = await windowIds(klass);
  let id = '';
  for (const candidate of ids) {
    const title = await windowTitle(candidate);
    if (!title || skipTitles.includes(title)) continue;
    const box = await geometry(candidate);
    if (box.width < 640 || box.height < 480) continue;
    id = candidate;
  }
  if (!id) return '';
  await exec('xdotool', ['windowmap', id]);
  await exec('xdotool', ['windowraise', id]);
  await exec('xdotool', ['windowactivate', '--sync', id]);
  return id;
}

async function chrome(url) {
  const target = url || 'about:blank';
  const existing = await focusBig('deskchrome', ['chrome', 'Chromium clipboard']);
  if (existing && target === 'about:blank') return { ok: true, detail: 'chrome focused' };
  const bin = chromeBin();
  if (!bin) return { ok: false, detail: 'chrome is not installed on this guest' };
  mkdirSync(join(home, '.config/desk-chrome'), { recursive: true });
  if (!existing) launch(bin, [
    '--no-sandbox',
    '--disable-dev-shm-usage',
    '--disable-gpu',
    '--ozone-platform=x11',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-fre',
    '--disable-features=TranslateUI',
    '--class=deskchrome',
    '--hide-crash-restore-bubble',
    '--disable-session-crashed-bubble',
    '--noerrdialogs',
    '--remote-debugging-port=9333',
    '--window-size=1280,800',
    '--window-position=0,0',
    `--user-data-dir=${join(home, '.config/desk-chrome')}`,
    'about:blank',
  ]);
  const id = await place('deskchrome', true, ['chrome', 'Chromium clipboard']);
  if (!id) return { ok: false, detail: 'chrome did not map a window' };
  if (target !== 'about:blank') {
    let opened = false;
    for (let attempt = 0; attempt < 20 && !opened; attempt += 1) {
      try {
        const response = await fetch(`http://127.0.0.1:9333/json/new?${target}`, { method: 'PUT' });
        opened = response.ok;
      } catch {
        await sleep(250);
      }
    }
    if (!opened) return { ok: false, detail: 'chrome did not open the page' };
    await sleep(800);
    await place('deskchrome', true, ['chrome', 'Chromium clipboard']);
  }
  return { ok: true, detail: `chrome ${target}` };
}

async function terminal(command) {
  if (!existsSync('/usr/bin/xterm')) return { ok: false, detail: 'xterm is not installed on this guest' };
  let id = await activate('DeskTerm');
  if (!id) {
    launch('xterm', [
      '-class', 'DeskTerm',
      '-fa', 'DejaVu Sans Mono',
      '-fs', '14',
      '-bg', '#0c1220',
      '-fg', '#e7ecf5',
      '-geometry', '120x40+0+0',
    ]);
    id = await place('DeskTerm', true);
  }
  if (!id) return { ok: false, detail: 'terminal did not map a window' };
  if (!command) return { ok: true, detail: 'terminal open' };
  let typed = command;
  if (command.length > 240 || /[^\x20-\x7e]/.test(command)) {
    writeFileSync('/tmp/desk-cmd.sh', `${command}\n`);
    chmodSync('/tmp/desk-cmd.sh', 0o755);
    typed = 'bash /tmp/desk-cmd.sh';
  }
  await typeText(id, typed);
  await exec('xdotool', ['key', '--window', id, 'Return']);
  return { ok: true, detail: typed === command ? `terminal: ${command}` : `terminal ran a script: ${command}` };
}

async function files(target) {
  if (!existsSync('/usr/bin/pcmanfm')) return { ok: false, detail: 'pcmanfm is not installed on this guest' };
  const path = target || home;
  const launcher = existsSync('/usr/bin/dbus-launch') ? 'dbus-launch' : 'pcmanfm';
  const args = launcher === 'dbus-launch'
    ? ['--exit-with-session', 'pcmanfm', '-n', path]
    : ['-n', path];
  launch(launcher, args);
  const id = await place('Pcmanfm', false);
  return { ok: Boolean(id), detail: id ? `files ${path}` : 'file browser did not map a window' };
}

async function click(x, y) {
  const moved = await exec('xdotool', ['mousemove', '--sync', String(x), String(y), 'click', '1']);
  if (!moved.ok) return { ok: false, detail: moved.error || 'click failed' };
  return { ok: true, detail: `click ${x},${y}` };
}

async function key(combo) {
  const pressed = await exec('xdotool', ['key', '--', combo]);
  if (!pressed.ok) return { ok: false, detail: pressed.error || 'key failed' };
  return { ok: true, detail: `key ${combo}` };
}

async function scroll(dy) {
  const button = dy > 0 ? '5' : '4';
  const steps = Math.max(1, Math.min(8, Math.abs(dy) || 3));
  for (let i = 0; i < steps; i += 1) {
    await exec('xdotool', ['click', button]);
    await sleep(40);
  }
  return { ok: true, detail: dy > 0 ? 'scroll down' : 'scroll up' };
}

async function windows() {
  const names = await exec('xdotool', ['search', '--onlyvisible', '--name', '.', 'getwindowname']);
  const list = names.stdout.split('\n').map((line) => line.trim()).filter(Boolean);
  return { ok: true, detail: list.join(' | ') || 'no windows', windows: list };
}

async function shot() {
  const saved = await exec('scrot', ['-o', '/tmp/desk-shot.png']);
  if (!saved.ok) return { ok: false, detail: saved.error || 'scrot failed' };
  return { ok: true, detail: '/tmp/desk-shot.png' };
}

async function main() {
  const raw = Buffer.from(process.argv[2] || '', 'base64').toString('utf8');
  const action = JSON.parse(raw);
  let result;
  if (action.op === 'chrome') result = await chrome(action.url);
  else if (action.op === 'terminal' || action.op === 'bash') result = await terminal(action.command || '');
  else if (action.op === 'files') result = await files(action.path);
  else if (action.op === 'type') {
    const id = (await activate('DeskTerm')) || (await activate('deskchrome')) || (await activate('deskfiles'));
    if (!id) result = { ok: false, detail: 'no desk window to type into' };
    else {
      await typeText(id, String(action.text || ''));
      result = { ok: true, detail: 'typed' };
    }
  } else if (action.op === 'key') result = await key(String(action.key || 'Return'));
  else if (action.op === 'click') result = await click(Number(action.x) || 0, Number(action.y) || 0);
  else if (action.op === 'scroll') result = await scroll(Number(action.dy) || 3);
  else if (action.op === 'windows') result = await windows();
  else if (action.op === 'shot') result = await shot();
  else result = { ok: false, detail: `unknown action ${action.op}` };
  out(result);
  process.exit(result.ok ? 0 : 1);
}

main().catch((error) => {
  out({ ok: false, detail: error instanceof Error ? error.message : String(error) });
  process.exit(1);
});
