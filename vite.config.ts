import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'jsdom',
    globals: true,
    include: ['apps/**/*.test.{ts,tsx}', 'packages/**/*.test.ts', 'scripts/**/*.test.mjs'],
    setupFiles: './apps/demo/src/test/setup.ts',
  },
})
