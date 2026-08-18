import { describe, expect, it } from 'vitest'

import { placeWorkbenchNodes } from './workbench-layout'

const graph = {
  nodes: [
    { id: 'core', label: 'Shared state', kind: 'component' },
    { id: 'voice', label: 'Voice', kind: 'agent' },
    { id: 'canvas', label: 'Canvas', kind: 'surface' }
  ],
  edges: [
    { id: 'voice-core', from: 'voice', to: 'core', label: 'reads' },
    { id: 'core-canvas', from: 'core', to: 'canvas', label: 'renders' }
  ]
}

describe('placeWorkbenchNodes', () => {
  it('pins existing nodes and deterministically seats only new nodes', () => {
    const existing = { core: { x: 120, y: 80 } }

    const first = placeWorkbenchNodes(graph, existing, 800, 500)
    const second = placeWorkbenchNodes(graph, existing, 800, 500)

    expect(first.core).toEqual({ x: 120, y: 80 })
    expect(second).toEqual(first)
    expect(Number.isFinite(first.voice.x)).toBe(true)
    expect(Number.isFinite(first.canvas.y)).toBe(true)
    expect(first.voice).not.toEqual(first.canvas)
  })
})
