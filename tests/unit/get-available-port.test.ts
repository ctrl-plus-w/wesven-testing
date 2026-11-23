import { createServer, type Server } from 'node:net';

import { describe, expect, it } from 'vitest';

import { getAvailablePort, isPortInUse } from '@/internal/get-available-port';

const listenOnFreePort = (): Promise<{ server: Server; port: number }> =>
  new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        reject(new Error('no TCP address'));
        return;
      }
      resolve({ server, port: address.port });
    });
  });

const close = (server: Server): Promise<void> =>
  new Promise((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });

describe('getAvailablePort', () => {
  it('returns a usable TCP port', async () => {
    const port = await getAvailablePort();
    expect(port).toBeGreaterThan(0);

    await new Promise<void>((resolve, reject) => {
      const server = createServer();
      server.once('error', reject);
      server.listen(port, () => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    });
  });

  it('does not return the same port twice in immediate succession', async () => {
    const ports = await Promise.all(Array.from({ length: 8 }, () => getAvailablePort()));
    const unique = new Set(ports);
    expect(unique.size).toBeGreaterThan(1);
  });
});

describe('isPortInUse', () => {
  it('reports a port that a server answers on', async () => {
    const { server, port } = await listenOnFreePort();
    try {
      expect(await isPortInUse(port), 'a readiness wait would pass on this server').toBe(true);
    } finally {
      await close(server);
    }
  });

  it('reports a port that nothing answers on as free', async () => {
    const { server, port } = await listenOnFreePort();
    await close(server);

    expect(await isPortInUse(port), 'a refused connection means the port is free').toBe(false);
  });
});
