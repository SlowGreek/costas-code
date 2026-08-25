import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { createElement } from 'react'
import { afterEach, describe, expect, it } from 'vitest'

import { IDENTITY_CAMERA } from '@/lib/workbench-camera'
import {
  $workbenchSelection,
  animateWorkbenchCameraTo,
  resetWorkbenchForTests,
  setWorkbenchSelection,
  type WorkbenchArtifact,
  type WorkbenchEdge
} from '@/store/workbench'

import MapRenderer, {
  accentForKind,
  borderPoint,
  bowFactors,
  clientToCanvas,
  fitLabel,
  nodeRingState,
  routeEdge
} from './map-renderer'

afterEach(() => {
  cleanup()
  resetWorkbenchForTests()
})

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

describe('clientToCanvas', () => {
  const rect = { height: 420, left: 0, top: 0, width: 720 }
  const world = { height: 420, width: 720 }

  it('is unchanged by the camera at identity', () => {
    expect(clientToCanvas({ x: 360, y: 210 }, rect, world, IDENTITY_CAMERA)).toEqual({
      x: 360,
      y: 210
    })
  })

  it('defaults to identity when no camera is supplied', () => {
    expect(clientToCanvas({ x: 100, y: 50 }, rect, world)).toEqual({ x: 100, y: 50 })
  })

  it('maps into world units when zoomed in', () => {
    expect(clientToCanvas({ x: 360, y: 210 }, rect, world, { x: 0, y: 0, zoom: 2 })).toEqual({
      x: 180,
      y: 105
    })
  })

  it('offsets by the camera origin when panned', () => {
    expect(clientToCanvas({ x: 0, y: 0 }, rect, world, { x: 100, y: 50, zoom: 1 })).toEqual({
      x: 100,
      y: 50
    })
  })

  it('handles pan and zoom together', () => {
    const got = clientToCanvas({ x: 360, y: 210 }, rect, world, { x: 100, y: 50, zoom: 2 })

    expect(got.x).toBeCloseTo(280, 5)
    expect(got.y).toBeCloseTo(155, 5)
  })

  it('still accounts for letterboxing when the element aspect differs', () => {
    const tall = { height: 840, left: 0, top: 0, width: 720 }

    expect(clientToCanvas({ x: 0, y: 210 }, tall, world, IDENTITY_CAMERA)).toEqual({ x: 0, y: 0 })
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

describe('cinematic camera rendering', () => {
  const artifact: WorkbenchArtifact = {
    artifact_id: 'artifact-camera',
    kind: 'map',
    payload: { edges: [], nodes: [{ id: 'planner', label: 'Planner' }] },
    semantic_rev: 1,
    view_rev: 1,
    view_state: {}
  }

  it('renders intermediate and final camera frames through the actual SVG viewBox', () => {
    const frames: Array<(time: number) => void> = []

    render(
      createElement(MapRenderer, {
        artifact,
        height: 420,
        positions: { planner: { x: 360, y: 210 } },
        width: 720
      })
    )

    const canvas = screen.getByTestId('workbench-canvas')

    expect(canvas.getAttribute('viewBox')).toBe('0 0 720 420')

    act(() => {
      animateWorkbenchCameraTo(
        { x: 100, y: 40, zoom: 2 },
        {
          durationMs: 600,
          now: () => 0,
          requestFrame: frame => {
            frames.push(frame)

            return frames.length
          }
        }
      )
      frames.shift()?.(300)
    })

    expect(canvas.getAttribute('viewBox')).toBe('50 20 480 280')

    act(() => frames.shift()?.(600))
    expect(canvas.getAttribute('viewBox')).toBe('100 40 360 210')
  })

  it('does not clear selection when the click follows a canvas pan', () => {
    setWorkbenchSelection('planner')
    render(
      createElement(MapRenderer, {
        artifact,
        height: 420,
        positions: { planner: { x: 360, y: 210 } },
        width: 720
      })
    )
    const canvas = screen.getByTestId('workbench-canvas')

    fireEvent.pointerDown(canvas, { button: 0, clientX: 100, clientY: 100 })
    fireEvent.pointerMove(canvas, { clientX: 140, clientY: 100 })
    fireEvent.pointerUp(canvas, { clientX: 140, clientY: 100 })
    fireEvent.click(canvas)

    expect($workbenchSelection.get()).toBe('planner')
  })
})
