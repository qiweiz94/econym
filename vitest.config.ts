import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['packages/plugins/*/tests/**/*.spec.ts', 'packages/guard/*/tests/**/*.spec.ts', 'packages/bench/*/tests/**/*.spec.ts'],
    environment: 'node',
    // tree-sitter native bindings + subprocess spawns need real timers
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
})
