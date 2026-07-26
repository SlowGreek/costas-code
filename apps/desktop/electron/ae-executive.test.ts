import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { AE_EXECUTIVE_TABS, resolveAeExecutiveBinary, validateAeExecutiveBatch } from './ae-executive'

const created: string[] = []

afterEach(() => {
  for (const item of created.splice(0)) {fs.rmSync(item, { force: true, recursive: true })}
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

function semanticScene(tab: (typeof AE_EXECUTIVE_TABS)[number]) {
  const tabNodes = AE_EXECUTIVE_TABS.map(id => ({
    id: `${tab}-tab-${id}`,
    p: 'button',
    on: { tap: `shell.tab.${id}` },
    layout: { height: 1 }
  }))

  return {
    sceneVersion: '1.0.0',
    id: `run-${tab}`,
    root: `${tab}-root`,
    nodes: [
      { id: `${tab}-root`, p: 'column', kids: [`${tab}-body`, ...tabNodes.map(node => node.id)] },
      { id: `${tab}-body`, p: 'column', kids: [], layout: { height: '*' } },
      ...tabNodes
    ]
  }
}

it('validates the closed ordered nine-scene semantic batch', () => {
  const scenes = AE_EXECUTIVE_TABS.map(tab => ({ tab, scene: semanticScene(tab) }))

  const batch = validateAeExecutiveBatch({
    schema: 'ae-executive-scene-batch/1',
    authority: 'none',
    projector: 'ugui::executive->ugui::project',
    scenes
  })

  expect(batch.scenes.map(row => row.tab)).toEqual(AE_EXECUTIVE_TABS)
})

describe('fail-closed batch validation', () => {
  it('rejects reordered and missing scenes', () => {
    const scenes = AE_EXECUTIVE_TABS.map(tab => ({ tab, scene: semanticScene(tab) }))

    expect(() =>
      validateAeExecutiveBatch({
        schema: 'ae-executive-scene-batch/1',
        authority: 'none',
        projector: 'ugui::executive->ugui::project',
        scenes: [...scenes].reverse()
      })
    ).toThrow('ae-executive-batch-order')
    expect(() =>
      validateAeExecutiveBatch({
        schema: 'ae-executive-scene-batch/1',
        authority: 'none',
        projector: 'ugui::executive->ugui::project',
        scenes: scenes.slice(1)
      })
    ).toThrow('ae-executive-batch-cardinality')
  })

  it('rejects terminal-first and structurally non-semantic batches', () => {
    const scenes = AE_EXECUTIVE_TABS.map(tab => ({ tab, scene: semanticScene(tab) }))
    expect(() =>
      validateAeExecutiveBatch({
        schema: 'ae-executive-scene-batch/1',
        authority: 'none',
        projector: 'run::tui->ugui::project',
        scenes
      })
    ).toThrow('ae-executive-batch-terminal-first')

    const missingShell = structuredClone(scenes)
    missingShell[0].scene.nodes = missingShell[0].scene.nodes.filter(node => !node.id.includes('-tab-'))
    expect(() =>
      validateAeExecutiveBatch({
        schema: 'ae-executive-scene-batch/1',
        authority: 'none',
        projector: 'ugui::executive->ugui::project',
        scenes: missingShell
      })
    ).toThrow('ae-executive-shell-actions')
  })
})
