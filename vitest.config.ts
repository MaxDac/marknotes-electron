import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    coverage: {
      provider: 'v8',
      include: ['src/**/*.{ts,tsx}'],
      exclude: ['src/**/*.d.ts'],
      reporter: ['text-summary', 'html', 'json-summary'],
      reportsDirectory: 'coverage',
      // A ratchet: the measured coverage rounded down. Raise these when tests are added; never lower them.
      thresholds: {
        statements: 61,
        branches: 52,
        functions: 55,
        lines: 63,
      },
    },
  },
});
