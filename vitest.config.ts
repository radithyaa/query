import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      '@portfolio/shared': new URL('./packages/shared/src/index.ts', import.meta.url).pathname,
      '@portfolio/db': new URL('./packages/db/src/index.ts', import.meta.url).pathname,
      '@portfolio/agents': new URL('./packages/agents/src/index.ts', import.meta.url).pathname,
      '@portfolio/connectors': new URL('./packages/connectors/src/index.ts', import.meta.url).pathname,
    },
  },
  test: {
    include: ['packages/**/*.test.ts', 'apps/**/*.test.ts', 'tests/**/*.test.ts'],
    environment: 'node',
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
