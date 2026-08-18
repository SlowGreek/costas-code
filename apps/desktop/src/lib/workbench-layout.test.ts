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
  it('deterministically seats new nodes and stays reproducible', () => {
    // `core` has a persisted position, `voice`/`canvas` do not — i.e. the graph
    // grew, so the layout is free to move. What must hold is determinism: the
    // same inputs produce the same output, so tests, reconnects, and a second
    // window all agree.
    const existing = { core: { x: 120, y: 80 } }

    const first = placeWorkbenchNodes(graph, existing, 800, 500)
    const second = placeWorkbenchNodes(graph, existing, 800, 500)

    expect(second).toEqual(first)
    expect(Number.isFinite(first.core.x)).toBe(true)
    expect(Number.isFinite(first.voice.x)).toBe(true)
    expect(Number.isFinite(first.canvas.y)).toBe(true)
    expect(first.voice).not.toEqual(first.canvas)
  })

  it('relayouts when the graph structure changes, even with every node pinned', () => {
    // Regression: the renderer persists a position for EVERY node, so on the
    // next revision every node is pinned and the layout can never respond to
    // new nodes or edges. The user asked the model to "make it prettier", the
    // model redrew (semantic_rev went up), and nothing moved on screen.
    const pinnedEverything = {
      core: { x: 100, y: 100 },
      voice: { x: 140, y: 110 },
      canvas: { x: 180, y: 120 }
    }

    const grown = {
      nodes: [...graph.nodes, { id: 'memory', label: 'Memory', kind: 'store' }],
      edges: [...graph.edges, { id: 'core-memory', from: 'core', to: 'memory' }]
    }

    const before = placeWorkbenchNodes(graph, pinnedEverything, 800, 500)
    const after = placeWorkbenchNodes(grown, pinnedEverything, 800, 500)

    expect(Number.isFinite(after.memory?.x)).toBe(true)

    // The existing crowd must be allowed to breathe to make room, rather than
    // staying frozen exactly where they were.
    const moved = ['core', 'voice', 'canvas'].some(
      id => before[id].x !== after[id].x || before[id].y !== after[id].y
    )

    expect(moved).toBe(true)
  })

  it('keeps a stable layout when the graph has not changed', () => {
    // The counterpart guarantee: a re-render with the SAME graph must not
    // shuffle anything, or the user loses "that box on the left".
    const pinned = {
      core: { x: 100, y: 100 },
      voice: { x: 140, y: 110 },
      canvas: { x: 180, y: 120 }
    }

    const first = placeWorkbenchNodes(graph, pinned, 800, 500)
    const second = placeWorkbenchNodes(graph, pinned, 800, 500)

    expect(second).toEqual(first)
    expect(first.core).toEqual({ x: 100, y: 100 })
  })
})
