export interface DeskPageOptions {
  guestId?: string;
  title?: string;
  nekoUrl?: string;
}

export function nekoPage(options: DeskPageOptions = {}): string {
  const guestId = options.guestId || 'workshop-neko';
  const title = options.title || 'Neko desk';
  const nekoUrl = options.nekoUrl || `/neko/${guestId}/?usr=neko&pwd=neko&embed=1`;
  const iframeUrl = nekoUrl.includes('?') ? `${nekoUrl}&embed=1` : `${nekoUrl}?usr=neko&pwd=neko&embed=1`;
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${title}</title>
  <style>
    :root {
      --bg-0: #0b0c0e;
      --bg-1: #131417;
      --bg-2: #1c1e22;
      --bg-3: #26292e;
      --border: #2a2d33;
      --border-strong: #3a3e46;
      --text-1: #e8e9ec;
      --text-2: #a3a8b1;
      --text-3: #6c717a;
      --accent: #4c9aff;
      --accent-soft: rgb(76 154 255 / 0.14);
      --success: #3ccb7f;
      --warning: #f5b544;
      --danger: #f2555a;
      --radius-sm: 6px;
      --radius-md: 10px;
      --radius-lg: 14px;
      --shadow-2: inset 0 1px 0 rgb(255 255 255 / 0.05), 0 8px 24px rgb(0 0 0 / 0.5);
      --font-sans: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      --font-mono: "JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, monospace;
    }
    * { box-sizing: border-box; }
    html, body { margin: 0; height: 100%; background: var(--bg-0); color: var(--text-1); font-family: var(--font-sans); }
    body { display: flex; flex-direction: column; overflow: hidden; }
    button { font: inherit; }
    .topbar {
      height: 44px; flex: 0 0 44px; display: flex; align-items: center; gap: 16px;
      padding: 0 12px; background: var(--bg-1); border-bottom: 1px solid var(--border);
    }
    .brand { display: flex; align-items: center; gap: 9px; min-width: 0; }
    .mark {
      width: 24px; height: 24px; border-radius: 7px; display: grid; place-items: center;
      background: linear-gradient(135deg, #4c9aff, #7b61ff); color: white;
      font-size: 13px; font-weight: 800; letter-spacing: -0.04em;
    }
    .brand strong { font-size: 13px; font-weight: 650; letter-spacing: -0.01em; }
    .brand span { color: var(--text-3); font-size: 11px; margin-left: 7px; }
    .vm { display: flex; align-items: center; gap: 8px; color: var(--text-2); font-size: 12px; min-width: 0; }
    .vm .name { color: var(--text-1); font-weight: 560; }
    .dot { width: 6px; height: 6px; border-radius: 999px; background: var(--text-3); display: inline-block; }
    .dot.live { background: var(--success); box-shadow: 0 0 0 3px rgb(60 203 127 / 0.12); }
    .sep { color: var(--text-3); }
    .topbar .actions { margin-left: auto; display: flex; align-items: center; gap: 6px; }
    .btn {
      height: 27px; padding: 0 9px; border-radius: var(--radius-sm); border: 1px solid var(--border);
      background: var(--bg-2); color: var(--text-2); font-size: 11.5px; cursor: pointer;
      display: inline-flex; align-items: center; gap: 5px; text-decoration: none;
    }
    .btn:hover { background: var(--bg-3); color: var(--text-1); }
    .btn.primary { background: var(--accent-soft); border-color: rgb(76 154 255 / 0.35); color: #bcd7ff; }
    .btn.control { background: var(--accent); border-color: var(--accent); color: #08111f; font-weight: 650; }
    .btn.control:hover { background: #6aacff; color: #08111f; }
    .app { flex: 1 1 auto; min-height: 0; display: flex; }
    .app.full .chat { display: none; }
    .stage { flex: 1 1 auto; min-width: 0; background: var(--bg-0); padding: 8px; display: grid; place-items: center; }
    .frame {
      position: relative; width: 100%; max-width: 100%; max-height: 100%; aspect-ratio: 16 / 10;
      border: 1px solid var(--border); border-radius: var(--radius-md); overflow: hidden;
      background: #000; box-shadow: var(--shadow-2);
    }
    .frame iframe { position: absolute; inset: 0; width: 100%; height: 100%; border: 0; background: #000; }
    .hint {
      position: absolute; left: 50%; bottom: 14px; transform: translateX(-50%);
      padding: 7px 11px; border-radius: 999px; background: rgb(0 0 0 / 0.62); border: 1px solid rgb(255 255 255 / 0.12);
      color: #dce5f5; font-size: 11.5px; pointer-events: none; transition: opacity 240ms ease;
    }
    .hint.gone { opacity: 0; }
    .chat {
      width: clamp(360px, 28vw, 440px); flex: 0 0 auto; min-height: 0; display: flex; flex-direction: column;
      background: var(--bg-1); border-left: 1px solid var(--border);
    }
    .chat-head { height: 48px; flex: 0 0 48px; display: flex; align-items: center; gap: 10px; padding: 0 16px; border-bottom: 1px solid var(--border); }
    .avatar {
      width: 26px; height: 26px; border-radius: 8px; display: grid; place-items: center;
      background: linear-gradient(135deg, #4c9aff, #7b61ff); color: white; font-size: 12px; font-weight: 750;
    }
    .avatar.small { width: 18px; height: 18px; border-radius: 6px; font-size: 9px; }
    .chat-head strong { display: block; font-size: 13px; font-weight: 650; }
    .chat-head span { display: block; color: var(--text-3); font-size: 11px; margin-top: 1px; }
    .chat-head .spacer { flex: 1; }
    .log { flex: 1 1 auto; min-height: 0; overflow: auto; padding: 16px; display: flex; flex-direction: column; gap: 12px; scroll-behavior: smooth; }
    .empty { margin: auto 0; padding: 8px 0 24px; color: var(--text-2); }
    .empty h2 { margin: 0 0 6px; color: var(--text-1); font-size: 16px; letter-spacing: -0.02em; }
    .empty p { margin: 0 0 14px; font-size: 12.5px; line-height: 1.5; }
    .suggestions { display: flex; flex-wrap: wrap; gap: 6px; }
    .suggestion {
      border: 1px solid var(--border); background: var(--bg-2); color: var(--text-2);
      border-radius: 999px; padding: 5px 9px; font-size: 11.5px; cursor: pointer;
    }
    .suggestion:hover { background: var(--bg-3); color: var(--text-1); }
    .msg { display: flex; flex-direction: column; min-width: 0; }
    .msg.user { align-items: flex-end; }
    .msg.user .bubble {
      max-width: 85%; padding: 8px 12px; border-radius: 14px 14px 4px 14px;
      background: var(--accent-soft); color: #dce9ff; font-size: 13.5px; line-height: 1.45; white-space: pre-wrap;
    }
    .msg.assistant .meta { display: flex; align-items: center; gap: 6px; margin-bottom: 5px; color: var(--text-3); font-size: 11px; }
    .msg.assistant .meta time { margin-left: 2px; }
    .msg.assistant .body { font-size: 13.5px; line-height: 1.55; color: var(--text-1); overflow-wrap: anywhere; }
    .msg.assistant .body strong { font-weight: 650; }
    .msg.assistant .body code, .msg.assistant .body pre {
      font-family: var(--font-mono); font-size: 11.5px; background: var(--bg-0);
      border: 1px solid var(--border); border-radius: var(--radius-sm); padding: 1px 5px;
    }
    .msg.assistant .body pre { padding: 9px 10px; overflow: auto; display: block; }
    .caret { display: inline-block; width: 6px; height: 13px; margin-left: 2px; background: var(--accent); vertical-align: -2px; animation: blink 1s steps(1) infinite; }
    @keyframes blink { 50% { opacity: 0; } }
    .reasoning { margin: 1px 0 3px; border-left: 2px solid var(--border-strong); padding-left: 10px; }
    .reasoning summary { cursor: pointer; color: var(--text-2); font-size: 12.5px; line-height: 1.5; list-style: none; }
    .reasoning summary::-webkit-details-marker { display: none; }
    .reasoning summary::before { content: "◌ "; color: var(--text-3); }
    .reasoning[open] summary { color: var(--text-1); }
    .reasoning .reason-body { margin: 5px 0 2px; color: var(--text-2); font-size: 12.5px; line-height: 1.55; white-space: pre-wrap; }
    .tools { display: flex; flex-wrap: wrap; gap: 5px; }
    .tool {
      display: inline-flex; align-items: center; gap: 5px; height: 24px; padding: 0 8px;
      border-radius: var(--radius-sm); background: var(--bg-2); border: 1px solid var(--border);
      color: var(--text-2); font-size: 11px;
    }
    .tool .icon { color: var(--accent); font-size: 10px; }
    .tool code { font-family: var(--font-mono); font-size: 10.5px; color: var(--text-2); }
    .tool .status { color: var(--success); font-size: 10px; }
    .shot { margin-top: 5px; }
    .shot img {
      display: block; width: 100%; max-height: 160px; object-fit: cover; object-position: top;
      border: 1px solid var(--border); border-radius: var(--radius-md); cursor: zoom-in;
    }
    .shot .caption { margin-top: 4px; color: var(--text-3); font-size: 10.5px; }
    .msg.error {
      border-left: 2px solid var(--danger); padding: 2px 0 2px 8px;
      color: #ffb8ba; font-size: 12.5px; line-height: 1.45;
    }
    .composer-wrap { flex: 0 0 auto; padding: 8px 16px 16px; border-top: 1px solid var(--border); background: var(--bg-1); }
    .statusline { display: flex; align-items: center; gap: 6px; height: 20px; color: var(--text-3); font-size: 11px; }
    .statusline .dot { width: 5px; height: 5px; }
    .statusline.working .dot { background: var(--accent); animation: pulse 1.2s ease-in-out infinite; }
    @keyframes pulse { 50% { opacity: 0.35; } }
    .composer { border: 1px solid var(--border); border-radius: var(--radius-lg); background: var(--bg-2); padding: 8px 8px 7px; }
    .composer:focus-within { border-color: rgb(76 154 255 / 0.55); box-shadow: 0 0 0 3px rgb(76 154 255 / 0.1); }
    .composer textarea {
      width: 100%; min-height: 30px; max-height: 132px; resize: none; border: 0; outline: 0;
      background: transparent; color: var(--text-1); font: inherit; font-size: 13px; line-height: 1.45; padding: 4px 5px;
    }
    .composer textarea::placeholder { color: var(--text-3); }
    .composer-foot { display: flex; align-items: center; gap: 8px; padding: 4px 2px 0 5px; }
    .target { color: var(--text-3); font-size: 10.5px; }
    .target b { color: var(--text-2); font-weight: 550; }
    .send {
      margin-left: auto; height: 28px; min-width: 58px; padding: 0 12px; border: 0; border-radius: 999px;
      background: var(--accent); color: #08111f; font-size: 11.5px; font-weight: 700; cursor: pointer;
    }
    .send:hover { background: #6aacff; }
    .send:disabled { opacity: 0.45; cursor: default; }
    .lightbox {
      position: fixed; inset: 0; z-index: 50; display: none; place-items: center;
      background: rgb(0 0 0 / 0.78); padding: 24px; cursor: zoom-out;
    }
    .lightbox.open { display: grid; }
    .lightbox img { max-width: 96vw; max-height: 92vh; border-radius: var(--radius-md); border: 1px solid var(--border-strong); box-shadow: var(--shadow-2); }
    @media (max-width: 900px) {
      .chat { width: 340px; }
      .vm .specs { display: none; }
    }
    @media (max-width: 760px) {
      body { overflow: auto; }
      .app { flex-direction: column; }
      .stage { flex: 0 0 auto; aspect-ratio: 16 / 10; }
      .frame { aspect-ratio: auto; height: 100%; }
      .chat { width: 100%; flex: 1 1 auto; border-left: 0; border-top: 1px solid var(--border); }
      .log { min-height: 42vh; }
    }
  </style>
</head>
<body>
  <header class="topbar">
    <div class="brand">
      <div class="mark">N</div>
      <div><strong>${title}</strong><span>MicroVM lab</span></div>
    </div>
    <div class="vm">
      <span class="dot live" id="vm-dot"></span>
      <span class="name">${guestId}</span>
      <span class="sep">·</span>
      <span class="specs">1280×800</span>
      <span class="sep specs">·</span>
      <span class="specs" id="transport">WebRTC</span>
    </div>
    <div class="actions">
      <button class="btn control" id="take-control" type="button">Take control</button>
      <button class="btn" id="fixtures" type="button">Fixtures</button>
      <button class="btn" id="fullscreen" type="button">Fullscreen</button>
      <button class="btn" id="toggle-chat" type="button">Chat</button>
      <a class="btn" href="/vms">Wall ↗</a>
    </div>
  </header>
  <main class="app" id="app">
    <section class="stage" id="stage">
      <div class="frame">
        <iframe id="neko-frame" src="/neko/workshop-neko/?usr=neko&pwd=neko&embed=1" title="Neko WebRTC desktop" allow="autoplay; fullscreen; clipboard-read; clipboard-write"></iframe>
        <div class="hint" id="hint">Click to control</div>
      </div>
    </section>
    <aside class="chat" id="chat">
      <div class="chat-head">
        <div class="avatar">C</div>
        <div><strong>Codex</strong><span id="chat-hint">In-container agent · cua-driver</span></div>
        <div class="spacer"></div>
      </div>
      <div class="log" id="log">
        <div class="empty" id="empty">
          <h2>What should Codex do?</h2>
          <p>It can open apps, click, type, read the page, and report what is actually on screen.</p>
          <div class="suggestions">
            <button class="suggestion" data-prompt="Open the fixture apps in the container browser and tell me what is on the page.">Open fixtures</button>
            <button class="suggestion" data-prompt="Open the Onboarding Portal, fill the signup for Alice Johnson with alice.johnson@example.com on the free plan, accept terms, and download the welcome PDF.">Run onboarding</button>
            <button class="suggestion" data-prompt="Open the Support Desk, update ticket TKT-009 to in-progress, assign dev-team, add the escalated tag, and reply with a status update.">Run support</button>
            <button class="suggestion" data-prompt="Open the Booking App and book the cheapest accessible venue for 4 guests on 2026-11-15.">Run booking</button>
          </div>
        </div>
      </div>
      <div class="composer-wrap">
        <div class="statusline" id="statusline"><span class="dot"></span><span id="status-text">Ready</span></div>
        <form class="composer" id="form">
          <textarea id="input" rows="1" placeholder="Ask Codex to use the desktop…"></textarea>
          <div class="composer-foot">
            <span class="target">→ <b>workshop-neko</b></span>
            <button class="send" id="send" type="submit">Send</button>
          </div>
        </form>
      </div>
    </aside>
  </main>
  <div class="lightbox" id="lightbox"><img id="lightbox-img" alt="Active window"></div>
  <script>
    const guestId = 'workshop-neko';
    const chatGet = '/api/neko/chat?guest=' + encodeURIComponent(guestId);
    const log = document.getElementById('log');
    const empty = document.getElementById('empty');
    const form = document.getElementById('form');
    const input = document.getElementById('input');
    const send = document.getElementById('send');
    const statusline = document.getElementById('statusline');
    const statusText = document.getElementById('status-text');
    const hint = document.getElementById('hint');
    const lightbox = document.getElementById('lightbox');
    const lightboxImg = document.getElementById('lightbox-img');
    let sending = false;
    let shown = 0;
    const nodes = new Map();

    function escapeHtml(value) {
      return String(value || '').replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));
    }
    function markdown(value) {
      return escapeHtml(value)
        .replace(/\\*\\*([^*]+)\\*\\*/g, '<strong>$1</strong>')
        .replace(/\`([^\`]+)\`/g, '<code>$1</code>')
        .replace(/\\n/g, '<br>');
    }
    function timeLabel() {
      return new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    }
    function setStatus(text, working) {
      statusText.textContent = text;
      statusline.classList.toggle('working', Boolean(working));
    }
    function scrollIfNearBottom() {
      const gap = log.scrollHeight - log.scrollTop - log.clientHeight;
      if (gap < 120) log.scrollTop = log.scrollHeight;
    }
    function hideEmpty() { if (empty && empty.parentNode) empty.remove(); }

    function assistantNode(id) {
      let node = nodes.get(id);
      if (node) return node;
      node = document.createElement('div');
      node.className = 'msg assistant';
      node.dataset.id = id;
      const meta = document.createElement('div');
      meta.className = 'meta';
      meta.innerHTML = '<span class="avatar small">C</span><span>Codex</span><time>' + timeLabel() + '</time>';
      const body = document.createElement('div');
      body.className = 'body';
      node.append(meta, body);
      log.append(node);
      nodes.set(id, node);
      hideEmpty();
      return node;
    }

    function reasoningNode(id) {
      let node = nodes.get(id);
      if (node) return node;
      node = document.createElement('details');
      node.className = 'reasoning';
      node.dataset.id = id;
      node.open = true;
      const summary = document.createElement('summary');
      summary.textContent = 'Thinking…';
      const body = document.createElement('div');
      body.className = 'reason-body';
      node.append(summary, body);
      log.append(node);
      nodes.set(id, node);
      hideEmpty();
      return node;
    }

    function renderAssistant(id, text, final) {
      const node = assistantNode(id);
      const body = node.querySelector('.body');
      body.innerHTML = markdown(text) + (final ? '' : '<span class="caret"></span>');
      if (final) {
        const reasoning = [...nodes.values()].reverse().find((n) => n.tagName === 'DETAILS');
        if (reasoning) reasoning.open = false;
      }
      scrollIfNearBottom();
    }

    function addUser(text) {
      hideEmpty();
      const node = document.createElement('div');
      node.className = 'msg user';
      const bubble = document.createElement('div');
      bubble.className = 'bubble';
      bubble.textContent = text;
      node.append(bubble);
      log.append(node);
      scrollIfNearBottom();
    }

    function addTool(text) {
      hideEmpty();
      let wrap = log.querySelector('.tools:last-child');
      if (!wrap) {
        wrap = document.createElement('div');
        wrap.className = 'tools';
        log.append(wrap);
      }
      const pill = document.createElement('span');
      pill.className = 'tool';
      pill.innerHTML = '<span class="icon">▸</span><code>' + escapeHtml(text) + '</code><span class="status">✓</span>';
      wrap.append(pill);
      scrollIfNearBottom();
    }

    function addShot(file, caption) {
      hideEmpty();
      const node = document.createElement('div');
      node.className = 'shot';
      const img = document.createElement('img');
      img.src = '/api/desk-shots/' + encodeURIComponent(file);
      img.alt = caption || 'Active window';
      img.addEventListener('click', () => openLightbox(img.src));
      const cap = document.createElement('div');
      cap.className = 'caption';
      cap.textContent = caption || 'Active window';
      node.append(img, cap);
      log.append(node);
      scrollIfNearBottom();
    }

    function addError(text) {
      hideEmpty();
      const node = document.createElement('div');
      node.className = 'msg error';
      node.textContent = text;
      log.append(node);
      scrollIfNearBottom();
    }

    function openLightbox(src) {
      lightboxImg.src = src;
      lightbox.classList.add('open');
    }
    lightbox.addEventListener('click', () => {
      lightbox.classList.remove('open');
      lightboxImg.removeAttribute('src');
    });

    function appendHistory(message) {
      if (message.role === 'user') addUser(message.text);
      else if (message.role === 'assistant') renderAssistant('history-' + shown + '-' + Math.random(), message.text, true);
      else if (message.role === 'reasoning') {
        const node = reasoningNode('history-' + shown + '-' + Math.random());
        node.querySelector('summary').textContent = '◌ Reasoning';
        node.querySelector('.reason-body').textContent = message.text;
        node.open = false;
      } else if (message.role === 'action' && message.file) addShot(message.file, message.text);
      else if (message.role === 'action') addTool(message.text);
      else if (message.role === 'error') addError(message.text);
    }

    async function syncChat() {
      if (sending) return;
      try {
        const res = await fetch(chatGet);
        if (!res.ok) return;
        const data = await res.json();
        const messages = data.messages || [];
        if (messages.length === shown) return;
        log.replaceChildren();
        nodes.clear();
        for (const message of messages) appendHistory(message);
        shown = messages.length;
        if (!messages.length && !log.querySelector('.empty')) {
          const emptyNode = document.createElement('div');
          emptyNode.className = 'empty';
          emptyNode.innerHTML = '<h2>What should Codex do?</h2><p>It can open apps, click, type, read the page, and report what is actually on screen.</p>';
          log.append(emptyNode);
        }
      } catch { /* retry */ }
    }

    function takeEvents(buf) {
      const events = [];
      let rest = buf;
      let split = rest.indexOf('\\n\\n');
      while (split >= 0) {
        const block = rest.slice(0, split);
        rest = rest.slice(split + 2);
        split = rest.indexOf('\\n\\n');
        const line = block.split('\\n').filter((item) => item.indexOf('data:') === 0).map((item) => item.slice(5).trim()).join('\\n');
        if (!line) continue;
        events.push(JSON.parse(line));
      }
      return { events, rest };
    }

    async function sendMessage(message) {
      const text = message.trim();
      if (!text || sending) return;
      addUser(text);
      input.value = '';
      autosize();
      sending = true;
      send.disabled = true;
      setStatus('Working…', true);
      try {
        const res = await fetch('/api/neko/chat', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ message: text, guest_id: guestId }),
        });
        if (!res.ok || !res.body) {
          const data = await res.json().catch(() => ({}));
          throw new Error(data.error || res.statusText);
        }
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buf = '';
        while (true) {
          const step = await reader.read();
          if (step.done) break;
          buf += decoder.decode(step.value, { stream: true });
          const parsed = takeEvents(buf);
          buf = parsed.rest;
          for (const event of parsed.events) {
            if (event.type === 'assistant_delta') {
              const node = assistantNode(event.id);
              const body = node.querySelector('.body');
              node.dataset.raw = (node.dataset.raw || '') + (event.text || '');
              body.innerHTML = markdown(node.dataset.raw) + '<span class="caret"></span>';
              scrollIfNearBottom();
            } else if (event.type === 'reasoning_delta') {
              const node = reasoningNode(event.id);
              node.querySelector('.reason-body').textContent += event.text || '';
              scrollIfNearBottom();
            } else if (event.type === 'assistant') {
              const node = assistantNode(event.id);
              node.dataset.raw = event.text || '';
              renderAssistant(event.id, event.text || '', true);
            } else if (event.type === 'reasoning') {
              const node = reasoningNode(event.id);
              node.querySelector('summary').textContent = '◌ Reasoning';
              node.querySelector('.reason-body').textContent = event.text || '';
              node.open = false;
            } else if (event.type === 'action') {
              addTool(event.text || event.op || 'tool');
            } else if (event.type === 'shot' && event.file) {
              addShot(event.file, event.text);
            } else if (event.type === 'error') {
              addError(event.text || 'Unknown error');
            } else if (event.type === 'done') {
              setStatus('Ready', false);
            }
          }
        }
      } catch (error) {
        addError(error.message || String(error));
      } finally {
        sending = false;
        send.disabled = false;
        setStatus('Ready', false);
        input.focus();
        shown = 0;
        setTimeout(syncChat, 350);
      }
    }

    form.addEventListener('submit', (event) => {
      event.preventDefault();
      void sendMessage(input.value);
    });
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault();
        form.requestSubmit();
      }
    });
    function autosize() {
      input.style.height = 'auto';
      input.style.height = Math.min(input.scrollHeight, 132) + 'px';
    }
    input.addEventListener('input', autosize);
    document.addEventListener('click', (event) => {
      const suggestion = event.target.closest('.suggestion');
      if (suggestion) void sendMessage(suggestion.dataset.prompt || '');
    });

    document.getElementById('fixtures').addEventListener('click', async () => {
      setStatus('Opening fixtures…', true);
      try {
        const res = await fetch('/api/neko/fixtures', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ container: guestId }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || res.statusText);
        setStatus('Ready', false);
      } catch (error) {
        setStatus('Ready', false);
        addError(error.message);
      }
    });
    document.getElementById('fullscreen').addEventListener('click', () => {
      const stage = document.getElementById('stage');
      if (!document.fullscreenElement) stage.requestFullscreen?.().catch(() => {});
      else document.exitFullscreen?.();
    });
    document.getElementById('toggle-chat').addEventListener('click', () => {
      document.getElementById('app').classList.toggle('full');
    });
    setTimeout(() => hint.classList.add('gone'), 2600);
    function cleanNekoFrame() {
      const frame = document.getElementById('neko-frame');
      const doc = frame?.contentDocument;
      if (!doc || doc.getElementById('workshop-embed-css')) return;
      const style = doc.createElement('style');
      style.id = 'workshop-embed-css';
      style.textContent = [
        '#neko header, #neko aside, #neko [data-testid="header"], #neko [data-testid="side"],',
        '#neko [data-testid="room-bar"], #neko [data-testid="player-overlay"],',
        '#neko [data-testid="control-request"], #neko [data-testid="control-implicit"],',
        '#neko [class*="top-["], #neko [class*="bottom-["], #neko ul.absolute',
        '{ display: none !important; }',
        '#neko .video-container { height: 100vh !important; max-height: 100vh !important; }',
      ].join('\\n');
      doc.head.append(style);
    }
    const nekoFrame = document.getElementById('neko-frame');
    nekoFrame.addEventListener('load', () => {
      cleanNekoFrame();
      setStatus('Ready', false);
    });
    document.getElementById('take-control').addEventListener('click', () => {
      nekoFrame.focus();
      try { nekoFrame.contentWindow?.focus(); } catch {}
      hint.textContent = 'You control this desktop';
      hint.classList.remove('gone');
      setStatus('You control this desktop', false);
      setTimeout(() => hint.classList.add('gone'), 1800);
    });

    syncChat();
    setInterval(syncChat, 2000);
  </script>
</body>
</html>`;
}
