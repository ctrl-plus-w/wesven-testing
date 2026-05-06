import { createServer } from 'node:net';

import { describe, expect, it } from 'vitest';

import { getAvailablePort } from '@/internal/get-available-port';

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
