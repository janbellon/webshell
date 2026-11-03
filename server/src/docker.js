// Client minimal pour l'API Docker Engine via le socket Unix.
// Volontairement sans dépendance : ce processus a accès au socket Docker,
// donc moins il embarque de code tiers, mieux c'est.

import http from 'node:http';

export class DockerError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export class Docker {
  constructor(socketPath) {
    this.socketPath = socketPath;
  }

  request(method, path, body, { timeoutMs = 30_000 } = {}) {
    return new Promise((resolve, reject) => {
      const payload = body === undefined ? undefined : JSON.stringify(body);
      const req = http.request(
        {
          socketPath: this.socketPath,
          method,
          path,
          headers: {
            Host: 'docker',
            ...(payload && {
              'Content-Type': 'application/json',
              'Content-Length': Buffer.byteLength(payload),
            }),
          },
        },
        (res) => {
          const chunks = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => {
            const text = Buffer.concat(chunks).toString('utf8');
            let json = null;
            try {
              json = text ? JSON.parse(text) : null;
            } catch {
              /* réponse non JSON */
            }
            if (res.statusCode >= 400) {
              reject(new DockerError(res.statusCode, json?.message || text || `HTTP ${res.statusCode}`));
            } else {
              resolve({ status: res.statusCode, body: json });
            }
          });
        },
      );
      req.setTimeout(timeoutMs, () => req.destroy(new Error(`Docker API timeout: ${method} ${path}`)));
      req.on('error', reject);
      if (payload) req.write(payload);
      req.end();
    });
  }

  async ping() {
    await this.request('GET', '/_ping', undefined, { timeoutMs: 5000 });
  }

  async imageExists(name) {
    try {
      await this.request('GET', `/images/${encodeURIComponent(name)}/json`);
      return true;
    } catch (err) {
      if (err.status === 404) return false;
      throw err;
    }
  }

  async createContainer(spec) {
    const { body } = await this.request('POST', '/containers/create', spec);
    return body.Id;
  }

  async startContainer(id) {
    await this.request('POST', `/containers/${id}/start`);
  }

  async resizeContainer(id, rows, cols) {
    await this.request('POST', `/containers/${id}/resize?h=${rows}&w=${cols}`);
  }

  // Suppression forcée ; ignore « déjà supprimé » et « suppression en cours ».
  async removeContainer(id) {
    try {
      await this.request('DELETE', `/containers/${id}?force=true&v=true`);
    } catch (err) {
      if (err.status === 404 || err.status === 409) return;
      throw err;
    }
  }

  async listContainers(labelFilter) {
    const filters = encodeURIComponent(JSON.stringify({ label: [labelFilter] }));
    const { body } = await this.request('GET', `/containers/json?all=true&filters=${filters}`);
    return body;
  }

  // Ouvre un flux bidirectionnel (stdin/stdout) brut sur le TTY du conteneur.
  // Résout avec le socket « hijacké » par Docker.
  attach(id) {
    return new Promise((resolve, reject) => {
      const req = http.request({
        socketPath: this.socketPath,
        method: 'POST',
        path: `/containers/${id}/attach?stream=1&stdin=1&stdout=1&stderr=1`,
        headers: { Host: 'docker', Connection: 'Upgrade', Upgrade: 'tcp' },
      });
      req.on('upgrade', (_res, socket, head) => {
        if (head && head.length) socket.unshift(head);
        resolve(socket);
      });
      req.on('response', (res) => {
        // Pas d'upgrade => erreur
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () =>
          reject(new DockerError(res.statusCode, Buffer.concat(chunks).toString() || 'attach failed')),
        );
      });
      req.setTimeout(30_000, () => req.destroy(new Error('Docker attach timeout')));
      req.on('error', reject);
      req.end();
    });
  }
}
