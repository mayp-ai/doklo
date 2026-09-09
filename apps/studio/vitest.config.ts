import { defineConfig } from 'vitest/config';

export default defineConfig({
  esbuild: { jsx: 'automatic' },
  test: {
    include: ['__tests__/**/*.test.{ts,tsx}'],
    environment: 'node',
  },
});
