export type DeskOp = 'chrome' | 'terminal' | 'files' | 'type' | 'key' | 'click' | 'scroll' | 'bash' | 'react';

export interface DeskAction {
  op: DeskOp;
  url?: string;
  command?: string;
  path?: string;
  text?: string;
  key?: string;
  x?: number;
  y?: number;
  dy?: number;
  emote?: string;
}

export interface DeskPlan {
  say: string;
  actions: DeskAction[];
}

export interface PlanContext {
  home?: string;
  fixturesUrl?: string;
}

const DEFAULT_HOME = '/home/lume';
const DEFAULT_FIXTURES = 'http://10.0.2.2:4317';

const EMOTES: Record<string, string> = {
  'thumbs up': 'thumbs-up',
  thumbsup: 'thumbs-up',
  '+1': 'thumbs-up',
  clap: 'clap',
  heart: 'love',
  love: 'love',
  party: 'party',
  wave: 'wave',
  fire: 'flame',
  flame: 'flame',
  thinking: 'thinking',
  ok: 'okay',
  okay: 'okay',
  celebrate: 'celebrate',
  cool: 'cool',
  sad: 'sad',
  happy: 'happy',
  laugh: 'rofl',
  rofl: 'rofl',
  '100': 'hundred',
  hundred: 'hundred',
};

function shQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function extractUrl(text: string, fixturesUrl: string): string {
  const explicit = text.match(/https?:\/\/[^\s)]+/i);
  if (explicit) return explicit[0].replace(/[.,]$/, '');
  const www = text.match(/\bwww\.[^\s)]+/i);
  if (www) return `https://${www[0].replace(/[.,]$/, '')}`;
  if (/\bfixtures?\b/i.test(text)) return fixturesUrl;
  const search = text.match(/\b(?:search|google)\s+(?:the web\s+)?(?:for\s+)?(.+)/i);
  if (search && !/\bterminal\b|\bfiles?\b/i.test(text)) {
    return `https://www.google.com/search?q=${encodeURIComponent(search[1].replace(/[?.!]$/, '').trim())}`;
  }
  return '';
}

