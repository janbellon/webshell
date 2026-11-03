// Une session = une connexion WebSocket = un conteneur jetable.

import crypto from 'node:crypto';
import { WebSocket } from 'ws';

export const LABEL_MANAGED = 'websh.managed';

const MAX_BUFFERED = 1024 * 1024; // backpressure : 1 Mo en attente côté WebSocket

function containerSpec(config, sessionId, clientKey) {
  const tmpfsOpts = `rw,nosuid,nodev,size=${config.tmpSize}`;
  const hostConfig = {
    AutoRemove: true, // filet de sécurité : Docker supprime le conteneur dès qu'il s'arrête
    Init: true, // petit init (tini) en PID 1 pour récolter les zombies
    NetworkMode: config.network,
    Memory: config.memory,
    MemorySwap: config.memory, // pas de swap
    NanoCpus: Math.round(config.cpus * 1e9),
    PidsLimit: config.pids, // anti fork-bomb
    CapDrop: ['ALL'],
    SecurityOpt: ['no-new-privileges'],
    ReadonlyRootfs: true,
    Tmpfs: {
      '/tmp': tmpfsOpts,
      '/home/sandbox': `${tmpfsOpts},uid=1000,gid=1000,mode=0700`,
    },
    Ulimits: [{ Name: 'nofile', Soft: 1024, Hard: 1024 }],
  };
  if (config.runtime) hostConfig.Runtime = config.runtime;

  return {
    Image: config.image,
    Hostname: 'sandbox',
    User: '1000:1000',
    WorkingDir: '/home/sandbox',
    Cmd: config.shell,
    Env: ['TERM=xterm-256color', 'LANG=C.UTF-8', 'HOME=/home/sandbox'],
    Tty: true,
    OpenStdin: true,
    StdinOnce: true,
    AttachStdin: true,
    AttachStdout: true,
    AttachStderr: true,
    NetworkDisabled: config.network === 'none',
    Labels: {
      [LABEL_MANAGED]: 'true',
      'websh.session': sessionId,
      'websh.client': clientKey,
    },
    HostConfig: hostConfig,
  };
}

function clampInt(v, min, max) {
  const n = Number(v);
  if (!Number.isInteger(n)) return null;
  return Math.min(max, Math.max(min, n));
}

export class Session {
  constructor({ ws, docker, config, clientKey, release, initialSize, log, onEnd }) {
    this.id = crypto.randomBytes(6).toString('hex');
    this.ws = ws;
    this.docker = docker;
    this.config = config;
    this.clientKey = clientKey;
    this.release = release;
    this.size = initialSize;
    this.log = (msg) => log(`[${this.id}] ${msg}`);
    this.onEnd = onEnd;

    this.containerId = null;
    this.stream = null;
    this.started = false;
    this.ended = false;
    this.timers = [];
    this.resizeTimer = null;
    this.idleTimer = null;
    this.drainTimer = null;
  }

