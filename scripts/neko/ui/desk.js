/* Replaces the neko header and bottom toolbar. Control and emotes go through the neko client. */
(function () {
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
