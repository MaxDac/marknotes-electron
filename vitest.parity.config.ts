import { defineConfig } from 'vitest/config';

// Shared marknotes-spec fixtures (spec/ submodule); run with `npm run test:parity`.
export default defineConfig({
  test: {
    include: ['parity/**/*.test.ts'],
    environment: 'node',
  },
});
