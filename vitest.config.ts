import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    // Diagnostics run real child processes; keep a generous but bounded ceiling.
    testTimeout: 30_000,
  },
});
