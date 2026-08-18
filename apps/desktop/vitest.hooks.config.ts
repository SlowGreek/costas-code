import path from 'node:path'

import { defineConfig } from 'vitest/config'

/**
 * Scoped runner for React component/hook tests.
 *
 * The workspace has a split React install: `@testing-library/react` is hoisted
 * to the monorepo root and resolves the ROOT's react/react-dom, while the app
 * aliases to `apps/desktop`'s pnpm copy. Two React instances means every hook
 * fails with "Cannot read properties of null (reading 'useRef')" — a
 * pre-existing environment issue, not a product bug.
 *
 * Pinning both to a single copy lets these tests actually exercise the code.
 * Delete once the workspace install is deduped (fixing it in the shared
 * vitest.config.ts breaks ~74 other files that resolve the workspace copy).
 */
const root = path.resolve(__dirname, '../..')
const react = path.join(root, 'node_modules/react')

export default defineConfig({
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src'),
      react,
      'react/jsx-dev-runtime': path.join(react, 'jsx-dev-runtime.js'),
      'react/jsx-runtime': path.join(react, 'jsx-runtime.js'),
      'react-dom': path.join(root, 'node_modules/react-dom')
    }
  },
  test: {
    environment: 'jsdom',
    globals: true,
    include: [path.resolve(__dirname, 'src/app/chat/composer/hooks/*.test.tsx')],
    setupFiles: [path.resolve(__dirname, 'vitest.setup.ts')]
  }
})
