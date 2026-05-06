import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Absolute path to the package's default `compose.test.yaml`.
 *
 * Pass this to `docker compose -f` directly, or override the runner's `composeFile`
 * option to point at a project-owned file.
 */
export const composeFilePath: string = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'assets',
  'compose.test.yaml',
);
