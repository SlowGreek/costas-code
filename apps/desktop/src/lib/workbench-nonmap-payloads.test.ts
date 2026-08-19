import { describe, expect, it } from 'vitest'

import { visibleGraph } from './workbench-edits'
import { placeWorkbenchNodes } from './workbench-layout'

/**
 * A timeline / quadrant / sketch payload has NO `nodes` array.
 *
 * `pane.tsx` computes layout for EVERY artifact kind before it dispatches to a
 * renderer, so an unguarded `graph.nodes.filter(...)` took down the entire
 * workbench with "Cannot read properties of undefined (reading 'map')" — a
 * full error boundary, not a degraded canvas. Hit for real when the diagrammer
 * switched an artifact from map to timeline.
 */
describe('graph helpers tolerate non-map payloads', () => {
  const timeline = { items: [{ id: 'p1', label: 'Phase 1', order: 0 }] } as never

  it('visibleGraph survives a payload with no nodes and an active hide', () => {
    expect(() => visibleGraph(timeline, { hidden: ['p1'] } as never)).not.toThrow()
  })

  it('visibleGraph survives a payload with no nodes and no hides', () => {
    expect(() => visibleGraph(timeline, {} as never)).not.toThrow()
  })

  it('visibleGraph returns an empty graph rather than undefined arrays', () => {
    const out = visibleGraph(timeline, { hidden: ['p1'] } as never)

    expect(Array.isArray(out.nodes)).toBe(true)
    expect(Array.isArray(out.edges)).toBe(true)
  })

  it('placeWorkbenchNodes survives a payload with no nodes', () => {
    expect(() => placeWorkbenchNodes(timeline, {}, 800, 500)).not.toThrow()
  })
})
