import { beforeEach, describe, expect, it } from 'vitest'

import type { WorkbenchGraph } from '@/store/workbench'

import { assignRanks, countCrossings, orderLayers } from './workbench-layered-layout'
import {
  hashWorkbenchGraph,
  placeWorkbenchNodes,
  resetWorkbenchLayoutMemo
} from './workbench-layout'
import { nodeRect, rectsIntersect, rectWithin } from './workbench-node-box'

const WIDTH = 1280
const HEIGHT = 760

/** Realistic 11-node flow graph — the shape the diagrammer keeps producing. */
const flowGraph: WorkbenchGraph = {
  nodes: [
    { id: 'task', kind: 'task', label: 'Task' },
    { id: 'context', kind: 'concept', label: 'Context' },
    { id: 'controller', kind: 'system', label: 'Controller' },
    { id: 'planner', kind: 'agent', label: 'Planner' },
    { id: 'memory', kind: 'system', label: 'Memory' },
    { id: 'tools', kind: 'surface', label: 'Tool Interface' },
    { id: 'executor', kind: 'agent', label: 'Executor' },
    { id: 'evaluator', kind: 'agent', label: 'Evaluator' },
    { id: 'formatter', kind: 'system', label: 'Formatter' },
    { id: 'response', kind: 'goal', label: 'Response' },
    { id: 'log', kind: 'insight', label: 'Trace Log' }
  ],
  edges: [
    { from: 'task', id: 'e1', label: 'input', to: 'controller' },
    { from: 'context', id: 'e2', label: 'input', to: 'controller' },
    { from: 'controller', id: 'e3', label: 'plans', to: 'planner' },
    { from: 'planner', id: 'e4', label: 'calls', to: 'tools' },
    { from: 'controller', id: 'e5', label: 'reads', to: 'memory' },
    { from: 'tools', id: 'e6', label: 'runs', to: 'executor' },
    { from: 'executor', id: 'e7', label: 'scores', to: 'evaluator' },
    { from: 'evaluator', id: 'e8', label: 'formats', to: 'formatter' },
    { from: 'formatter', id: 'e9', label: 'emits', to: 'response' },
    { from: 'executor', id: 'e10', label: 'traces', to: 'log' },
    { from: 'memory', id: 'e11', label: 'informs', to: 'planner' }
  ]
}

const overlaps = (positions: Record<string, { x: number; y: number }>): string[] => {
  const ids = Object.keys(positions)
  const found: string[] = []

  for (let i = 0; i < ids.length; i += 1) {
    for (let j = i + 1; j < ids.length; j += 1) {
      const a = ids[i] as string
      const b = ids[j] as string

      if (rectsIntersect(nodeRect(positions[a]!), nodeRect(positions[b]!))) {
        found.push(`${a}~${b}`)
      }
    }
  }

  return found
}

const outside = (positions: Record<string, { x: number; y: number }>): string[] =>
  Object.entries(positions)
    .filter(([, point]) => !rectWithin(nodeRect(point), WIDTH, HEIGHT))
    .map(([id]) => id)

beforeEach(() => {
  resetWorkbenchLayoutMemo()
})

describe('rectangle helpers', () => {
  it('detects real overlap and ignores mere touching', () => {
    expect(
      rectsIntersect({ height: 10, width: 10, x: 0, y: 0 }, { height: 10, width: 10, x: 5, y: 5 })
    ).toBe(true)
    expect(
      rectsIntersect({ height: 10, width: 10, x: 0, y: 0 }, { height: 10, width: 10, x: 10, y: 0 })
    ).toBe(false)
    expect(
      rectsIntersect({ height: 10, width: 10, x: 0, y: 0 }, { height: 10, width: 10, x: 40, y: 40 })
    ).toBe(false)
  })

  it('detects boxes hanging off the canvas', () => {
    expect(rectWithin({ height: 10, width: 10, x: -1, y: 0 }, 100, 100)).toBe(false)
    expect(rectWithin({ height: 10, width: 10, x: 95, y: 0 }, 100, 100)).toBe(false)
    expect(rectWithin({ height: 10, width: 10, x: 10, y: 10 }, 100, 100)).toBe(true)
  })
})

