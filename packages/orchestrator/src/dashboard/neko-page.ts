export function nekoPage(nekoUrl: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Neko desk</title>
  <style>
    * { box-sizing: border-box; }
    html, body { margin: 0; height: 100%; background: #070b14; color: #e7ecf5; font-family: ui-sans-serif, system-ui, sans-serif; }
    body { display: flex; flex-direction: column; min-height: 100%; }
    header { display: flex; justify-content: space-between; gap: 1rem; align-items: end; padding: 0.9rem 1.1rem 0.6rem; }
    h1 { font-size: 1.15rem; font-weight: 650; margin: 0; }
    header p { margin: 0.3rem 0 0; color: #93a0b8; font-size: 0.86rem; max-width: 62rem; }
    a { color: #9eb6ff; }
    .stage { flex: 1 1 auto; min-height: 0; display: flex; }
    .screen { flex: 1 1 auto; min-width: 0; background: #000; position: relative; }
    iframe { position: absolute; inset: 0; width: 100%; height: 100%; border: 0; background: #000; }
    .desk { width: 380px; flex: 0 0 380px; display: flex; flex-direction: column; background: #0c1220; border-left: 1px solid #243049; min-height: 0; }
    .desk-head { padding: 0.7rem 0.85rem 0.35rem; }
    .desk-head strong { display: block; }
    .desk-head span { color: #8ea0bd; font-size: 0.75rem; }
    .desk-log { flex: 1 1 auto; overflow: auto; padding: 0.4rem 0.85rem 0.8rem; display: flex; flex-direction: column; gap: 0.45rem; }
    .bubble { border-radius: 10px; padding: 0.45rem 0.6rem; font-size: 0.86rem; line-height: 1.35; white-space: pre-wrap; }
    .bubble.user { background: #1b2740; align-self: flex-end; max-width: 95%; }
    .bubble.assistant { background: #121a2b; border: 1px solid #243049; }
    .bubble.action { background: transparent; color: #9be7c4; font-family: ui-monospace, monospace; font-size: 0.75rem; padding: 0.1rem 0.2rem; }
    .bubble.error { background: #3a1d1d; color: #f0b4b4; }
    .bubble img { width: 100%; border-radius: 8px; margin-top: 0.35rem; display: block; }
    form { display: flex; gap: 0.4rem; padding: 0.7rem; border-top: 1px solid #243049; align-items: end; }
    textarea { flex: 1; resize: none; background: #070b14; color: #e7ecf5; border: 1px solid #31415f; border-radius: 8px; padding: 0.45rem 0.55rem; font: inherit; }
    button { background: #1b2740; color: #e7ecf5; border: 1px solid #31415f; border-radius: 8px; padding: 0.45rem 0.7rem; cursor: pointer; }
    button:disabled { opacity: 0.45; cursor: default; }
    @media (max-width: 800px) {
      .stage { flex-direction: column; }
      .screen { min-height: 46vh; flex-basis: 46vh; }
      .desk { width: 100%; flex-basis: auto; border-left: 0; border-top: 1px solid #243049; min-height: 42vh; }
    }
  </style>
</head>
<body>
  <header>
    <div>
      <h1>Neko desk</h1>
      <p>The desktop is the neko stream with its own dock (browser, terminal, files), Take over / Release control, and the reaction row. This chat is the main OpenClaw desk: <code>nodes</code>, <code>on workshop-neko open the terminal</code>, and <code>state of workshop-neko</code>. A VM posts back with <code>tell main ...</code> or <code>desk-tell</code> inside the container. Sign-in is neko / neko. The QEMU wall is at <a href="/vms">/vms</a>.</p>
    </div>
  </header>
  <div class="stage">
    <div class="screen"><iframe src="${nekoUrl}" title="Neko desktop" allow="autoplay; fullscreen; clipboard-read; clipboard-write"></iframe></div>
    <aside class="desk">
      <div class="desk-head">
        <strong>Desk bot</strong>
        <span id="desk-hint">Main chat. OpenClaw nodes run the other desktops. No model key means the planner stays local.</span>
      </div>
      <div class="desk-log" id="desk-log"></div>
      <form id="desk-form">
        <textarea id="desk-input" rows="3" placeholder="open the terminal and run echo ui-ok"></textarea>
        <button id="desk-send" type="submit">Send</button>
      </form>
    </aside>
  </div>
  <script>
    const deskLog = document.getElementById('desk-log');
    const deskForm = document.getElementById('desk-form');
    const deskInput = document.getElementById('desk-input');
    const deskSend = document.getElementById('desk-send');
    let shown = 0;
    let sending = false;

    function addBubble(role, text, file) {
      const node = document.createElement('div');
      node.className = 'bubble ' + (role || 'assistant');
      node.textContent = text || '';
      if (file) {
        const img = document.createElement('img');
        img.alt = 'Desktop after the turn';
        img.src = '/api/desk-shots/' + encodeURIComponent(file);
        node.append(img);
      }
      deskLog.append(node);
      deskLog.scrollTop = deskLog.scrollHeight;
    }

    async function syncChat() {
      if (sending) return;
      try {
        const res = await fetch('/api/neko/chat');
        if (!res.ok) return;
        const data = await res.json();
        const messages = data.messages || [];
        if (messages.length === shown) return;
        deskLog.replaceChildren();
        for (const message of messages) addBubble(message.role, message.text, message.file);
        shown = messages.length;
      } catch (err) {
        if (!shown) addBubble('error', err.message);
      }
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
      return { events: events, rest: rest };
    }

    deskInput.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault();
        deskForm.requestSubmit();
      }
    });

    deskForm.addEventListener('submit', async (event) => {
      event.preventDefault();
      const message = deskInput.value.trim();
      if (!message) return;
      deskInput.value = '';
      addBubble('user', message);
      shown += 1;
      sending = true;
      deskSend.disabled = true;
      try {
        const res = await fetch('/api/neko/chat', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ message: message }),
        });
        if (!res.ok || !res.body) {
          const data = await res.json().catch(function () { return {}; });
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
          for (const payload of parsed.events) {
            if (payload.type === 'assistant') addBubble('assistant', payload.text);
            else if (payload.type === 'action') addBubble('action', payload.text);
            else if (payload.type === 'error') addBubble('error', payload.text);
            else if (payload.type === 'shot') addBubble('action', payload.text || 'Screen', payload.file);
            if (payload.type === 'assistant' || payload.type === 'action' || payload.type === 'error' || payload.type === 'shot') shown += 1;
          }
        }
      } catch (err) {
        addBubble('error', err.message);
      } finally {
        sending = false;
        deskSend.disabled = false;
        deskInput.focus();
        syncChat();
      }
    });

    syncChat();
    setInterval(syncChat, 2000);
  </script>
</body>
</html>`;
}
