import type { TestProjectConfiguration } from 'vitest/config';
import { defineConfig } from 'vitest/config'

const reactUi: TestProjectConfiguration = {
  extends: './vite.config.ts',
  test: {
    name: 'ui',
    environment: 'jsdom',
    environmentOptions: { jsdom: { url: 'http://localhost/' } },
    setupFiles: ['./vitest.setup.ts'],
    include: ['src/**/*.test.{ts,tsx}'],
    globals: true,
    // The first test in each file pays jsdom env init + full module transform. QUINE runs the lint,
    // test, and coverage gates concurrently, and other areas' builds alongside them, so the machine
    // is saturated by design rather than by accident; 15s still lost to it.
    testTimeout: 60_000,
    hookTimeout: 60_000
  }
}

const electronNative: TestProjectConfiguration = {
  test: {
    name: 'electron',
    environment: 'node',
    include: ['electron/**/*.test.ts', 'scripts/**.test.{ts,mjs}'],
    exclude: ['electron/windows-remote-live.test.ts'],
    // Git, SSH, and child-process fixtures are the first thing a saturated machine starves, and
    // QUINE saturates it on purpose. These are inherited Hermes tests measuring real subprocesses,
    // so the wall clock they need is a property of the load, not of the assertion.
    testTimeout: 60_000,
    hookTimeout: 60_000
  }
}

export default defineConfig({
  test: {
    projects: [reactUi, electronNative]
  }
})
