import react from '@vitejs/plugin-react';
import tsconfigPaths from 'vite-tsconfig-paths';
import { defineConfig } from 'vitest/config';

const plugins = [tsconfigPaths(), react()];

/**
 * Base Vitest config for integration tests.
 *
 * Defaults: jsdom environment, single-fork pool (one Postgres-backed worker),
 * 30s test/hook timeouts, `tests/integration/**` include glob, vitest globals,
 * and the `tsconfig-paths` + `@vitejs/plugin-react` plugins.
 *
 * Extend in your project with `mergeConfig(integrationConfig, { ... })`.
 */
export const integrationConfig = defineConfig({
  plugins,
  test: {
    environment: 'jsdom',
    include: ['tests/integration/**/*.test.{ts,tsx}'],
    globals: true,

    testTimeout: 30000,
    hookTimeout: 30000,

    pool: 'forks',
    poolOptions: {
      forks: {
        singleFork: true,
      },
    },
  },
});

/**
 * Base Vitest config for unit tests.
 *
 * Defaults: node environment, `tests/unit/**` include glob, vitest globals,
 * and the `tsconfig-paths` + `@vitejs/plugin-react` plugins.
 *
 * Extend in your project with `mergeConfig(unitConfig, { ... })`.
 */
export const unitConfig = defineConfig({
  plugins,
  test: {
    environment: 'node',
    include: ['tests/unit/**/*.test.{ts,tsx}'],
    globals: true,
  },
});
