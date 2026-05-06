import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { defineConfig } from 'tsup';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  entry: [
    'src/integration-runner.ts',
    'src/e2e-runner.ts',
    'src/vitest-config.ts',
    'src/vitest-setup.ts',
    'src/cypress-config.ts',
    'src/compose-file.ts',
  ],
  format: ['esm'],
  dts: true,
  outDir: 'dist',
  clean: true,
  sourcemap: false,
  splitting: false,
  target: 'node20',
  tsconfig: './tsconfig.json',
  esbuildOptions(options) {
    options.alias = {
      '@': path.resolve(__dirname, 'src'),
    };
  },
});
