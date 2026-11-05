import { Terminal } from './vendor/xterm.mjs';
import { FitAddon } from './vendor/addon-fit.mjs';

const $ = (id) => document.getElementById(id);
const statusEl = $('status');
const containerEl = $('container');
const timerEl = $('timer');
const restartBtn = $('restart');
const notice = $('notice');
const noticeText = $('notice-text');

const term = new Terminal({
  cursorBlink: true,
  fontFamily: "ui-monospace, 'JetBrains Mono', 'Cascadia Code', 'SF Mono', Menlo, Consolas, monospace",
  fontSize: 14,
  scrollback: 5000,
  theme: {
    background: '#000000',
    foreground: '#e6e6e6',
    cursor: '#ffd500',
    cursorAccent: '#000000',
    selectionBackground: 'rgba(255, 213, 0, 0.3)',
    black: '#000000',
    brightBlack: '#6e6e6e',
    red: '#ff6b5e',
    brightRed: '#ff9389',
    green: '#9ece6a',
    brightGreen: '#b9e08c',
    yellow: '#ffd500',
    brightYellow: '#ffe45c',
    blue: '#79c0ff',
    brightBlue: '#a5d6ff',
    white: '#e6e6e6',
    brightWhite: '#ffffff',
  },
});
const fit = new FitAddon();
term.loadAddon(fit);
term.open($('terminal'));
fit.fit();

let ws = null;
let alive = false;
let countdown = null;

// Stays under the server's 64 KiB frame limit even if every character is JSON-escaped.
const INPUT_CHUNK = 8192;

const REASONS = {
  shell_exited: 'The shell exited.',
  idle: 'Session closed due to inactivity.',
  max_duration: 'Maximum session duration reached.',
  server_shutdown: 'The server is restarting.',
  start_failed: 'The container could not be started.',
};

function setStatus(state, label) {
  statusEl.dataset.state = state;
  statusEl.textContent = label;
}

function showNotice(text) {
  noticeText.textContent = text;
  notice.hidden = false;
}

function send(msg) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

// Large pastes are split so they do not exceed the frame limit and kill the session.
function sendInput(data) {
  for (let start = 0; start < data.length; ) {
    let end = start + INPUT_CHUNK;
    const last = data.charCodeAt(end - 1);
    if (last >= 0xd800 && last <= 0xdbff) end -= 1;
    send({ type: 'input', data: data.slice(start, end) });
    start = end;
  }
}

function startCountdown(expiresAt) {
  clearInterval(countdown);
  timerEl.hidden = false;
  const tick = () => {
    const left = Math.max(0, Math.round((expiresAt - Date.now()) / 1000));
    const m = String(Math.floor(left / 60)).padStart(2, '0');
    const s = String(left % 60).padStart(2, '0');
    timerEl.textContent = `expires in ${m}:${s}`;
    timerEl.title = 'Maximum session lifetime';
  };
  tick();
  countdown = setInterval(tick, 1000);
}

function ended(message) {
  if (!alive && statusEl.dataset.state === 'ended') return;
  alive = false;
  clearInterval(countdown);
  timerEl.hidden = true;
  setStatus('ended', 'Ended');
  restartBtn.hidden = false;
  if (message) term.write(`\r\n\x1b[2m[${message} The container has been destroyed.]\x1b[0m\r\n`);
}

function connect() {
  ws?.close();
  notice.hidden = true;
  restartBtn.hidden = true;
  containerEl.hidden = true;
  term.reset();
  fit.fit();
  setStatus('connecting', 'Creating container…');

  const url = new URL('ws', location.href);
  url.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  url.searchParams.set('cols', term.cols);
  url.searchParams.set('rows', term.rows);

  const socket = new WebSocket(url);
  socket.binaryType = 'arraybuffer';
  ws = socket;
  let exitReason = null;
  let rejected = false;

  socket.onmessage = (ev) => {
    if (socket !== ws) return;
    if (typeof ev.data !== 'string') {
      term.write(new Uint8Array(ev.data));
      return;
    }
    const msg = JSON.parse(ev.data);
    if (msg.type === 'ready') {
      alive = true;
      setStatus('ready', 'Connected');
      containerEl.textContent = msg.container;
      containerEl.title = 'Container ID';
      containerEl.hidden = false;
      startCountdown(msg.expiresAt);
      term.focus();
    } else if (msg.type === 'error') {
      rejected = true;
      setStatus('error', msg.code === 'rate_limited' ? 'Limit reached' : 'Error');
      showNotice(msg.message);
    } else if (msg.type === 'exit') {
      exitReason = msg.reason;
    }
  };

  socket.onclose = () => {
    // A late close event from a previous socket must not end the current session.
    if (rejected || socket !== ws) return;
    ended(REASONS[exitReason] ?? 'Connection lost.');
  };
}

term.onData((data) => {
  if (alive) sendInput(data);
});
term.onResize(({ cols, rows }) => send({ type: 'resize', cols, rows }));

new ResizeObserver(() => fit.fit()).observe($('terminal'));

restartBtn.addEventListener('click', connect);
$('notice-retry').addEventListener('click', connect);

// Closing the WebSocket when leaving the page makes the server destroy the container.
window.addEventListener('pagehide', () => ws?.close());
// Coming back through the browser's back/forward cache starts a new session.
window.addEventListener('pageshow', (ev) => {
  if (ev.persisted) connect();
});

connect();
