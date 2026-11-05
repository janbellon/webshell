// One session is one WebSocket connection and one disposable container.

import crypto from 'node:crypto';
import { WebSocket } from 'ws';

export const LABEL_MANAGED = 'websh.managed';

// Backpressure threshold for data waiting to be written, in either direction.
const MAX_BUFFERED = 1024 * 1024;

function containerSpec(config, sessionId, clientKey) {
  const tmpfsOpts = `rw,nosuid,nodev,size=${config.tmpSize}`;
  const hostConfig = {
    AutoRemove: true, // Safety net: Docker removes the container once it stops.
    Init: true, // Runs tini as PID 1 to reap zombies.
    NetworkMode: config.network,
    Memory: config.memory,
    MemorySwap: config.memory, // No swap.
    NanoCpus: Math.round(config.cpus * 1e9),
    PidsLimit: config.pids, // Fork bomb protection.
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
    this.creating = false;
    this.started = false;
    this.ended = false;
    this.cleaned = false;
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
      // end() defers cleanup to this method while the container is being created.
      if (this.ended) return this.cleanup();

      const stream = await this.docker.attach(this.containerId);
      if (this.ended) {
        stream.destroy();
        return this.cleanup();
      }
      this.stream = stream;
      this.wireStream();

      await this.docker.startContainer(this.containerId);
      this.started = true;
      if (this.ended) return this.cleanup();

      if (this.size) await this.applyResize();
      if (this.ended) return this.cleanup();
    } catch (err) {
      this.log(`startup error: ${err.message}`);
      if (this.ended) return this.cleanup();
      this.sendControl({
        type: 'error',
        code: 'start_failed',
        message: 'Could not start the container. Please try again in a moment.',
      });
      return this.end('start_failed');
    }

    const now = Date.now();
    this.log(`container ${this.containerId.slice(0, 12)} started for ${this.clientKey}`);
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
      // Stop reading from the container when the browser cannot keep up (e.g. `yes`).
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
    // The shell exited (`exit`, Ctrl-D), which stops the container.
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
    if (msg?.type === 'input' && typeof msg.data === 'string') {
      if (this.stream && this.started) {
        // Drop input the shell is not reading rather than buffering it without bound.
        if (this.stream.writableLength < MAX_BUFFERED) this.stream.write(msg.data);
        this.resetIdle();
      }
    } else if (msg?.type === 'resize') {
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
      // The container may already be stopping.
    }
  }

  resetIdle() {
    clearTimeout(this.idleTimer);
    if (this.config.idleSeconds > 0) {
      this.idleTimer = setTimeout(() => this.end('idle'), this.config.idleSeconds * 1000);
    }
  }

  // Idempotent.
  end(reason) {
    if (this.ended) return this.cleanupPromise;
    this.ended = true;
    this.log(`session ended (${reason})`);
    this.sendControl({ type: 'exit', reason });
    if (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING) {
      this.ws.close(1000, reason);
    }
    // During creation, start() calls cleanup() once the outcome is known.
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
        this.log(`container ${this.containerId.slice(0, 12)} removed`);
      }
    } catch (err) {
      this.log(`failed to remove ${this.containerId}: ${err.message}`);
    } finally {
      // The slot is only released once the container is really gone.
      this.release();
      this.onEnd(this);
    }
  }
}
