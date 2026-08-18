import path from 'node:path'

import { defineConfig } from 'vitest/config'

/**
 * Scoped runner for the sketch renderer tests.
 *
 * The worktree has a split React install (apps/desktop/node_modules/react via
 * pnpm vs the root node_modules/react-dom), which makes ANY hook-using
 * component test fail with "Cannot read properties of null (reading
 * 'useState')" — a pre-existing environment issue, not a product bug. Pinning
 * react/react-dom to a single copy lets these tests actually exercise the
 * component. Delete once the workspace install is deduped.
 */
const root = path.resolve(__dirname, '../../../../../..')
const react = path.join(root, 'node_modules/react')

export default defineConfig({
  resolve: {
    alias: {
      '@': path.resolve(__dirname, '../../../'),
      react,
      'react/jsx-dev-runtime': path.join(react, 'jsx-dev-runtime.js'),
      'react/jsx-runtime': path.join(react, 'jsx-runtime.js'),
      'react-dom': path.join(root, 'node_modules/react-dom')
    }
  },
  test: {
    environment: 'jsdom',
    globals: true,
    include: [path.join(__dirname, '*.test.{ts,tsx}')],
    setupFiles: [path.resolve(__dirname, '../../../../vitest.setup.ts')]
  }
})
