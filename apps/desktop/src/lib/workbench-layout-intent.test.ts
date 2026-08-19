import { describe, expect, it } from 'vitest'

import { placeWorkbenchNodes, resetWorkbenchLayoutMemo } from './workbench-layout'

/**
 * A map's `layout` must visibly change the arrangement.
 *
 * Reported: "I asked to have it redrawn linearly, she said she did it, but it
 * didn't change — it just recentered itself." The diagrammer had no vocabulary
 * for arrangement, so it returned the same graph; but even once it can SAY
 * "linear", the renderer has to honour it, or the field is stored and ignored
 * and the user sees exactly the same non-change.
 */
const chain = (layout?: string) => ({
  ...(layout ? { layout } : {}),
  edges: [
    { id: 'a-b', from: 'a', to: 'b' },
    { id: 'b-c', from: 'b', to: 'c' },
    { id: 'c-d', from: 'c', to: 'd' }
  ],
  nodes: [
    { id: 'a', label: 'Input' },
    { id: 'b', label: 'Agent' },
    { id: 'c', label: 'Action' },
    { id: 'd', label: 'Result' }
  ]
})

const spread = (positions: Record<string, { x: number; y: number }>, axis: 'x' | 'y') => {
  const values = Object.values(positions).map(point => point[axis])

  return Math.max(...values) - Math.min(...values)
}

describe('layout intent', () => {
  it('lays a linear map out along one axis', () => {
    resetWorkbenchLayoutMemo()

    const positions = placeWorkbenchNodes(chain('linear') as never, {}, 900, 600)

    // A chain drawn linearly should travel much further across than down.
    expect(spread(positions, 'x')).toBeGreaterThan(spread(positions, 'y') * 3)
  })

  it('keeps a linear map in reading order', () => {
    resetWorkbenchLayoutMemo()

    const positions = placeWorkbenchNodes(chain('linear') as never, {}, 900, 600)

    expect(positions.a.x).toBeLessThan(positions.b.x)
    expect(positions.b.x).toBeLessThan(positions.c.x)
    expect(positions.c.x).toBeLessThan(positions.d.x)
  })

  it('produces a DIFFERENT arrangement from the default', () => {
    // The whole complaint: same nodes, same edges, and the picture does not
    // change. Declaring a layout has to actually move things.
    resetWorkbenchLayoutMemo()
    const withoutLayout = placeWorkbenchNodes(chain() as never, {}, 900, 600)

    resetWorkbenchLayoutMemo()
    const linear = placeWorkbenchNodes(chain('linear') as never, {}, 900, 600)

    expect(linear).not.toEqual(withoutLayout)
  })

  it('changing only the layout re-lays the graph out', () => {
    // Node ids and edges are identical between these two calls; only the
    // arrangement differs. If the memo keys on graph content alone, the second
    // call returns the first result and the user sees nothing happen.
    resetWorkbenchLayoutMemo()
    const linear = placeWorkbenchNodes(chain('linear') as never, {}, 900, 600)
    const radial = placeWorkbenchNodes(chain('radial') as never, linear, 900, 600)

    expect(radial).not.toEqual(linear)
  })

  it('still lays out a map that declares no layout', () => {
    resetWorkbenchLayoutMemo()

    const positions = placeWorkbenchNodes(chain() as never, {}, 900, 600)

    expect(Object.keys(positions)).toHaveLength(4)

    for (const point of Object.values(positions)) {
      expect(Number.isFinite(point.x)).toBe(true)
      expect(Number.isFinite(point.y)).toBe(true)
    }
  })

  it('keeps every node on the canvas whatever the layout', () => {
    for (const layout of ['linear', 'layered', 'radial', 'cluster']) {
      resetWorkbenchLayoutMemo()

      const positions = placeWorkbenchNodes(chain(layout) as never, {}, 720, 420)

      for (const [id, point] of Object.entries(positions)) {
        expect(point.x, `${layout}/${id} x`).toBeGreaterThan(0)
        expect(point.x, `${layout}/${id} x`).toBeLessThan(720)
        expect(point.y, `${layout}/${id} y`).toBeGreaterThan(0)
        expect(point.y, `${layout}/${id} y`).toBeLessThan(420)
      }
    }
  })
})
