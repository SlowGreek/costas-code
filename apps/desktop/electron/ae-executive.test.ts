import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { AE_EXECUTIVE_TABS, resolveAeExecutiveBinary, validateAeExecutiveBatch } from './ae-executive'

const created: string[] = []

afterEach(() => {
  for (const item of created.splice(0)) fs.rmSync(item, { force: true, recursive: true })
})

function executable(name = 'ae-executive-scene') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ae-executive-test-'))
  created.push(root)
  const file = path.join(root, name)
  fs.writeFileSync(file, '')
  return file
}

it('resolves only an existing exact override', () => {
  const file = executable()
  expect(resolveAeExecutiveBinary({ isPackaged: false, sourceRepoRoot: '/missing', override: file })).toBe(file)
  expect(resolveAeExecutiveBinary({ isPackaged: false, sourceRepoRoot: '/missing', override: `${file}.missing` })).toBeNull()
})

it('validates the closed ordered nine-scene batch', () => {
  const scenes = AE_EXECUTIVE_TABS.map(tab => ({
    tab,
    scene: { sceneVersion: '1.0.0', root: `${tab}-root`, nodes: [{ id: `${tab}-root`, p: 'column', kids: [] }] }
  }))
  const batch = validateAeExecutiveBatch({
    schema: 'ae-executive-scene-batch/1',
    authority: 'none',
    projector: 'test',
    scenes
  })
  expect(batch.scenes.map(row => row.tab)).toEqual(AE_EXECUTIVE_TABS)
})

describe('fail-closed batch validation', () => {
  it('rejects reordered and missing scenes', () => {
    const scenes = AE_EXECUTIVE_TABS.map(tab => ({
      tab,
      scene: { sceneVersion: '1.0.0', root: tab, nodes: [{ id: tab, p: 'column' }] }
    }))
    expect(() =>
      validateAeExecutiveBatch({
        schema: 'ae-executive-scene-batch/1',
        authority: 'none',
        projector: 'test',
        scenes: [...scenes].reverse()
      })
    ).toThrow('ae-executive-batch-order')
    expect(() =>
      validateAeExecutiveBatch({
        schema: 'ae-executive-scene-batch/1',
        authority: 'none',
        projector: 'test',
        scenes: scenes.slice(1)
      })
    ).toThrow('ae-executive-batch-cardinality')
  })
})
