import { describe, expect, it } from 'vitest'

import type { WorkbenchGraph } from '@/store/workbench'

import {
  applySurgicalEdit,
  applyUserPins,
  isUserPinned,
  pruneViewStateToGraph,
  readHidden,
  readUserPins,
  SurgicalEditError,
  visibleGraph,
  withHidden,
  withoutUserPin,
  withUserPin
} from './workbench-edits'

const graph = (): WorkbenchGraph => ({
  edges: [
    { from: 'a', id: 'e1', label: 'feeds', to: 'b' },
    { from: 'b', id: 'e2', to: 'c' }
  ],
  nodes: [
    { id: 'a', kind: 'system', label: 'Alpha' },
    { id: 'b', label: 'Beta' },
    { id: 'c', label: 'Gamma' }
  ]
})

describe('user pins vs auto-positions', () => {
  it('never infers a user pin from a persisted auto-position', () => {
    // The exact shape the position-persist path writes: every node has a
    // position, and legacy `pinned` lists every id. None of that is user
    // intent.
    const viewState = {
      pinned: ['a', 'b', 'c'],
      positions: { a: { x: 1, y: 1 }, b: { x: 2, y: 2 }, c: { x: 3, y: 3 } }
    }

    expect(readUserPins(viewState)).toEqual({})
    expect(isUserPinned(viewState, 'a')).toBe(false)
    expect(applyUserPins({ a: { x: 900, y: 900 } }, viewState)).toEqual({
      a: { x: 900, y: 900 }
    })
  })

  it('THE INVARIANT: a user pin survives a payload change that moves everything else', () => {
    // 1. User drags `b`.
    const pinned = withUserPin({ pinned: ['a', 'b'], positions: { a: { x: 1, y: 1 }, b: { x: 2, y: 2 } } }, 'b', {
      x: 500,
      y: 320
    })

    // 2. The payload changes and the layout engine relays out FROM SCRATCH,
    //    putting every node somewhere new.
    const relaidOut = { a: { x: 40, y: 40 }, b: { x: 41, y: 41 }, c: { x: 42, y: 42 } }

    const painted = applyUserPins(relaidOut, pinned)

    // The pinned node stayed exactly where the user put it...
    expect(painted.b).toEqual({ x: 500, y: 320 })
    // ...and every other node was free to move.
    expect(painted.a).toEqual({ x: 40, y: 40 })
    expect(painted.c).toEqual({ x: 42, y: 42 })
  })

  it('unpinning returns the node to layout control', () => {
    const state = withUserPin({}, 'b', { x: 500, y: 320 })

    expect(applyUserPins({ b: { x: 10, y: 10 } }, withoutUserPin(state, 'b'))).toEqual({
      b: { x: 10, y: 10 }
    })
  })

  it('ignores pins for nodes that no longer exist', () => {
    const state = withUserPin({}, 'ghost', { x: 5, y: 5 })

    expect(applyUserPins({ a: { x: 1, y: 1 } }, state)).toEqual({ a: { x: 1, y: 1 } })
    expect(readUserPins(pruneViewStateToGraph(state, graph()))).toEqual({})
  })

  it('stores pins under a key distinct from positions', () => {
    const state = withUserPin({ positions: { b: { x: 1, y: 1 } } }, 'b', { x: 9, y: 9 })

    expect(state.positions).toEqual({ b: { x: 1, y: 1 } })
    expect(state.user_pins).toEqual({ b: { x: 9, y: 9 } })
  })

  it('rejects non-finite pin coordinates', () => {
    expect(readUserPins({ user_pins: { a: { x: Number.NaN, y: 1 } } })).toEqual({})
  })
})

describe('hide/show', () => {
  it('hides a node and every edge touching it, without touching the payload', () => {
    const state = withHidden({}, 'b', true)
    const visible = visibleGraph(graph(), state)

    expect(visible.nodes.map(n => n.id)).toEqual(['a', 'c'])
    expect(visible.edges).toEqual([])
    // The source graph is untouched: hiding is a view concern.
    expect(graph().nodes).toHaveLength(3)
    expect(readHidden(state)).toEqual(['b'])
  })

  it('showing again restores the node', () => {
    const state = withHidden(withHidden({}, 'b', true), 'b', false)

    expect(visibleGraph(graph(), state).nodes).toHaveLength(3)
  })
})

describe('surgical edits (client mirror)', () => {
  it('rename changes the label and keeps the id and edges', () => {
    const next = applySurgicalEdit(graph(), { label: 'Planner', node_id: 'a', op: 'rename' })

    expect(next.nodes.find(n => n.id === 'a')).toEqual({ id: 'a', kind: 'system', label: 'Planner' })
    expect(next.edges).toHaveLength(2)
  })

  it('remove drops the node and any dangling edge', () => {
    const next = applySurgicalEdit(graph(), { node_id: 'b', op: 'remove' })

    expect(next.nodes.map(n => n.id)).toEqual(['a', 'c'])
    expect(next.edges).toEqual([])
  })

  it('connect adds one edge with a unique id', () => {
    const next = applySurgicalEdit(graph(), { from_id: 'a', label: 'blocks', op: 'connect', to_id: 'c' })

    expect(next.edges).toHaveLength(3)
    expect(next.edges[2]).toEqual({ from: 'a', id: 'e-a-c', label: 'blocks', to: 'c' })
  })

  it('disconnect removes exactly one edge', () => {
    expect(applySurgicalEdit(graph(), { edge_id: 'e1', op: 'disconnect' }).edges.map(e => e.id)).toEqual(['e2'])
  })

  it('rejects edits that reference unknown elements', () => {
    expect(() => applySurgicalEdit(graph(), { node_id: 'zz', op: 'remove' })).toThrow(SurgicalEditError)
    expect(() => applySurgicalEdit(graph(), { edge_id: 'zz', op: 'disconnect' })).toThrow(SurgicalEditError)
    expect(() => applySurgicalEdit(graph(), { from_id: 'a', op: 'connect', to_id: 'a' })).toThrow(
      SurgicalEditError
    )
    expect(() => applySurgicalEdit(graph(), { label: '   ', node_id: 'a', op: 'rename' })).toThrow(
      SurgicalEditError
    )
  })

  it('never writes geometry into the semantic payload', () => {
    const next = applySurgicalEdit(graph(), { from_id: 'a', op: 'connect', to_id: 'c' })

    for (const item of [...next.nodes, ...next.edges] as unknown as Record<string, unknown>[]) {
      expect(Object.keys(item).some(key => ['height', 'position', 'width', 'x', 'y'].includes(key))).toBe(
        false
      )
    }
  })
})
