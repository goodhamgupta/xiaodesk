#!/usr/bin/env node
// Map this guest's task onto DISPLAY=:0 and leave the window there.
// A bare Openbox root is #0b1020, which is what a blank VNC tile looks like.
import { spawn, execFile } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const env = { ...process.env, DISPLAY: ':0', HOME: process.env.HOME || '/home/lume' };

export function taskSurface(task) {
  if (task.kind === 'browser' || task.pack === 'onboarding' || task.pack === 'support' || task.pack === 'booking') {
    return 'browser';
  }
  if (task.csv) return 'calc';
  return '';
}

export function taskUrl(task, base) {
  const root = String(base || task.fixtures_url || 'http://10.0.2.2:4317').replace(/\/$/, '');
  const params = task.params || {};
  if (task.pack === 'support') {
    return params.ticket_id
      ? `${root}/support/ticket/${encodeURIComponent(params.ticket_id)}`
      : `${root}/support`;
  }
  if (task.pack === 'booking') {
    const query = new URLSearchParams();
    if (params.date) query.set('date', String(params.date));
    if (params.party_size) query.set('min_capacity', String(params.party_size));
    if (params.max_price) query.set('max_price', String(params.max_price));
    if (params.accessibility) query.set('accessibility', 'true');
    const qs = query.toString();
    return qs ? `${root}/booking?${qs}` : `${root}/booking`;
  }
  return `${root}/onboarding`;
}

function out(payload) {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

function exec(cmd, args, timeout = 20000, extraEnv = env) {
  return new Promise((resolve) => {
    execFile(cmd, args, { env: extraEnv, timeout }, (error, stdout, stderr) => {
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

function launch(cmd, args, extraEnv = env) {
  const child = spawn(cmd, args, { env: extraEnv, detached: true, stdio: 'ignore' });
  child.unref();
  return child.pid;
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

async function windowIds(query) {
  const found = await exec('xdotool', query);
  return found.stdout.split('\n').map((line) => line.trim()).filter((line) => /^\d+$/.test(line));
}

async function geometry(id) {
  const geo = await exec('xdotool', ['getwindowgeometry', '--shell', id]);
  const width = Number((geo.stdout.match(/^WIDTH=(\d+)/m) || [])[1] || 0);
  const height = Number((geo.stdout.match(/^HEIGHT=(\d+)/m) || [])[1] || 0);
  return { width, height };
}

async function place(queries, attempts = 50) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const ids = [];
    for (const query of queries) ids.push(...await windowIds(query));
    for (const id of [...new Set(ids)]) {
      const name = await exec('xdotool', ['getwindowname', id]);
      const title = name.stdout.trim();
      if (!title || title === 'chrome' || title === 'Chromium clipboard') continue;
      await exec('xdotool', ['windowsize', id, '1280', '800']);
      await exec('xdotool', ['windowmove', id, '0', '0']);
      await exec('xdotool', ['windowmap', id]);
      await exec('xdotool', ['windowraise', id]);
      await exec('xdotool', ['windowactivate', '--sync', id]);
      const box = await geometry(id);
      if (box.width >= 640 && box.height >= 480) return id;
    }
    await sleep(400);
  }
  return '';
}

async function navigateOpenChrome(url) {
  let list;
  try {
    list = await fetch('http://127.0.0.1:9333/json/list', { signal: AbortSignal.timeout(2000) }).then((res) => res.json());
  } catch {
    return false;
  }
  const page = (Array.isArray(list) ? list : []).find((entry) => entry.type === 'page' && entry.webSocketDebuggerUrl);
  if (!page || typeof WebSocket !== 'function') {
    try {
      const opened = await fetch(`http://127.0.0.1:9333/json/new?${encodeURI(url)}`, { method: 'PUT', signal: AbortSignal.timeout(4000) });
      return opened.ok;
    } catch {
      return false;
    }
  }
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('cdp open')), 4000);
      ws.addEventListener('open', () => {
        clearTimeout(timer);
        resolve();
      });
      ws.addEventListener('error', () => {
        clearTimeout(timer);
        reject(new Error('cdp error'));
      });
    });
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, 8000);
      ws.addEventListener('message', (event) => {
        try {
          const message = JSON.parse(event.data);
          if (message.id === 1) {
            clearTimeout(timer);
            resolve();
          }
        } catch {
          /* ignore non-json */
        }
      });
      ws.send(JSON.stringify({ id: 1, method: 'Page.navigate', params: { url } }));
    });
    return true;
  } catch {
    return false;
  } finally {
    try { ws.close(); } catch { /* already closed */ }
  }
}

async function chrome(task) {
  const url = taskUrl(task, task.fixtures_url);
  const reused = await navigateOpenChrome(url);
  if (!reused) {
    const bin = chromeBin();
    if (!bin) return { ok: false, detail: 'chrome is not installed on this guest' };
    mkdirSync(join(env.HOME, '.config/desk-chrome'), { recursive: true });
    launch(bin, [
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
      '--start-maximized',
      `--user-data-dir=${join(env.HOME, '.config/desk-chrome')}`,
      url,
    ]);
  }
  const id = await place([
    ['search', '--class', 'deskchrome'],
    ['search', '--class', 'Chromium'],
    ['search', '--name', 'Chrome'],
  ]);
  return { ok: Boolean(id), detail: id ? `chrome ${url}` : `chrome did not map a window for ${url}` };
}

