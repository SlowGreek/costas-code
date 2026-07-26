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
  snake: 'S[N]AKE',
  shell: 'SH[E]LL'
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

it('admits key and tap aliases on one semantic tab button', () => {
  const batch = semanticBatch([...AE_EXECUTIVE_TABS, 'marketplace'])
  const quine = batch.scenes.find(row => row.tab === 'quine')!

  for (const node of quine.scene.nodes) {
    const on = (node as { on?: Record<string, string> }).on

    if (on?.tap?.startsWith('shell.tab.')) {on.key = on.tap}
  }

  expect(validateAeExecutiveBatch(batch).scenes).toHaveLength(10)

  const invalid = structuredClone(batch)

  const button = invalid.scenes.find(row => row.tab === 'quine')!.scene.nodes.find(
    node => (node as { on?: Record<string, string> }).on?.key
  ) as { on: Record<string, string> }

  button.on.key = 'shell.tab.dashboard'
  expect(() => validateAeExecutiveBatch(invalid)).toThrow('ae-executive-shell-action-gesture')
})

it('admits a registered host-derived SHELL action without requiring a duplicate batch Scene', () => {
  const batch = semanticBatch([...AE_EXECUTIVE_TABS, 'marketplace'])

  for (const row of batch.scenes) {
    const id = `${row.tab}-tab-shell`
    row.scene.nodes.push({
      id,
      p: 'button',
      a: { label: labels.shell, role: 'tab' },
      on: { tap: 'shell.tab.shell' },
      layout: { height: 1 }
    })
    ;(row.scene.nodes[0] as { kids: string[] }).kids.push(id)
  }

  expect(validateAeExecutiveBatch(batch).scenes).toHaveLength(10)
})

it('admits a nested content-sized Dashboard with no remaining-height node', () => {
  const batch = semanticBatch(AE_EXECUTIVE_TABS)
  const dashboard = batch.scenes.find(row => row.tab === 'dashboard')!.scene

  const body = dashboard.nodes.find(node => node.id === 'dashboard-body') as {
    kids?: string[]
    layout?: { height: '*' | number }
  }

  body.layout = { height: 4 }
  body.kids = ['dashboard-nested-parent']
  ;(dashboard.nodes as Array<Record<string, unknown>>).push(
    { id: 'dashboard-nested-parent', p: 'column', kids: ['dashboard-nested-child'] },
    { id: 'dashboard-nested-child', p: 'text', a: { text: 'Nested intrinsic evidence' } }
  )

  expect(validateAeExecutiveBatch(batch).scenes.find(row => row.tab === 'dashboard')?.scene).toBe(dashboard)
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
    expect(() => validateAeExecutiveBatch(mismatched)).toThrow('ae-executive-child-missing')
  })

  it('rejects malformed Scene graphs and layout values without requiring elastic layout', () => {
    const malformed = semanticBatch(['home', 'marketplace'])

    const mutate = (change: (scene: Record<string, any>) => void) => {
      const candidate = structuredClone(malformed)
      change(candidate.scenes[0].scene)

      return () => validateAeExecutiveBatch(candidate)
    }

    expect(mutate(scene => {scene.nodes[0].kids = ['missing']})).toThrow('ae-executive-child-missing')
    expect(mutate(scene => {scene.nodes[1].p = 'iframe'})).toThrow('ae-executive-primitive')
    expect(mutate(scene => {scene.nodes[2].kids = [scene.nodes[0].id]})).toThrow('ae-executive-leaf-children')
    expect(mutate(scene => {scene.nodes[1].layout = { height: 0 }})).toThrow('ae-executive-layout-height')
    expect(
      mutate(scene => {
        scene.nodes[1].kids = [scene.nodes[0].id]
        scene.nodes[1].p = 'column'
      })
    ).toThrow('ae-executive-scene-cycle')
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
    ).toThrow('ae-executive-child-missing')
  })
})
