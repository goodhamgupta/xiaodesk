export function dashboardPage(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>MicroVM screens</title>
  <style>
    * { box-sizing: border-box; }
    html, body { margin: 0; height: 100%; background: #070b14; color: #e7ecf5; font-family: ui-sans-serif, system-ui, sans-serif; }
    header { display: flex; justify-content: space-between; gap: 1rem; align-items: end; padding: 1.25rem 1.5rem 0.5rem; }
    h1 { font-size: 1.25rem; font-weight: 650; margin: 0; }
    header p { margin: 0.35rem 0 0; color: #93a0b8; font-size: 0.9rem; }
    .stats { display: flex; gap: 0.75rem; flex-wrap: wrap; padding: 0.75rem 1.5rem 0; }
    .stat { background: #121a2b; border: 1px solid #243049; border-radius: 10px; padding: 0.55rem 0.8rem; min-width: 88px; }
    .stat b { display: block; font-size: 1.15rem; }
    .stat span { color: #8ea0bd; font-size: 0.72rem; letter-spacing: 0.04em; text-transform: uppercase; }
    .wall { display: grid; grid-template-columns: repeat(auto-fit, minmax(420px, 1fr)); gap: 1rem; padding: 1rem 1.5rem 2rem; }
    .tile { background: #0c1220; border: 1px solid #243049; border-radius: 14px; overflow: hidden; outline: none; }
    .tile:focus-visible { border-color: #7aa2ff; }
    .screen { position: relative; aspect-ratio: 16 / 10; background: #000; overflow: hidden; }
    .screen canvas { display: block; cursor: default !important; }
    .meta { display: flex; justify-content: space-between; gap: 0.75rem; align-items: center; padding: 0.7rem 0.85rem; cursor: zoom-in; }
    .meta strong { display: block; }
    .phase { color: #9eb0cc; font-size: 0.8rem; }
    .hint { color: #7f8da8; font-size: 0.75rem; }
    .empty { grid-column: 1 / -1; border: 1px dashed #2a3a56; border-radius: 14px; padding: 3rem 1rem; text-align: center; color: #8ea0bd; }
    .connection { font-size: 0.75rem; padding: 0.35rem 0.6rem; border-radius: 999px; background: #3a1d1d; color: #f0b4b4; }
    .connection.connected { background: #143224; color: #9be7c4; }
    .stage { position: fixed; inset: 0; z-index: 20; background: #000; display: none; flex-direction: column; }
    .stage.open { display: flex; }
    .stage .bar { display: flex; justify-content: space-between; align-items: center; gap: 0.75rem; flex-wrap: wrap; padding: 0.55rem 0.9rem; background: #0c1220; color: #e7ecf5; }
    .actions { display: flex; flex-wrap: wrap; gap: 0.4rem; align-items: center; }
    .actions input { width: 7.5rem; background: #070b14; color: #e7ecf5; border: 1px solid #31415f; border-radius: 8px; padding: 0.4rem 0.5rem; }
    #stage-screen { flex: 1 1 auto; width: 100%; min-height: 0; aspect-ratio: auto; display: flex; }
    #stage-screen > .screen { flex: 1 1 auto; width: 100%; height: 100%; min-height: 0; aspect-ratio: auto; }
    #stage-note { margin: 0; padding: 0 0.9rem 0.45rem; background: #0c1220; color: #f0d7a4; font-size: 0.8rem; }
    #stage-note:empty { display: none; padding: 0; }
    button { background: #1b2740; color: #e7ecf5; border: 1px solid #31415f; border-radius: 8px; padding: 0.45rem 0.7rem; cursor: pointer; }
    button:disabled { opacity: 0.45; cursor: default; }
    .waiting { position: absolute; inset: 0; display: grid; place-items: center; color: #8ea0bd; font-size: 0.9rem; }
    .recordings { padding: 0 1.5rem 2rem; }
    .recordings h2 { font-size: 1rem; font-weight: 650; margin: 0 0 0.35rem; }
    .recordings p { margin: 0 0 0.8rem; color: #93a0b8; font-size: 0.85rem; }
    .recording { margin: 0 0 1.1rem; }
    .recording strong { display: block; margin-bottom: 0.35rem; font-size: 0.85rem; }
    .recording video { width: min(960px, 100%); background: #000; border-radius: 10px; }
  </style>
</head>
<body>
  <header>
    <div>
      <h1>VM screens</h1>
      <p>Each tile is that guest's framebuffer. Click a screen to move the pointer and type. Double-click the title to fill the stage. Record writes an mp4 you can replay below. Snapshot and Restore use QEMU's savevm and loadvm.</p>
    </div>
    <div id="connection" class="connection">Connecting</div>
  </header>
  <section class="stats" id="stats"></section>
  <section class="wall" id="wall"></section>
  <section class="recordings">
    <h2>Session recordings</h2>
    <p id="recording-empty">No recordings yet. Open a VM and press Record.</p>
    <div id="recording-list"></div>
  </section>
  <div id="stage" class="stage" role="dialog" aria-modal="true" aria-label="VM screen">
    <div class="bar">
      <strong id="stage-title">VM</strong>
      <div class="actions">
        <button id="rec-start" type="button">Record</button>
        <button id="rec-stop" type="button">Stop</button>
        <input id="snap-name" value="lab1" maxlength="40" aria-label="Snapshot name">
        <button id="snap-save" type="button">Snapshot</button>
        <button id="snap-load" type="button">Restore</button>
        <button id="stage-close" type="button">Back to all VMs</button>
      </div>
    </div>
    <p id="stage-note"></p>
    <div id="stage-screen" class="screen"></div>
  </div>
  <script type="module">
    import RFB from '/novnc/core/rfb.js';

    const wall = document.getElementById('wall');
    const statsEl = document.getElementById('stats');
    const connEl = document.getElementById('connection');
    const stage = document.getElementById('stage');
    const stageScreen = document.getElementById('stage-screen');
    const stageTitle = document.getElementById('stage-title');
    const tiles = new Map();
    let stageId = null;
    let latest = [];

    function socketUrl(id) {
      const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
      return proto + '//' + location.host + '/vm/' + encodeURIComponent(id) + '/vnc';
    }

    function attach(el, display) {
      const rfb = new RFB(el, socketUrl(display.guest_id), { shared: true });
      rfb.viewOnly = false;
      rfb.focusOnClick = true;
      rfb.scaleViewport = true;
      rfb.compressionLevel = 0;
      rfb.qualityLevel = 9;
      rfb.background = '#000000';
      rfb.addEventListener('credentialsrequired', () => {
        rfb.sendCredentials({ password: display.vnc_password || '' });
      });
      return rfb;
    }

    const stageNote = document.getElementById('stage-note');
    const stageObserver = new ResizeObserver(() => {
      if (!stageId) return;
      const tile = tiles.get(stageId);
      if (tile) tile.rfb.scaleViewport = true;
    });
    stageObserver.observe(stageScreen);

    function note(text) {
      stageNote.textContent = text || '';
    }

    function fit(tile) {
      tile.screen.style.width = '100%';
      tile.screen.style.height = '100%';
      tile.screen.style.aspectRatio = 'auto';
      tile.screen.style.flex = '1 1 auto';
      tile.screen.style.minHeight = '0';
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          tile.rfb.scaleViewport = true;
          tile.screen.querySelector('canvas')?.focus();
        });
      });
    }

    function clearFit(tile) {
      tile.screen.style.width = '';
      tile.screen.style.height = '';
      tile.screen.style.aspectRatio = '';
      tile.screen.style.flex = '';
      tile.screen.style.minHeight = '';
    }

    function openStage(id) {
      const tile = tiles.get(id);
      if (!tile) return;
      stageId = id;
      stage.classList.add('open');
      stageTitle.textContent = tile.name.textContent || id;
      note('');
      stageScreen.append(tile.screen);
      fit(tile);
    }

    function closeStage() {
      if (!stageId) return;
      const tile = tiles.get(stageId);
      stage.classList.remove('open');
      stageId = null;
      if (tile) {
        clearFit(tile);
        tile.article.insertBefore(tile.screen, tile.article.firstChild);
        requestAnimationFrame(() => { tile.rfb.scaleViewport = true; });
      }
      stageScreen.replaceChildren();
    }

    async function post(path, body) {
      const res = await fetch(path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body || {}),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || res.statusText);
      return data;
    }

    document.getElementById('rec-start').addEventListener('click', async () => {
      if (!stageId) return;
      note('Recording…');
      try {
        const data = await post('/api/vms/' + encodeURIComponent(stageId) + '/record/start');
        note('Recording ' + (data.file || stageId));
      } catch (err) {
        note(err.message);
      }
    });
    document.getElementById('rec-stop').addEventListener('click', async () => {
      if (!stageId) return;
      note('Stopping the recording…');
      try {
        const data = await post('/api/vms/' + encodeURIComponent(stageId) + '/record/stop');
        note('Saved ' + (data.file || 'recording'));
        refreshRecordings();
      } catch (err) {
        note(err.message);
      }
    });
    document.getElementById('snap-save').addEventListener('click', async () => {
      if (!stageId) return;
      const name = document.getElementById('snap-name').value.trim();
      note('Saving snapshot ' + name + '… the guest pauses while QEMU writes memory.');
      try {
        const data = await post('/api/vms/' + encodeURIComponent(stageId) + '/snapshot', { name });
        note(data.message || ('Saved ' + name));
      } catch (err) {
        note(err.message);
      }
    });
    document.getElementById('snap-load').addEventListener('click', async () => {
      if (!stageId) return;
      const name = document.getElementById('snap-name').value.trim();
      note('Restoring ' + name + '…');
      try {
        const data = await post('/api/vms/' + encodeURIComponent(stageId) + '/restore', { name });
        note(data.message || ('Restored ' + name));
      } catch (err) {
        note(err.message);
      }
    });

    const recordingList = document.getElementById('recording-list');
    const recordingEmpty = document.getElementById('recording-empty');
    let recordingKey = '';
    async function refreshRecordings() {
      try {
        const res = await fetch('/api/recordings');
        if (!res.ok) return;
        const items = await res.json();
        const key = items.map((item) => item.file).join('|');
        if (key === recordingKey) return;
        recordingKey = key;
        recordingEmpty.hidden = items.length > 0;
        recordingList.replaceChildren(...items.map((item) => {
          const wrap = document.createElement('div');
          wrap.className = 'recording';
          const title = document.createElement('strong');
          title.textContent = item.guest_id + ' · ' + item.file;
          const video = document.createElement('video');
          video.controls = true;
          video.preload = 'metadata';
          video.src = '/api/recordings/' + encodeURIComponent(item.file);
          wrap.append(title, video);
          return wrap;
        }));
      } catch {
        /* the next poll retries */
      }
    }
    refreshRecordings();
    setInterval(refreshRecordings, 4000);

    document.getElementById('stage-close').addEventListener('click', closeStage);
    window.addEventListener('keydown', (event) => {
      if (event.key !== 'Escape' || !stageId) return;
      if (event.target instanceof Element && event.target.closest('.screen')) return;
      closeStage();
    });

    function renderStats(state) {
      if (!state.stats) return;
      const items = [
        ['Queued', state.stats.pending],
        ['Running', state.stats.running],
        ['Passed', state.stats.passed],
        ['Failed', state.stats.failed],
        ['Memory', (state.memory_usage_mb || 0) + ' MB'],
      ];
      statsEl.replaceChildren(...items.map(([label, value]) => {
        const node = document.createElement('div');
        node.className = 'stat';
        const number = document.createElement('b');
        number.textContent = String(value);
        const caption = document.createElement('span');
        caption.textContent = label;
        node.append(number, caption);
        return node;
      }));
    }

    function renderWall(displays) {
      latest = displays;
      const seen = new Set();
      if (displays.length === 0) {
        for (const tile of tiles.values()) tile.rfb.disconnect();
        tiles.clear();
        wall.replaceChildren();
        const empty = document.createElement('div');
        empty.className = 'empty';
        empty.textContent = 'No VM framebuffers yet. They appear here as soon as QEMU or lume publishes the display.';
        wall.append(empty);
        return;
      }
      const leftover = wall.querySelector('.empty');
      if (leftover) leftover.remove();
      for (const display of displays) {
        seen.add(display.guest_id);
        let tile = tiles.get(display.guest_id);
        if (!tile) {
          const article = document.createElement('article');
          article.className = 'tile';
          article.tabIndex = 0;
          const screen = document.createElement('div');
          screen.className = 'screen';
          const waiting = document.createElement('div');
          waiting.className = 'waiting';
          waiting.textContent = 'Connecting to the VM display…';
          screen.append(waiting);
          const meta = document.createElement('div');
          meta.className = 'meta';
          const titles = document.createElement('div');
          const name = document.createElement('strong');
          const phase = document.createElement('div');
          phase.className = 'phase';
          titles.append(name, phase);
          const hint = document.createElement('div');
          hint.className = 'hint';
          hint.textContent = 'Double-click title to open';
          meta.append(titles, hint);
          meta.addEventListener('dblclick', (event) => {
            event.preventDefault();
            event.stopPropagation();
            openStage(display.guest_id);
          });
          article.append(screen, meta);
          article.addEventListener('keydown', (event) => {
            if (event.key === 'Enter' && event.target === article) openStage(display.guest_id);
          });
          wall.append(article);
          tile = { article, screen, name, phase, rfb: null, closed: false };
          tiles.set(display.guest_id, tile);
          const arm = (rfb) => {
            rfb.addEventListener('connect', () => waiting.remove());
            rfb.addEventListener('disconnect', () => {
              if (tile.closed || tile.rfb !== rfb) return;
              setTimeout(() => {
                if (tile.closed || tiles.get(display.guest_id) !== tile || tile.rfb !== rfb) return;
                const next = attach(screen, display);
                tile.rfb = next;
                arm(next);
                if (stageId === display.guest_id) fit(tile);
              }, 800);
            });
          };
          tile.rfb = attach(screen, display);
          arm(tile.rfb);
        }
        tile.name.textContent = display.job_name || display.guest_id;
        tile.phase.textContent = display.status || 'live framebuffer';
      }
      for (const [id, tile] of tiles) {
        if (seen.has(id)) continue;
        if (stageId === id) closeStage();
        tile.closed = true;
        tile.rfb.disconnect();
        tile.article.remove();
        tiles.delete(id);
      }
    }

    function apply(state) {
      renderStats(state);
      const active = new Map((state.active_guests || []).map((guest) => [guest.id, guest]));
      const displays = (state.displays || []).map((display) => {
        const guest = active.get(display.guest_id);
        return guest ? { ...display, status: guest.status, job_name: display.job_name || guest.job_name } : display;
      });
      renderWall(displays);
    }

    function connect() {
      const ws = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/');
      ws.onopen = () => { connEl.textContent = 'Live'; connEl.className = 'connection connected'; };
      ws.onclose = () => { connEl.textContent = 'Reconnecting'; connEl.className = 'connection'; setTimeout(() => location.reload(), 600); };
      ws.onmessage = (event) => {
        const message = JSON.parse(event.data);
        if (message.type === 'state') apply(message.data);
      };
    }
    connect();
  </script>
</body>
</html>`;
}
