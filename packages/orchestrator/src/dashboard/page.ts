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
    .screen canvas { display: block; }
    .meta { display: flex; justify-content: space-between; gap: 0.75rem; align-items: center; padding: 0.7rem 0.85rem; cursor: zoom-in; }
    .meta strong { display: block; }
    .phase { color: #9eb0cc; font-size: 0.8rem; }
    .hint { color: #7f8da8; font-size: 0.75rem; }
    .empty { grid-column: 1 / -1; border: 1px dashed #2a3a56; border-radius: 14px; padding: 3rem 1rem; text-align: center; color: #8ea0bd; }
    .connection { font-size: 0.75rem; padding: 0.35rem 0.6rem; border-radius: 999px; background: #3a1d1d; color: #f0b4b4; }
    .connection.connected { background: #143224; color: #9be7c4; }
    .stage { position: fixed; inset: 0; z-index: 20; background: #000; display: none; flex-direction: column; }
    .stage.open { display: flex; }
    .stage bar, .stage .bar { display: flex; justify-content: space-between; align-items: center; gap: 1rem; padding: 0.65rem 0.9rem; background: #0c1220; color: #e7ecf5; }
    .stage .screen { flex: 1; aspect-ratio: auto; min-height: 0; }
    button { background: #1b2740; color: #e7ecf5; border: 1px solid #31415f; border-radius: 8px; padding: 0.45rem 0.7rem; cursor: pointer; }
    .waiting { position: absolute; inset: 0; display: grid; place-items: center; color: #8ea0bd; font-size: 0.9rem; }
  </style>
</head>
<body>
  <header>
    <div>
      <h1>VM screens</h1>
      <p>Each tile is that guest's framebuffer. Click a screen to move the pointer and type. Double-click the title to open it full size.</p>
    </div>
    <div id="connection" class="connection">Connecting</div>
  </header>
  <section class="stats" id="stats"></section>
  <section class="wall" id="wall"></section>
  <div id="stage" class="stage" role="dialog" aria-modal="true" aria-label="VM screen">
    <div class="bar">
      <strong id="stage-title">VM</strong>
      <button id="stage-close" type="button">Back to all VMs</button>
    </div>
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
      rfb.background = '#000000';
      rfb.addEventListener('credentialsrequired', () => {
        rfb.sendCredentials({ password: display.vnc_password || '' });
      });
      return rfb;
    }

    function rescale() {
      window.dispatchEvent(new Event('resize'));
    }

    function openStage(id) {
      const tile = tiles.get(id);
      if (!tile) return;
      stageId = id;
      stage.classList.add('open');
      stageTitle.textContent = tile.name.textContent || id;
      stageScreen.append(tile.screen);
      requestAnimationFrame(() => {
        rescale();
        tile.screen.querySelector('canvas')?.focus();
      });
    }

    function closeStage() {
      if (!stageId) return;
      const tile = tiles.get(stageId);
      stage.classList.remove('open');
      stageId = null;
      if (tile) tile.article.insertBefore(tile.screen, tile.article.firstChild);
      stageScreen.replaceChildren();
      requestAnimationFrame(rescale);
    }

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
          const rfb = attach(screen, display);
          rfb.addEventListener('connect', () => waiting.remove());
          tile = { article, screen, name, phase, rfb };
          tiles.set(display.guest_id, tile);
        }
        tile.name.textContent = display.job_name || display.guest_id;
        tile.phase.textContent = display.status || 'live framebuffer';
      }
      for (const [id, tile] of tiles) {
        if (seen.has(id)) continue;
        if (stageId === id) closeStage();
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
      ws.onclose = () => { connEl.textContent = 'Reconnecting'; connEl.className = 'connection'; setTimeout(connect, 1500); };
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
