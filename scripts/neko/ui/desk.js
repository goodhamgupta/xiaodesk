/* Replaces the neko header and bottom toolbar. Control and emotes go through the neko client. */
(function () {
  var DASHBOARD = window.DESK_DASHBOARD || 'http://127.0.0.1:4318';
  var REACTIONS = [
    ['thumbs-up', '👍'],
    ['clap', '👏'],
    ['love', '❤️'],
    ['party', '🎉'],
    ['wave', '👋'],
    ['flame', '🔥'],
    ['thinking', '🤔'],
    ['okay', '👌'],
    ['celebrate', '🙌'],
    ['cool', '😎'],
    ['happy', '😄'],
    ['sad', '😢'],
    ['rofl', '🤣'],
    ['hundred', '💯'],
  ];

  function iconBrowser() {
    return '<svg viewBox="0 0 36 36" aria-hidden="true"><circle cx="18" cy="18" r="16" fill="#1a73e8"/><circle cx="18" cy="18" r="6.5" fill="#fff"/><path d="M18 2a16 16 0 0 1 13.8 8H18z" fill="#ea4335"/><path d="M31.8 10A16 16 0 0 1 18 34V18h13.8z" fill="#fbbc04"/><path d="M18 34A16 16 0 0 1 4.2 10H18z" fill="#34a853"/></svg>';
  }
  function iconTerminal() {
    return '<svg viewBox="0 0 36 36" aria-hidden="true"><rect x="2" y="4" width="32" height="28" rx="8" fill="#4b5168"/><path d="M10 13l6 5-6 5" fill="none" stroke="#fff" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/><path d="M18 23h8" stroke="#fff" stroke-width="2.2" stroke-linecap="round"/></svg>';
  }
  function iconFiles() {
    return '<svg viewBox="0 0 36 36" aria-hidden="true"><path d="M4 12.5V10a4 4 0 0 1 4-4h6l2.2 2.6H28a4 4 0 0 1 4 4v1.9" fill="#8eb6f5"/><rect x="3" y="12" width="30" height="18" rx="4" fill="#4c8dff"/></svg>';
  }

  function remote() {
    var root = document.querySelector('#neko');
    var vm = root && root.__vue__;
    return vm && vm.$accessor && vm.$accessor.remote;
  }
  function chat() {
    var root = document.querySelector('#neko');
    var vm = root && root.__vue__;
    return vm && vm.$accessor && vm.$accessor.chat;
  }

  function mount() {
    if (document.getElementById('desk-bar')) return;
    document.body.classList.add('desk-skin');
    var video = document.querySelector('#neko').__vue__.$accessor.video;
    if (video && video.play) video.play();
    if (video && video.setMuted) video.setMuted(true);
    var screen = document.querySelector('#neko');
    if (!screen) return;

    var bubble = document.createElement('div');
    bubble.id = 'desk-bubble';
    bubble.textContent = 'This is my computer. Watch me work, or take control when you need to.';
    var close = document.createElement('button');
    close.id = 'desk-bubble-x';
    close.type = 'button';
    close.textContent = '×';
    close.addEventListener('click', function () { bubble.hidden = true; bubble.dataset.dismissed = '1'; });
    bubble.append(close);
    screen.append(bubble);

    var dock = document.createElement('div');
    dock.id = 'desk-dock';
    [['browser', 'Browser', iconBrowser()], ['terminal', 'Terminal', iconTerminal()], ['files', 'Files', iconFiles()]].forEach(function (item) {
      var button = document.createElement('button');
      button.type = 'button';
      button.title = item[1];
      button.dataset.op = item[0];
      button.innerHTML = item[2];
      button.addEventListener('click', function () { launch(button, item[0]); });
      dock.append(button);
    });
    screen.append(dock);

    var bar = document.createElement('div');
    bar.id = 'desk-bar';
    var who = document.createElement('span');
    who.id = 'desk-who';
    var take = document.createElement('button');
    take.id = 'desk-take';
    take.type = 'button';
    take.textContent = 'Take over';
    take.addEventListener('click', function () {
      var handle = remote();
      if (!handle) return;
      if (handle.hosting) handle.release();
      else handle.request();
    });
    var reactions = document.createElement('div');
    reactions.id = 'desk-reactions';
    REACTIONS.forEach(function (item) {
      var button = document.createElement('button');
      button.type = 'button';
      button.title = item[0];
      button.textContent = item[1];
      button.addEventListener('click', function () {
        var handle = chat();
        if (handle && handle.sendEmote) handle.sendEmote(item[0]);
        button.classList.add('sent');
        setTimeout(function () { button.classList.remove('sent'); }, 400);
      });
      reactions.append(button);
    });
    bar.append(who, take, reactions);
    document.body.append(bar);

    setInterval(function () {
      var handle = remote();
      var mine = Boolean(handle && handle.hosting);
      who.innerHTML = mine ? 'You have control' : 'Your <b>agent</b> has control';
      take.textContent = mine ? 'Release control' : 'Take over';
      if (bubble.dataset.dismissed !== '1') bubble.hidden = mine;
    }, 400);
  }

  function launch(button, op) {
    button.disabled = true;
    fetch(DASHBOARD + '/api/neko/dock', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ op: op }),
    }).then(function (res) {
      if (!res.ok) throw new Error('dock failed');
    }).catch(function () {
      button.title = 'Could not open ' + op;
    }).finally(function () {
      button.disabled = false;
    });
  }

  function wait() {
    var started = Date.now();
    var tick = function () {
      if (remote()) mount();
      else if (Date.now() - started < 20000) setTimeout(tick, 200);
    };
    tick();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', wait);
  else wait();
})();
