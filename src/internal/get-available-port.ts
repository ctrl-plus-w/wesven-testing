import { createServer } from 'node:net';

/**
 * Asks the OS for an available TCP port by binding to port 0 then closing.
 */
export const getAvailablePort = (): Promise<number> => {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close();
        reject(new Error('Failed to acquire an available port'));
        return;
      }
      const { port } = address;
      server.close(() => {
        resolve(port);
      });
    });
  });
};

export interface PortChoice {
  port: number;
  fromEnv: boolean;
}

/**
 * Returns either the port pinned in `process.env[envName]` (`fromEnv: true`) or
 * a fresh OS-allocated port (`fromEnv: false`). Throws on a non-positive-integer
 * env value so callers get a clear failure instead of a port-zero bind.
 */
export const resolvePort = async (envName: 'TEST_DB_PORT' | 'PORT'): Promise<PortChoice> => {
  const fromEnv = process.env[envName];
  if (fromEnv && fromEnv.length > 0) {
    const parsed = Number(fromEnv);
    if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`Invalid ${envName}="${fromEnv}"`);
    return { port: parsed, fromEnv: true };
  }
  return { port: await getAvailablePort(), fromEnv: false };
};
