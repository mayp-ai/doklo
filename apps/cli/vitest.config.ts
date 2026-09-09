import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['__tests__/**/*.test.ts'],
    environment: 'node',
    // Integration tests scan projects and spawn processes on shared CI runners.
    testTimeout: process.env.CI ? 30_000 : 5_000,
  },
});
