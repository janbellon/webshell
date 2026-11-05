// Limits concurrent containers, per client and overall.
// A slot is reserved synchronously before the container is created, so a burst
// of parallel connections cannot exceed the limit.

import net from 'node:net';

export class ConcurrencyLimiter {
  constructor({ perKey, total }) {
    this.perKey = perKey;
    this.total = total;
    this.counts = new Map();
    this.active = 0;
  }

  // Returns { ok: true, release } or { ok: false, reason: 'per_client' | 'global' }.
  acquire(key) {
    const current = this.counts.get(key) ?? 0;
    if (current >= this.perKey) return { ok: false, reason: 'per_client' };
    if (this.active >= this.total) return { ok: false, reason: 'global' };

    this.counts.set(key, current + 1);
    this.active += 1;

    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      this.active -= 1;
      const n = (this.counts.get(key) ?? 1) - 1;
      if (n <= 0) this.counts.delete(key);
      else this.counts.set(key, n);
    };
    return { ok: true, release };
  }

  countFor(key) {
    return this.counts.get(key) ?? 0;
  }
}

// Expands an IPv6 address into 8 hexadecimal groups.
function expandIPv6(ip) {
  const [head, tail] = ip.split('::');
  const h = head ? head.split(':') : [];
  const t = tail !== undefined && tail !== '' ? tail.split(':') : [];
  const fill = tail !== undefined ? Array(8 - h.length - t.length).fill('0') : [];
  return [...h, ...fill, ...t].map((g) => g.padStart(4, '0'));
}

// Rate limit key for an address: IPv4 as is, and the /64 prefix for IPv6, since a
// client usually owns a whole /64 and can rotate addresses within it at will.
export function rateLimitKey(ip) {
  if (!ip) return 'unknown';
  let addr = ip.trim();
  if (addr.startsWith('::ffff:') && net.isIPv4(addr.slice(7))) addr = addr.slice(7);
  if (net.isIPv4(addr)) return addr;
  if (net.isIPv6(addr)) {
    try {
      return `${expandIPv6(addr.split('%')[0]).slice(0, 4).join(':')}::/64`;
    } catch {
      return addr;
    }
  }
  return addr;
}
