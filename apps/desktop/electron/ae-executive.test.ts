import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { AE_EXECUTIVE_TABS, resolveAeExecutiveBinary, validateAeExecutiveBatch } from './ae-executive'

const created: string[] = []

const labels: Record<string, string> = {
  home: '[H]OME',
  dashboard: '[D]ASHBOARD',
  lucid: '[L]UCID',
  quine: '[Q]UINE',
  scores: 'S[C]ORES',
  metrics: '[M]ETRICS',
  logs: 'L[O]GS',
  studio: 'S[T]UDIO',
  settings: '[S]ETTINGS',
  marketplace: 'MA[R]KETPLACE',
  calc: 'C[A]LCULATOR',
  snake: 'S[N]AKE'
}

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

function semanticScene(tab: string, tabs: readonly string[] = AE_EXECUTIVE_TABS) {
  const tabNodes = tabs.map(id => ({
    id: `${tab}-tab-${id}`,
    p: 'button',
    a: { label: labels[id] ?? id.toUpperCase(), role: 'tab' },
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

function semanticBatch(tabs: readonly string[]) {
  return {
    schema: 'ae-executive-scene-batch/1',
    authority: 'none',
    projector: 'ugui::shell->ugui::project',
    scenes: tabs.map(tab => ({ tab, scene: semanticScene(tab, tabs) }))
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

it('admits a profile-specific Marketplace workspace without the legacy nine-tab seed', () => {
  const tabs = ['home', 'marketplace', 'calc', 'snake']
  const batch = validateAeExecutiveBatch(semanticBatch(tabs))

  expect(batch.scenes.map(row => row.tab)).toEqual(tabs)
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

  it('rejects unsafe, duplicate, and handler-mismatched dynamic tabs', () => {
    expect(() => validateAeExecutiveBatch(semanticBatch(['marketplace', '../escape']))).toThrow(
      'ae-executive-tab-id'
    )
    expect(() => validateAeExecutiveBatch(semanticBatch(['marketplace', 'calc', 'calc']))).toThrow(
      'ae-executive-tab-duplicate'
    )

    const hotkeyCollision = semanticBatch(['marketplace', 'calc'])

    for (const row of hotkeyCollision.scenes) {
      const calc = row.scene.nodes.find(node => node.id === `${row.tab}-tab-calc`)

      if (calc) {(calc as { a?: { label: string; role: string } }).a = { label: 'C[R]ALCULATOR', role: 'tab' }}
    }

    expect(() => validateAeExecutiveBatch(hotkeyCollision)).toThrow('ae-executive-hotkey-collision')

    const mismatched = semanticBatch(['marketplace', 'calc'])
    mismatched.scenes.at(-1)!.scene.nodes = mismatched.scenes
      .at(-1)!
      .scene.nodes.filter(node => node.id !== 'calc-tab-marketplace')
    expect(() => validateAeExecutiveBatch(mismatched)).toThrow('ae-executive-shell-actions')
  })

  it('admits stale provenance labels only when the closed semantic structure is valid', () => {
    const scenes = AE_EXECUTIVE_TABS.map(tab => ({ tab, scene: semanticScene(tab) }))
    expect(
      validateAeExecutiveBatch({
        schema: 'ae-executive-scene-batch/1',
        authority: 'none',
        projector: 'run::tui->ugui::project',
        scenes
      }).scenes
    ).toHaveLength(9)

    const missingShell = structuredClone(scenes)
    missingShell[0].scene.nodes = missingShell[0].scene.nodes.filter(node => !node.id.includes('-tab-'))
    expect(() =>
      validateAeExecutiveBatch({
        schema: 'ae-executive-scene-batch/1',
        authority: 'none',
        projector: 'informational-label',
        scenes: missingShell
      })
    ).toThrow('ae-executive-shell-actions')
  })
})
