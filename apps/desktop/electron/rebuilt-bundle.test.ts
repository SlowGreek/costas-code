import assert from 'node:assert/strict'
import path from 'node:path'

import { test } from 'vitest'

import { type RebuiltBundleProbes, resolveRebuiltMacBundle } from './rebuilt-bundle'

const ROOT = '/Users/demo/.hermes/hermes-agent'
const REL = path.join(ROOT, 'apps', 'desktop', 'release')

function probesFor(tree: Record<string, string[]>, mtimes: Record<string, number> = {}): RebuiltBundleProbes {
  return {
    isDirectory: candidate => candidate.endsWith('.app'),
    modifiedAtMs: candidate => mtimes[path.basename(candidate)] ?? 0,
    readDir: dirPath => tree[dirPath] ?? []
  }
}

test('finds a bundle whose name did not exist when this updater shipped', () => {
  // The regression that stranded the Costas Code -> Catalyst hop: the running
  // updater has never heard of "Catalyst.app", but must still resolve it.
  const resolved = resolveRebuiltMacBundle({
    probes: probesFor({ [path.join(REL, 'mac-arm64')]: ['Catalyst.app'] }),
    runningBundleName: 'Costas Code.app',
    updateRoot: ROOT
  })

  assert.equal(resolved, path.join(REL, 'mac-arm64', 'Catalyst.app'))
})

test('prefers an in-place swap when the running name is still being built', () => {
  const resolved = resolveRebuiltMacBundle({
    probes: probesFor(
      { [path.join(REL, 'mac-arm64')]: ['Catalyst.app', 'Costas Code.app'] },
      // Catalyst.app is newer, but an in-place swap is the safer choice.
      { 'Catalyst.app': 2000, 'Costas Code.app': 1000 }
    ),
    preferredName: 'Catalyst.app',
    runningBundleName: 'Costas Code.app',
    updateRoot: ROOT
  })

  assert.equal(resolved, path.join(REL, 'mac-arm64', 'Costas Code.app'))
})

test('falls to the current product name when the running name is absent', () => {
  const resolved = resolveRebuiltMacBundle({
    probes: probesFor(
      { [path.join(REL, 'mac-arm64')]: ['Catalyst.app', 'Hermes.app'] },
      { 'Catalyst.app': 1000, 'Hermes.app': 5000 }
    ),
    preferredName: 'Catalyst.app',
    runningBundleName: 'Costas Code.app',
    updateRoot: ROOT
  })

  assert.equal(resolved, path.join(REL, 'mac-arm64', 'Catalyst.app'))
})

test('otherwise takes the freshest build output', () => {
  const resolved = resolveRebuiltMacBundle({
    probes: probesFor(
      { [path.join(REL, 'mac-arm64')]: ['Alpha.app', 'Beta.app'] },
      { 'Alpha.app': 1000, 'Beta.app': 9000 }
    ),
    updateRoot: ROOT
  })

  assert.equal(resolved, path.join(REL, 'mac-arm64', 'Beta.app'))
})

test('is deterministic when nothing else distinguishes candidates', () => {
  const tree = { [path.join(REL, 'mac-arm64')]: ['Zeta.app', 'Alpha.app'] }

  const first = resolveRebuiltMacBundle({ probes: probesFor(tree), updateRoot: ROOT })

  const second = resolveRebuiltMacBundle({
    probes: probesFor({ [path.join(REL, 'mac-arm64')]: ['Alpha.app', 'Zeta.app'] }),
    updateRoot: ROOT
  })

  assert.equal(first, path.join(REL, 'mac-arm64', 'Alpha.app'))
  assert.equal(first, second, 'readdir order must not change the swap target')
})

test('searches mac-arm64 before mac and tolerates missing dirs', () => {
  const resolved = resolveRebuiltMacBundle({
    probes: probesFor({
      [path.join(REL, 'mac')]: ['Catalyst.app'],
      [path.join(REL, 'mac-arm64')]: []
    }),
    updateRoot: ROOT
  })

  assert.equal(resolved, path.join(REL, 'mac', 'Catalyst.app'))
})

test('returns null when the rebuild produced no bundle', () => {
  assert.equal(resolveRebuiltMacBundle({ probes: probesFor({}), updateRoot: ROOT }), null)
})

test('ignores non-bundle entries and non-directories', () => {
  const resolved = resolveRebuiltMacBundle({
    probes: {
      isDirectory: candidate => path.basename(candidate) !== 'Decoy.app',
      modifiedAtMs: () => 0,
      readDir: () => ['builder-effective-config.yaml', 'Decoy.app', 'Catalyst.app']
    },
    updateRoot: ROOT
  })

  assert.equal(resolved, path.join(REL, 'mac-arm64', 'Catalyst.app'))
})

test('a throwing readDir does not abort the search', () => {
  const resolved = resolveRebuiltMacBundle({
    probes: {
      isDirectory: () => true,
      modifiedAtMs: () => 0,
      readDir: dirPath => {
        if (dirPath.endsWith('mac-arm64')) {throw new Error('EACCES')}

        return dirPath.endsWith(`${path.sep}mac`) ? ['Catalyst.app'] : []
      }
    },
    updateRoot: ROOT
  })

  assert.equal(resolved, path.join(REL, 'mac', 'Catalyst.app'))
})
