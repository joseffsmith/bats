import { defineConfig, configDefaults } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    // The Phase 1 browser e2e suite runs under its own config (real Chromium,
    // one at a time). Keep it out of the fast unit run — `npm run test:e2e`.
    exclude: [...configDefaults.exclude, 'e2e/**'],
  },
});