describe('placeWorkbenchNodes — geometry', () => {
  it('lays out an 11-node flow graph with ZERO overlapping node boxes, all on canvas', () => {
    const positions = placeWorkbenchNodes(flowGraph, {}, WIDTH, HEIGHT)

    expect(Object.keys(positions)).toHaveLength(11)
    expect(overlaps(positions)).toEqual([])
    expect(outside(positions)).toEqual([])
  })

  it('keeps zero overlap on a DENSE cyclic graph (force path, 14 nodes)', () => {
    // Cyclic => layered layout returns null, so this exercises the force path
    // and its collision radius directly.
    const ids = Array.from({ length: 14 }, (_, index) => `n${index}`)
    const dense: WorkbenchGraph = {
      nodes: ids.map(id => ({ id, label: id.toUpperCase() })),
      edges: ids.map((id, index) => ({
        from: id,
        id: `d${index}`,
        to: ids[(index + 1) % ids.length] as string
      }))
    }

    expect(assignRanks(dense)).toBeNull()

    const positions = placeWorkbenchNodes(dense, {}, WIDTH, HEIGHT)

    expect(overlaps(positions)).toEqual([])
    expect(outside(positions)).toEqual([])
  })

  it('keeps zero overlap on a cyclic graph (force path) too', () => {
    const cyclic: WorkbenchGraph = {
      nodes: flowGraph.nodes,
      edges: [...flowGraph.edges, { from: 'response', id: 'cyc', to: 'controller' }]
    }

    expect(assignRanks(cyclic)).toBeNull()

    const positions = placeWorkbenchNodes(cyclic, {}, WIDTH, HEIGHT)

    expect(overlaps(positions)).toEqual([])
    expect(outside(positions)).toEqual([])
  })

  it('separates nodes that were persisted stacked on top of each other', () => {
    const stacked = Object.fromEntries(flowGraph.nodes.map(node => [node.id, { x: 400, y: 300 }]))
    const positions = placeWorkbenchNodes(flowGraph, stacked, WIDTH, HEIGHT)

    expect(overlaps(positions)).toEqual([])
    expect(outside(positions)).toEqual([])
  })

  it('stays overlap-free on a small canvas via the grid fallback', () => {
    const positions = placeWorkbenchNodes(flowGraph, {}, 620, 700)

    expect(overlaps(positions)).toEqual([])
    expect(outside(positions).length).toBe(0)
  })
})

describe('placeWorkbenchNodes — reflow detection', () => {
  it('does NOT move anything when the payload is byte-identical', () => {
    const first = placeWorkbenchNodes(flowGraph, {}, WIDTH, HEIGHT)
    const second = placeWorkbenchNodes(flowGraph, first, WIDTH, HEIGHT)

    expect(second).toEqual(first)
  })

  it('DOES move when the same node ids come back with a different edge set', () => {
    const settled = placeWorkbenchNodes(flowGraph, {}, WIDTH, HEIGHT)

    // Same 11 ids, reorganised relationships — exactly "make it prettier".
    const reorganised: WorkbenchGraph = {
      nodes: flowGraph.nodes,
      edges: [
        { from: 'task', id: 'r1', to: 'planner' },
        { from: 'context', id: 'r2', to: 'planner' },
        { from: 'planner', id: 'r3', to: 'controller' },
        { from: 'controller', id: 'r4', to: 'tools' },
        { from: 'tools', id: 'r5', to: 'executor' },
        { from: 'executor', id: 'r6', to: 'formatter' },
        { from: 'formatter', id: 'r7', to: 'response' },
        { from: 'memory', id: 'r8', to: 'controller' },
        { from: 'evaluator', id: 'r9', to: 'formatter' },
        { from: 'log', id: 'r10', to: 'evaluator' }
      ]
    }

    resetWorkbenchLayoutMemo()

    const after = placeWorkbenchNodes(reorganised, settled, WIDTH, HEIGHT)

    const moved = Object.keys(settled).filter(
      id => settled[id]!.x !== after[id]!.x || settled[id]!.y !== after[id]!.y
    )

    expect(moved.length).toBeGreaterThan(0)
    expect(overlaps(after)).toEqual([])
    expect(outside(after)).toEqual([])
  })

  it('hashes the FULL semantic payload — edges and labels included', () => {
    const base = hashWorkbenchGraph(flowGraph)

    expect(hashWorkbenchGraph({ ...flowGraph, edges: [...flowGraph.edges] })).toBe(base)
    expect(hashWorkbenchGraph({ ...flowGraph, edges: flowGraph.edges.slice(1) })).not.toBe(base)
    expect(
      hashWorkbenchGraph({
        nodes: flowGraph.nodes,
        edges: flowGraph.edges.map(edge =>
          edge.id === 'e1' ? { ...edge, to: 'planner' } : edge
        )
      })
    ).not.toBe(base)
    expect(
      hashWorkbenchGraph({
        edges: flowGraph.edges,
        nodes: flowGraph.nodes.map(node =>
          node.id === 'task' ? { ...node, label: 'Renamed' } : node
        )
      })
    ).not.toBe(base)
  })
})

