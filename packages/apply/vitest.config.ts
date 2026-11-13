import { defineConfig } from 'vitest/config'

export default defineConfig({
  // The tests run git in temporary repositories; one builds 51 commits, which takes more than 5 s on a busy machine.
  test: { include: ['test/**/*.test.ts'], testTimeout: 30_000 },
})
