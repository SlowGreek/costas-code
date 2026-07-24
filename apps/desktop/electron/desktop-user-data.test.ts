import assert from 'node:assert/strict'
import path from 'node:path'

import { test } from 'vitest'

import { resolveDesktopUserDataPath } from './desktop-user-data'

test('Catalyst preserves the existing Costas Code desktop data directory', () => {
  assert.equal(
    resolveDesktopUserDataPath({ appDataPath: path.join('/Users', 'demo', 'Library', 'Application Support') }),
    path.join('/Users', 'demo', 'Library', 'Application Support', 'Costas Code')
  )
})

test('an explicit desktop user-data override remains authoritative', () => {
  assert.equal(
    resolveDesktopUserDataPath({
      appDataPath: path.join('/Users', 'demo', 'Library', 'Application Support'),
      overridePath: path.join('/tmp', 'catalyst-test-profile')
    }),
    path.resolve('/tmp', 'catalyst-test-profile')
  )
})