describe('layered layout', () => {
  it('ranks the flow by longest path and puts sources first, sink last', () => {
    const ranks = assignRanks(flowGraph)

    expect(ranks).not.toBeNull()
    expect(ranks!.task).toBe(0)
    expect(ranks!.context).toBe(0)
    expect(ranks!.controller).toBe(1)
    expect(ranks!.response).toBe(Math.max(...Object.values(ranks!)))
  })

  it('returns null for cyclic graphs so the force layout takes over', () => {
    expect(
      assignRanks({
        nodes: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }],
        edges: [{ from: 'a', id: '1', to: 'b' }, { from: 'b', id: '2', to: 'a' }]
      })
    ).toBeNull()
  })

  it('reduces edge crossings relative to naive input order', () => {
    const crossy: WorkbenchGraph = {
      nodes: [
        { id: 'a1', label: 'A1' },
        { id: 'a2', label: 'A2' },
        { id: 'a3', label: 'A3' },
        { id: 'b1', label: 'B1' },
        { id: 'b2', label: 'B2' },
        { id: 'b3', label: 'B3' }
      ],
      edges: [
        { from: 'a1', id: 'x1', to: 'b3' },
        { from: 'a2', id: 'x2', to: 'b2' },
        { from: 'a3', id: 'x3', to: 'b1' }
      ]
    }

    const ranks = assignRanks(crossy)!

    const naive = [
      ['a1', 'a2', 'a3'],
      ['b1', 'b2', 'b3']
    ]

    const ordered = orderLayers(ranks, crossy)

    expect(countCrossings(naive, crossy.edges)).toBe(3)
    expect(countCrossings(ordered, crossy.edges)).toBe(0)
  })

  it('lays the flow out left-to-right when the canvas is wide enough', () => {
    const positions = placeWorkbenchNodes(flowGraph, {}, 1800, 760)

    expect(positions.task!.x).toBeLessThan(positions.controller!.x)
    expect(positions.controller!.x).toBeLessThan(positions.planner!.x)
    expect(positions.planner!.x).toBeLessThan(positions.response!.x)
    expect(overlaps(positions)).toEqual([])
  })

  it('flows top-to-bottom when the pipeline is too long to fit horizontally', () => {
    // 8 ranks x (152 + gutter) does not fit in 1280px, so the layered pass
    // rotates rather than degrading to a force blob.
    const positions = placeWorkbenchNodes(flowGraph, {}, WIDTH, HEIGHT)

    expect(positions.task!.y).toBeLessThan(positions.controller!.y)
    expect(positions.controller!.y).toBeLessThan(positions.response!.y)
    expect(overlaps(positions)).toEqual([])
    expect(outside(positions)).toEqual([])
  })
})