function extractPath(text: string, home: string): string {
  const abs = text.match(/(?:^|[\s"'])(\/(?:home|tmp|opt|etc|usr|var)\/[A-Za-z0-9._~/-]*)/);
  if (abs) return abs[1];
  const tiled = text.match(/~\/([A-Za-z0-9._/-]+)/);
  if (tiled) return `${home}/${tiled[1]}`;
  if (/\bdesktop\b/i.test(text)) return `${home}/Desktop`;
  if (/\bdownloads?\b/i.test(text)) return `${home}/Downloads`;
  if (/\bhome\b/i.test(text)) return home;
  return '';
}

function extractCommand(text: string, home: string): string {
  const quoted = text.match(/`([^`]+)`/);
  if (quoted) return quoted[1].trim();
  const run = text.match(/\b(?:run|execute)\s+(.+)/i);
  if (run) return run[1].replace(/[?.!]$/, '').trim();
  const leading = text.match(/^\s*(ls|echo|cat|pwd|date|uname|mkdir|touch|ps|df|curl|python3|node|cd|cp|mv|rm|head|tail|wc|whoami)\b(.*)$/i);
  if (leading) return `${leading[1]}${leading[2]}`.trim();
  if (/\blist (?:the )?(?:files|directory|dir)\b/i.test(text)) {
    const path = extractPath(text, home);
    return path ? `ls -la ${shQuote(path)}` : 'ls -la';
  }
  return '';
}

function extractFileWrite(text: string, home: string): { path: string; body: string } | null {
  const match = text.match(/\b(?:create|write|make)\s+(?:a\s+)?file\s+(?:called\s+|named\s+)?([A-Za-z0-9._/-]+)(?:\s+on the desktop)?(?:\s+(?:that\s+)?(?:says|with|containing)\s+)(.+)/i);
  if (!match) return null;
  const name = match[1].startsWith('/') ? match[1] : `${/\bdesktop\b/i.test(text) ? `${home}/Desktop` : home}/${match[1]}`;
  return { path: name, body: match[2].replace(/[?.!]$/, '').trim() };
}

function keyName(raw: string): string {
  const name = raw.trim().toLowerCase();
  if (name === 'enter' || name === 'return') return 'Return';
  if (name === 'esc' || name === 'escape') return 'Escape';
  if (name === 'tab') return 'Tab';
  if (name === 'backspace') return 'BackSpace';
  return raw.trim();
}

function extractEmote(text: string): string | null {
  const whole = text.toLowerCase().replace(/[?.!]/g, '').trim();
  if (EMOTES[whole]) return EMOTES[whole];
  const named = text.match(/\b(?:react|reaction|emote)\s+(?:with\s+(?:an?\s+)?)?([a-z0-9+][a-z0-9+ -]{0,24})/i);
  if (!named) return null;
  const key = named[1].toLowerCase().replace(/[?.!]$/, '').trim();
  return EMOTES[key] || null;
}

function clauseActions(text: string, home: string, fixturesUrl: string): DeskAction[] {
  const actions: DeskAction[] = [];
  const url = extractUrl(text, fixturesUrl);
  const path = extractPath(text, home);
  const command = extractCommand(text, home);
  const written = extractFileWrite(text, home);
  const wantsChrome = /\b(chrome|chromium|website|web page)\b/i.test(text)
    || (/\bbrowser\b/i.test(text) && !/\bfile browser\b/i.test(text))
    || Boolean(url);
  const wantsTerm = /\b(terminal|shell|console|command line)\b/i.test(text);
  const wantsFiles = /\b(file browser|file manager|folder)\b/i.test(text)
    || (/\bfiles\b/i.test(text) && !/\blist\b/i.test(text))
    || (/\bdirectory\b/i.test(text) && !command);
  const click = text.match(/\bclick(?:\s+at)?\s+(\d{1,4})[,\s]+(\d{1,4})\b/i);
  const center = /\bclick (?:the )?cent(?:er|re)\b/i.test(text);
  const typed = text.match(/\btype\s+(?:"([^"]+)"|'([^']+)'|(.+))$/i);
  const key = text.match(/\bpress\s+([A-Za-z0-9+._-]+)/i);
  const scrollDown = /\bscroll down\b/i.test(text);
  const scrollUp = /\bscroll up\b/i.test(text);
  const emote = extractEmote(text);

  if (click) actions.push({ op: 'click', x: Number(click[1]), y: Number(click[2]) });
  else if (center) actions.push({ op: 'click', x: 640, y: 400 });
  if (wantsChrome) actions.push({ op: 'chrome', url: url || 'about:blank' });
  if (wantsFiles) actions.push({ op: 'files', path: path || home });
  if (written) {
    const line = `mkdir -p $(dirname ${shQuote(written.path)}) && printf %s ${shQuote(written.body)} > ${shQuote(written.path)}`;
    actions.push({ op: 'terminal', command: line });
    if (!wantsFiles) actions.push({ op: 'files', path: written.path.replace(/\/[^/]+$/, '') || home });
  } else if (wantsTerm || (command && !wantsChrome)) {
    actions.push({ op: 'terminal', command: command || undefined });
  } else if (command && wantsChrome && /\b(run|execute)\b/i.test(text)) {
    actions.push({ op: 'terminal', command });
  }
  if (typed && !written) {
    const textValue = typed[1] || typed[2] || typed[3] || '';
    if (textValue && !/^https?:/i.test(textValue)) actions.push({ op: 'type', text: textValue.trim() });
  }
  if (key) actions.push({ op: 'key', key: keyName(key[1]) });
  if (scrollDown) actions.push({ op: 'scroll', dy: 3 });
  if (scrollUp) actions.push({ op: 'scroll', dy: -3 });
  if (emote) actions.push({ op: 'react', emote });
  return actions;
}

function describe(action: DeskAction, home: string): string {
  if (action.op === 'chrome') return `Open the browser at ${action.url || 'a blank page'}.`;
  if (action.op === 'terminal') return action.command ? `Type \`${action.command}\` in the terminal.` : 'Open the terminal.';
  if (action.op === 'files') return `Open the file browser at ${action.path || home}.`;
  if (action.op === 'type') return `Type "${action.text || ''}".`;
  if (action.op === 'key') return `Press ${action.key}.`;
  if (action.op === 'click') return `Click ${action.x},${action.y}.`;
  if (action.op === 'scroll') return action.dy && action.dy < 0 ? 'Scroll up.' : 'Scroll down.';
  if (action.op === 'react') return `React with ${action.emote}.`;
  return `Run \`${action.command || ''}\`.`;
}

export function planDesk(message: string, context: PlanContext = {}): DeskPlan {
  const home = context.home || DEFAULT_HOME;
  const fixturesUrl = context.fixturesUrl || DEFAULT_FIXTURES;
  const text = message.trim();
  if (!text) {
    return {
      say: 'Send a message. I can open the browser, the terminal, or the file browser and type on this desktop.',
      actions: [],
    };
  }
  const parts = text.split(/\n+|\s+\bthen\b\s+/i).map((part) => part.trim()).filter(Boolean);
  const actions = parts.flatMap((part) => clauseActions(part, home, fixturesUrl));
  if (!actions.length) {
    return {
      say: `I drive this desktop: the browser, the terminal, and the file browser. I can also react on the neko screen ("react with thumbs up"). Try "open the terminal and run uname -a" or "open Chrome to ${fixturesUrl}".`,
      actions: [],
    };
  }
  return { say: actions.map((action) => describe(action, home)).join(' '), actions };
}
