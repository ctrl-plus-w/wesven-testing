import tsconfigPaths from 'vite-tsconfig-paths';
import { defineConfig } from 'vitest/config';

process.env.NO_COLOR = '1';

export default defineConfig({
  plugins: [tsconfigPaths()],
  test: {
    environment: 'node',
    include: ['tests/unit/**/*.test.ts'],
    globals: true,
    env: {
      NO_COLOR: '1',
    },
  },
});
