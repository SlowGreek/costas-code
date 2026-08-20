import { describe, expect, it } from 'vitest'

import type { WorkbenchEdge } from '@/store/workbench'

import {
  accentForKind,
  borderPoint,
  bowFactors,
  fitLabel,
  nodeRingState,
  routeEdge
} from './map-renderer'

describe('nodeRingState', () => {
  it('keeps assistant focus independent of click selection', () => {
    expect(
      nodeRingState('gateway', {
        durable: 'gateway',
        selected: 'gateway'
      })
    ).toEqual({ durable: true, selected: true })

    expect(
      nodeRingState('worker', {
        durable: 'gateway',
        selected: 'gateway'
      })
    ).toEqual({ durable: false, selected: false })
  })
})

describe('accentForKind', () => {
  it('maps known kinds to distinct --ui-* variables', () => {
    expect(accentForKind('risk')).toBe('var(--ui-red)')
    expect(accentForKind('AGENT')).toBe('var(--ui-purple)')
    expect(accentForKind('risk')).not.toBe(accentForKind('goal'))
  })

  it('falls back to the accent token and never emits a hex colour', () => {
    for (const kind of [undefined, '', 'not-a-kind', 'idea']) {
      expect(accentForKind(kind)).toMatch(/^var\(--ui-[a-z-]+\)$/)
    }
  })
})

describe('fitLabel', () => {
  it('keeps short labels on a single line', () => {
    expect(fitLabel('Voice agent', 130, 12)).toEqual(['Voice agent'])
  })

  it('wraps long labels within the line budget', () => {
    const lines = fitLabel('Realtime diagrammer emits semantic node graph', 130, 12, 2)

    expect(lines.length).toBeLessThanOrEqual(2)
    expect(lines.at(-1)).toMatch(/…$/)
  })

  it('truncates a single unbreakable token', () => {
    const [line] = fitLabel('supercalifragilisticexpialidocious', 60, 12, 1)

    expect(line?.endsWith('…')).toBe(true)
  })

  it('never returns an empty array', () => {
    expect(fitLabel('', 130, 12)).toEqual([''])
  })
})

describe('borderPoint', () => {
  it('leaves the node box rather than starting at its centre', () => {
    const point = borderPoint({ x: 0, y: 0 }, { x: 400, y: 0 })

    expect(point.x).toBeGreaterThan(70)
    expect(point.y).toBeCloseTo(0)
  })

  it('is degenerate-safe for coincident points', () => {
    const point = borderPoint({ x: 10, y: 10 }, { x: 10, y: 10 })

    expect(Number.isFinite(point.x)).toBe(true)
    expect(Number.isFinite(point.y)).toBe(true)
  })
})

describe('routeEdge', () => {
  it('emits a quadratic curve, not a straight line', () => {
    const route = routeEdge({ x: 0, y: 0 }, { x: 400, y: 0 }, 0.45)

    expect(route.d).toMatch(/^M [\d.-]+ [\d.-]+ Q [\d.-]+ [\d.-]+ [\d.-]+ [\d.-]+$/)
    expect(Math.abs(route.labelPoint.y)).toBeGreaterThan(1)
  })

  it('is deterministic for the same input', () => {
    const a = routeEdge({ x: 12, y: 30 }, { x: 300, y: 210 }, 0.45)
    const b = routeEdge({ x: 12, y: 30 }, { x: 300, y: 210 }, 0.45)

    expect(a.d).toBe(b.d)
  })
})

describe('bowFactors', () => {
  const edge = (id: string, from: string, to: string): WorkbenchEdge => ({ from, id, to })

  it('fans parallel edges to opposite sides', () => {
    const bows = bowFactors([edge('a', 'x', 'y'), edge('b', 'x', 'y'), edge('c', 'y', 'x')])

    expect(bows.a).toBeGreaterThan(0)
    expect(bows.b).toBeLessThan(0)
    expect(Math.abs(bows.c)).toBeGreaterThan(Math.abs(bows.a))
  })

  it('bows unrelated edges identically and never to zero', () => {
    const bows = bowFactors([edge('a', 'x', 'y'), edge('b', 'p', 'q')])

    expect(bows.a).toBe(bows.b)
    expect(bows.a).not.toBe(0)
  })
})
