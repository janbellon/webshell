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
    background: '#0b0f14',
    foreground: '#c9d1d9',
    cursor: '#7ee787',
    selectionBackground: '#264f78',
    black: '#0b0f14',
    green: '#7ee787',
    brightGreen: '#a5f3a1',
    blue: '#79c0ff',
    brightBlue: '#a5d6ff',
    red: '#ff7b72',
    yellow: '#e3b341',
  },
});
const fit = new FitAddon();
term.loadAddon(fit);
term.open($('terminal'));
fit.fit();

let ws = null;
let alive = false;
let countdown = null;

const REASONS = {
  shell_exited: 'Le shell s’est terminé.',
  idle: 'Session fermée pour inactivité.',
  max_duration: 'Durée maximale de session atteinte.',
  server_shutdown: 'Le serveur redémarre.',
  start_failed: 'Le conteneur n’a pas pu démarrer.',
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

function startCountdown(expiresAt) {
  clearInterval(countdown);
  timerEl.hidden = false;
  const tick = () => {
    const left = Math.max(0, Math.round((expiresAt - Date.now()) / 1000));
    const m = String(Math.floor(left / 60)).padStart(2, '0');
    const s = String(left % 60).padStart(2, '0');
    timerEl.textContent = `expire dans ${m}:${s}`;
    timerEl.title = 'Durée de vie maximale de la session';
  };
  tick();
  countdown = setInterval(tick, 1000);
}

function ended(message) {
  if (!alive && statusEl.dataset.state === 'ended') return;
  alive = false;
  clearInterval(countdown);
  timerEl.hidden = true;
  setStatus('ended', 'Terminé');
  restartBtn.hidden = false;
  if (message) term.write(`\r\n\x1b[2m[${message} Le conteneur a été détruit.]\x1b[0m\r\n`);
}

function connect() {
  notice.hidden = true;
  restartBtn.hidden = true;
  containerEl.hidden = true;
  term.reset();
  fit.fit();
  setStatus('connecting', 'Création du conteneur…');

  const url = new URL('ws', location.href);
  url.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  url.searchParams.set('cols', term.cols);
  url.searchParams.set('rows', term.rows);

  ws = new WebSocket(url);
  ws.binaryType = 'arraybuffer';
  let exitReason = null;
  let rejected = false;

  ws.onmessage = (ev) => {
    if (typeof ev.data !== 'string') {
      term.write(new Uint8Array(ev.data));
      return;
    }
    const msg = JSON.parse(ev.data);
    if (msg.type === 'ready') {
      alive = true;
      setStatus('ready', 'Connecté');
      containerEl.textContent = msg.container;
      containerEl.title = 'Identifiant du conteneur';
      containerEl.hidden = false;
      startCountdown(msg.expiresAt);
      term.focus();
    } else if (msg.type === 'error') {
      rejected = true;
      setStatus('error', msg.code === 'rate_limited' ? 'Limite atteinte' : 'Erreur');
      showNotice(msg.message);
    } else if (msg.type === 'exit') {
      exitReason = msg.reason;
    }
  };

  ws.onclose = () => {
    if (rejected) return;
    ended(REASONS[exitReason] ?? 'Connexion perdue.');
  };
}

term.onData((data) => {
  if (alive) send({ type: 'input', data });
});
term.onResize(({ cols, rows }) => send({ type: 'resize', cols, rows }));

new ResizeObserver(() => fit.fit()).observe($('terminal'));

restartBtn.addEventListener('click', connect);
$('notice-retry').addEventListener('click', connect);

// Fermer le WebSocket en quittant la page => le serveur détruit le conteneur.
window.addEventListener('pagehide', () => ws?.close());
// Retour arrière depuis le cache du navigateur : nouvelle session.
window.addEventListener('pageshow', (ev) => {
  if (ev.persisted) connect();
});

connect();
