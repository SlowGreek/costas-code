import type { TestProjectConfiguration } from 'vitest/config'
import { defineConfig } from 'vitest/config'

const windowsRemoteLive: TestProjectConfiguration = {
  test: {
    name: 'windows-remote-live',
    environment: 'node',
    include: ['electron/windows-remote-live.test.ts'],
    testTimeout: 90_000
  }
}

export default defineConfig({
  test: {
    projects: [windowsRemoteLive]
  }
})
