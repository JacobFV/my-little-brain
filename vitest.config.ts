import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: {
    include: [
      'packages/**/*.test.ts',
      'apps/server/**/*.test.ts',
      'apps/web/**/*.test.{ts,tsx}',
      'apps/mobile/**/*.test.ts',
      'apps/worker/**/*.test.ts',
      'apps/desktop/**/*.test.ts',
    ],
    exclude: ['**/node_modules/**'],
  },
});
