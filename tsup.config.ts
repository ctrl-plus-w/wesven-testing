import { defineConfig } from 'tsup';

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
});
