// All configuration comes from environment variables.

function int(name, def) {
  const v = process.env[name];
  if (v === undefined || v === '') return def;
  const n = Number.parseInt(v, 10);
  if (!Number.isFinite(n)) throw new Error(`${name} must be an integer (got "${v}")`);
  return n;
}

function float(name, def) {
  const v = process.env[name];
  if (v === undefined || v === '') return def;
  const n = Number.parseFloat(v);
  if (!Number.isFinite(n)) throw new Error(`${name} must be a number (got "${v}")`);
  return n;
}

function bool(name, def) {
  const v = process.env[name];
  if (v === undefined || v === '') return def;
  return ['1', 'true', 'yes', 'on'].includes(v.toLowerCase());
}

// Parses "256m", "1g", "512k" or a plain byte count into bytes.
function bytes(name, def) {
  const v = (process.env[name] || def).toString().trim().toLowerCase();
  const m = v.match(/^(\d+(?:\.\d+)?)\s*([kmg]?)b?$/);
  if (!m) throw new Error(`${name} is invalid (expected e.g. 256m or 1g): "${v}"`);
  const mult = { '': 1, k: 1024, m: 1024 ** 2, g: 1024 ** 3 }[m[2]];
  return Math.round(Number.parseFloat(m[1]) * mult);
}

function list(name) {
  const v = process.env[name];
  if (!v) return [];
  return v.split(',').map((s) => s.trim()).filter(Boolean);
}

export const config = {
  port: int('PORT', 3000),
  host: process.env.HOST || '0.0.0.0',

  dockerSocket: process.env.DOCKER_SOCKET || '/var/run/docker.sock',

  // Rate limit: concurrent containers.
  maxPerIp: int('MAX_CONTAINERS_PER_IP', 10),
  maxTotal: int('MAX_CONTAINERS_TOTAL', 50),

  // Read the client IP from X-Forwarded-For when running behind a reverse proxy.
  trustProxy: bool('TRUST_PROXY', false),
  // Origins allowed to open a WebSocket. Empty means same host as the page.
  allowedOrigins: list('ALLOWED_ORIGINS'),

  // Sandbox container.
  image: process.env.SANDBOX_IMAGE || 'websh-sandbox:latest',
  shell: list('SANDBOX_SHELL').length ? list('SANDBOX_SHELL') : ['/bin/bash', '-l'],
  memory: bytes('SANDBOX_MEMORY', '256m'),
  cpus: float('SANDBOX_CPUS', 0.5),
  pids: int('SANDBOX_PIDS', 128),
  tmpSize: process.env.SANDBOX_TMP_SIZE || '64m',
  network: process.env.SANDBOX_NETWORK || 'none',
  runtime: process.env.SANDBOX_RUNTIME || '', // For example "runsc" (gVisor).

  // Lifetimes, in seconds.
  maxSessionSeconds: int('SESSION_MAX_SECONDS', 30 * 60),
  idleSeconds: int('SESSION_IDLE_SECONDS', 10 * 60),
};