function writeStarterOds(path, csv) {
  const script = `
import sys, zipfile
from pathlib import Path
path, csv = sys.argv[1], sys.argv[2]
def is_number(value):
    try:
        float(value)
        return True
    except ValueError:
        return False
def esc(text):
    return text.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
rows = []
for line in csv.strip().splitlines():
    if not line.strip():
        continue
    cells = []
    for value in line.split(","):
        if value != "" and is_number(value):
            cells.append(f'<table:table-cell office:value-type="float" office:value="{esc(value)}"><text:p>{esc(value)}</text:p></table:table-cell>')
        else:
            cells.append(f'<table:table-cell office:value-type="string"><text:p>{esc(value)}</text:p></table:table-cell>')
    rows.append("<table:table-row>" + "".join(cells) + "</table:table-row>")
content = """<?xml version="1.0" encoding="UTF-8"?>
<office:document-content xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" office:version="1.2">
<office:body><office:spreadsheet>
<table:table table:name="Sheet1">""" + "".join(rows) + """</table:table>
</office:spreadsheet></office:body></office:document-content>
"""
styles = """<?xml version="1.0" encoding="UTF-8"?>
<office:document-styles xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" office:version="1.2"></office:document-styles>
"""
meta = """<?xml version="1.0" encoding="UTF-8"?>
<office:document-meta xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" office:version="1.2"></office:document-meta>
"""
manifest = """<?xml version="1.0" encoding="UTF-8"?>
<manifest:manifest xmlns:manifest="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0" manifest:version="1.2">
<manifest:file-entry manifest:full-path="/" manifest:media-type="application/vnd.oasis.opendocument.spreadsheet"/>
<manifest:file-entry manifest:full-path="content.xml" manifest:media-type="text/xml"/>
<manifest:file-entry manifest:full-path="styles.xml" manifest:media-type="text/xml"/>
<manifest:file-entry manifest:full-path="meta.xml" manifest:media-type="text/xml"/>
</manifest:manifest>
"""
dest = Path(path)
dest.parent.mkdir(parents=True, exist_ok=True)
with zipfile.ZipFile(dest, "w") as archive:
    info = zipfile.ZipInfo("mimetype")
    info.compress_type = zipfile.ZIP_STORED
    archive.writestr(info, "application/vnd.oasis.opendocument.spreadsheet")
    archive.writestr("content.xml", content)
    archive.writestr("styles.xml", styles)
    archive.writestr("meta.xml", meta)
    archive.writestr("META-INF/manifest.xml", manifest)
`;
  writeFileSync('/tmp/write-starter-ods.py', script);
  return exec('python3', ['/tmp/write-starter-ods.py', path, csv], 20000);
}

async function calc(task) {
  const desktop = join(env.HOME, 'Desktop');
  mkdirSync(desktop, { recursive: true });
  const name = task.starter_name || task.ods_name || 'sheet.ods';
  const path = join(desktop, name.endsWith('.ods') ? name : `${name}.ods`);
  const written = await writeStarterOds(path, String(task.csv || ''));
  if (!written.ok) return { ok: false, detail: written.stderr || written.error || 'ods write failed' };
  const color = String(task.desktop_color || '10243f').replace(/^#/, '');
  await exec('xsetroot', ['-solid', `#${color}`]);
  const already = await place([
    ['search', '--class', 'soffice'],
    ['search', '--class', 'libreoffice'],
  ], 1);
  if (!already) {
    const loEnv = {
      ...env,
      SAL_USE_VCLPLUGIN: 'gen',
      SAL_NO_JAVA: '1',
      LANG: 'en_US.UTF-8',
      LC_ALL: 'en_US.UTF-8',
    };
    launch('soffice', [
      '--calc',
      '--norestore',
      '--nologo',
      '--nodefault',
      '--nofirststartwizard',
      path,
    ], loEnv);
  }
  const id = await place([
    ['search', '--class', 'soffice'],
    ['search', '--class', 'libreoffice'],
    ['search', '--name', 'LibreOffice'],
  ], 70);
  return { ok: Boolean(id), detail: id ? `calc ${name}` : 'calc did not map a window' };
}

export async function paintTask(task) {
  const surface = taskSurface(task);
  if (surface === 'browser') return chrome(task);
  if (surface === 'calc') return calc(task);
  return { ok: false, detail: `no desktop for ${task.id || 'task'}` };
}

async function main() {
  const task = JSON.parse(readFileSync(process.argv[2], 'utf8'));
  const result = await paintTask(task);
  out(result);
  process.exit(result.ok ? 0 : 1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    out({ ok: false, detail: error instanceof Error ? error.message : String(error) });
    process.exit(1);
  });
}
