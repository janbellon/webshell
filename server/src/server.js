import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';

import { config } from './config.js';
import { Docker } from './docker.js';
import { ConcurrencyLimiter, rateLimitKey } from './limiter.js';
import { LABEL_MANAGED, Session } from './session.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const log = (msg) => console.log(`${new Date().toISOString()} ${msg}`);

const docker = new Docker(config.dockerSocket);
const limiter = new ConcurrencyLimiter({ perKey: config.maxPerIp, total: config.maxTotal });
const sessions = new Set();

// ---------------------------------------------------------------------------
// Fichiers statiques : liste blanche explicite, aucun accès arbitraire au disque.
// ---------------------------------------------------------------------------
const nm = (p) => path.join(ROOT, 'node_modules', p);
const STATIC = {
  '/': [path.join(ROOT, 'public/index.html'), 'text/html; charset=utf-8'],
  '/index.html': [path.join(ROOT, 'public/index.html'), 'text/html; charset=utf-8'],
  '/app.js': [path.join(ROOT, 'public/app.js'), 'text/javascript; charset=utf-8'],
  '/style.css': [path.join(ROOT, 'public/style.css'), 'text/css; charset=utf-8'],
  '/favicon.svg': [path.join(ROOT, 'public/favicon.svg'), 'image/svg+xml'],
  '/vendor/xterm.mjs': [nm('@xterm/xterm/lib/xterm.mjs'), 'text/javascript; charset=utf-8'],
  '/vendor/xterm.css': [nm('@xterm/xterm/css/xterm.css'), 'text/css; charset=utf-8'],
  '/vendor/addon-fit.mjs': [nm('@xterm/addon-fit/lib/addon-fit.mjs'), 'text/javascript; charset=utf-8'],
};

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy':
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; " +
    "connect-src 'self' ws: wss:; img-src 'self' data:; frame-ancestors 'none'",
};

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');

  if (url.pathname === '/healthz') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    return res.end(JSON.stringify({ status: 'ok', active: limiter.active, maxTotal: config.maxTotal }));
  }

  const entry = STATIC[url.pathname];
  if (!entry || (req.method !== 'GET' && req.method !== 'HEAD')) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', ...SECURITY_HEADERS });
    return res.end('Not found');
  }
  const [file, type] = entry;
  fs.stat(file, (err, st) => {
    if (err) {
      res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end(`Fichier manquant : ${path.relative(ROOT, file)} (npm install ?)`);
    }
    res.writeHead(200, {
      'Content-Type': type,
      'Content-Length': st.size,
      'Cache-Control': url.pathname.startsWith('/vendor/') ? 'public, max-age=86400' : 'no-cache',
      ...SECURITY_HEADERS,
    });
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(file).pipe(res);
  });
});

// ---------------------------------------------------------------------------
// WebSocket
// ---------------------------------------------------------------------------
function clientIp(req) {
  if (config.trustProxy) {
    // Dernière valeur de X-Forwarded-For = celle ajoutée par notre reverse proxy
    // (les valeurs précédentes peuvent être forgées par le client).
    const xff = req.headers['x-forwarded-for'];
    if (xff) {
      const parts = xff.split(',').map((s) => s.trim()).filter(Boolean);
      if (parts.length) return parts[parts.length - 1];
    }
    if (req.headers['x-real-ip']) return String(req.headers['x-real-ip']).trim();
  }
  return req.socket.remoteAddress;
}

// Empêche un site tiers d'ouvrir des sessions au nom de ses visiteurs.
function originAllowed(req) {
  const origin = req.headers.origin;
  if (!origin) return false;
  if (config.allowedOrigins.length) return config.allowedOrigins.includes(origin);
  try {
    const o = new URL(origin);
    const host = (config.trustProxy && req.headers['x-forwarded-host']) || req.headers.host;
    return o.host === host;
  } catch {
    return false;
  }
}

const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, 'http://localhost');
  if (!url.pathname.endsWith('/ws')) return socket.destroy();
  if (!originAllowed(req)) {
    log(`origine refusée : ${req.headers.origin}`);
    socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
    return socket.destroy();
  }
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req, url));
});

wss.on('connection', (ws, req, url) => {
  const key = rateLimitKey(clientIp(req));
  const slot = limiter.acquire(key);

  if (!slot.ok) {
    const message =
      slot.reason === 'per_client'
        ? `Limite atteinte : ${config.maxPerIp} terminaux ouverts simultanément au maximum. Fermez un onglet puis réessayez.`
        : 'Le serveur est plein pour le moment. Réessayez dans quelques minutes.';
    log(`refus (${slot.reason}) pour ${key}`);
    ws.send(JSON.stringify({ type: 'error', code: 'rate_limited', message }));
    ws.close(4429, 'rate_limited');
    return;
  }

  const cols = Number(url.searchParams.get('cols'));
  const rows = Number(url.searchParams.get('rows'));
  const initialSize =
    Number.isInteger(cols) && Number.isInteger(rows) && cols > 1 && rows > 1
      ? { cols: Math.min(cols, 500), rows: Math.min(rows, 300) }
      : null;

  const session = new Session({
    ws,
    docker,
    config,
    clientKey: key,
    release: slot.release,
    initialSize,
    log,
    onEnd: (s) => sessions.delete(s),
  });
  sessions.add(session);
  session.start();
});

// Détecte les onglets disparus sans fermeture propre (réseau coupé, veille…).
const heartbeat = setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.isAlive === false) {
      ws.terminate();
      continue;
    }
    ws.isAlive = false;
    ws.ping();
  }
}, 20_000);
wss.on('connection', (ws) => {
  ws.isAlive = true;
  ws.on('pong', () => {
    ws.isAlive = true;
  });
});

// ---------------------------------------------------------------------------
// Démarrage / arrêt
// ---------------------------------------------------------------------------
async function removeOrphans() {
  const containers = await docker.listContainers(`${LABEL_MANAGED}=true`);
  await Promise.all(containers.map((c) => docker.removeContainer(c.Id)));
  if (containers.length) log(`${containers.length} conteneur(s) orphelin(s) supprimé(s)`);
}

async function main() {
  try {
    await docker.ping();
  } catch (err) {
    console.error(`Docker injoignable via ${config.dockerSocket} : ${err.message}`);
    process.exit(1);
  }
  if (!(await docker.imageExists(config.image))) {
    console.error(
      `Image "${config.image}" introuvable. Construisez-la : docker build -t ${config.image} ./sandbox`,
    );
    process.exit(1);
  }
  await removeOrphans();

  server.listen(config.port, config.host, () => {
    log(
      `websh à l'écoute sur http://${config.host}:${config.port} — image ${config.image}, ` +
        `max ${config.maxPerIp}/client et ${config.maxTotal} au total`,
    );
  });
}

let stopping = false;
async function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  log(`${signal} reçu, arrêt et suppression des conteneurs…`);
  clearInterval(heartbeat);
  server.close();
  const force = setTimeout(() => process.exit(1), 15_000);
  await Promise.allSettled([...sessions].map((s) => s.end('server_shutdown')));
  await removeOrphans().catch(() => {});
  clearTimeout(force);
  process.exit(0);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

main();
