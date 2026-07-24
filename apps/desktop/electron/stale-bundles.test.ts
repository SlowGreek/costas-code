import assert from 'node:assert/strict'
import path from 'node:path'

import { test } from 'vitest'

import { staleBundlePaths } from './stale-bundles'

const APPS = '/Applications'

test('retires superseded shipped-name and rollback bundles beside the running app', () => {
  const stale = staleBundlePaths({
    runningAppPath: path.join(APPS, 'Catalyst.app'),
    siblingNames: [
      'Catalyst.app',
      'Costas Code.app',
      'CostasCode.app',
      'CostasCode.rollback.app',
      'CostasCode.rollback-final.app',
      'CostasCode.rollback-dual-provider.app',
      'Hermes.app'
    ]
  })

  assert.deepEqual(stale, [
    path.join(APPS, 'Costas Code.app'),
    path.join(APPS, 'CostasCode.app'),
    path.join(APPS, 'CostasCode.rollback.app'),
    path.join(APPS, 'CostasCode.rollback-final.app'),
    path.join(APPS, 'CostasCode.rollback-dual-provider.app'),
    path.join(APPS, 'Hermes.app')
  ])
})

test('never proposes the running bundle, even under a legacy name', () => {
  // A user still on the old build must not delete the app they launched.
  const stale = staleBundlePaths({
    runningAppPath: path.join(APPS, 'Costas Code.app'),
    siblingNames: ['Costas Code.app', 'Hermes.app']
  })

  assert.deepEqual(stale, [path.join(APPS, 'Hermes.app')])
  assert.ok(!stale.includes(path.join(APPS, 'Costas Code.app')))
})

test('leaves unrelated apps and non-bundles alone', () => {
  const stale = staleBundlePaths({
    runningAppPath: path.join(APPS, 'Catalyst.app'),
    siblingNames: [
      'Catalyst.app',
      'Safari.app',
      'Hermes Notes.app',
      'CatalystDesigner.app',
      'Catalyst',
      'Hermes.app.backup',
      'README.txt'
    ]
  })

  assert.deepEqual(stale, [])
})

test('only reaches siblings of the running bundle', () => {
  const stale = staleBundlePaths({
    runningAppPath: path.join('/Users/demo/Applications', 'Catalyst.app'),
    siblingNames: ['Hermes.app']
  })

  assert.deepEqual(stale, [path.join('/Users/demo/Applications', 'Hermes.app')])
})

test('returns nothing in the steady state after cleanup', () => {
  assert.deepEqual(
    staleBundlePaths({
      runningAppPath: path.join(APPS, 'Catalyst.app'),
      siblingNames: ['Catalyst.app']
    }),
    []
  )
})