  sendControl(msg) {
    if (this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }

  async start() {
    this.ws.on('message', (data, isBinary) => this.onClientMessage(data, isBinary));
    this.ws.on('close', () => this.end('client_closed'));
    this.ws.on('error', () => this.end('client_error'));

    this.sendControl({ type: 'status', state: 'creating' });

    try {
      this.creating = true;
      try {
        this.containerId = await this.docker.createContainer(
          containerSpec(this.config, this.id, this.clientKey),
        );
      } finally {
        this.creating = false;
      }
      if (this.ended) return this.cleanup(); // le client est parti pendant la création

      this.stream = await this.docker.attach(this.containerId);
      if (this.ended) return this.cleanup();
      this.wireStream();

      await this.docker.startContainer(this.containerId);
      this.started = true;
      if (this.ended) return this.cleanup();

      if (this.size) await this.applyResize();
    } catch (err) {
      this.log(`erreur au démarrage : ${err.message}`);
      this.sendControl({
        type: 'error',
        code: 'start_failed',
        message: "Impossible de démarrer le conteneur. Réessayez dans un instant.",
      });
      return this.end('start_failed');
    }

    const now = Date.now();
    this.log(`conteneur ${this.containerId.slice(0, 12)} démarré pour ${this.clientKey}`);
    this.sendControl({
      type: 'ready',
      container: this.containerId.slice(0, 12),
      expiresAt: now + this.config.maxSessionSeconds * 1000,
      idleSeconds: this.config.idleSeconds,
    });

    this.timers.push(setTimeout(() => this.end('max_duration'), this.config.maxSessionSeconds * 1000));
    this.resetIdle();
  }

  wireStream() {
    const stream = this.stream;
    stream.on('data', (chunk) => {
      if (this.ws.readyState !== WebSocket.OPEN) return;
      this.ws.send(chunk, { binary: true });
      // Si le navigateur ne suit pas (ex. `yes`), on suspend la lecture du conteneur.
      if (this.ws.bufferedAmount > MAX_BUFFERED && !this.drainTimer) {
        stream.pause();
        this.drainTimer = setInterval(() => {
          if (this.ws.readyState !== WebSocket.OPEN || this.ws.bufferedAmount < MAX_BUFFERED / 4) {
            clearInterval(this.drainTimer);
            this.drainTimer = null;
            stream.resume();
          }
        }, 50);
      }
    });
    // Le shell s'est terminé (`exit`, Ctrl-D…) => le conteneur s'arrête.
    stream.on('end', () => this.end('shell_exited'));
    stream.on('close', () => this.end('shell_exited'));
    stream.on('error', () => this.end('stream_error'));
  }

  onClientMessage(data, isBinary) {
    if (this.ended || isBinary) return;
    let msg;
    try {
      msg = JSON.parse(data.toString('utf8'));
    } catch {
      return;
    }
    if (msg.type === 'input' && typeof msg.data === 'string') {
      if (this.stream && this.started) {
        this.stream.write(msg.data);
        this.resetIdle();
      }
    } else if (msg.type === 'resize') {
      const cols = clampInt(msg.cols, 2, 500);
      const rows = clampInt(msg.rows, 2, 300);
      if (cols && rows) {
        this.size = { cols, rows };
        clearTimeout(this.resizeTimer);
        this.resizeTimer = setTimeout(() => this.applyResize(), 80);
      }
    }
  }

  async applyResize() {
    if (!this.started || this.ended || !this.size) return;
    try {
      await this.docker.resizeContainer(this.containerId, this.size.rows, this.size.cols);
    } catch {
      /* le conteneur peut être en train de s'arrêter */
    }
  }

  resetIdle() {
    clearTimeout(this.idleTimer);
    if (this.config.idleSeconds > 0) {
      this.idleTimer = setTimeout(() => this.end('idle'), this.config.idleSeconds * 1000);
    }
  }

  // Fin de session : idempotent.
  end(reason) {
    if (this.ended) return this.cleanupPromise;
    this.ended = true;
    this.log(`fin de session (${reason})`);
    this.sendControl({ type: 'exit', reason });
    if (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING) {
      this.ws.close(1000, reason);
    }
    // Pendant la création, start() appellera cleanup() dès que l'ID sera connu.
    this.cleanupPromise = this.creating ? Promise.resolve() : this.cleanup();
    return this.cleanupPromise;
  }

  async cleanup() {
    if (this.cleaned) return;
    this.cleaned = true;

    for (const t of this.timers) clearTimeout(t);
    clearTimeout(this.idleTimer);
    clearTimeout(this.resizeTimer);
    clearInterval(this.drainTimer);
    this.stream?.destroy();

    try {
      if (this.containerId) {
        await this.docker.removeContainer(this.containerId);
        this.log(`conteneur ${this.containerId.slice(0, 12)} supprimé`);
      }
    } catch (err) {
      this.log(`échec de suppression de ${this.containerId}: ${err.message}`);
    } finally {
      // Le créneau n'est libéré qu'une fois le conteneur réellement supprimé.
      this.release();
      this.onEnd(this);
    }
  }
}
