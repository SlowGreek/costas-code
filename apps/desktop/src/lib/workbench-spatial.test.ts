import { describe, expect, it } from 'vitest'

import {
  buildWorkbenchContext,
  describeLocation,
  describeWorkbenchSpace,
  zoneFor
} from './workbench-spatial'

const W = 900
const H = 600

describe('zoneFor', () => {
  it('names the nine coarse buckets', () => {
    expect(zoneFor({ x: 50, y: 50 }, W, H)).toBe('upper left')
    expect(zoneFor({ x: 450, y: 50 }, W, H)).toBe('top edge')
    expect(zoneFor({ x: 850, y: 50 }, W, H)).toBe('upper right')
    expect(zoneFor({ x: 50, y: 300 }, W, H)).toBe('far left')
    expect(zoneFor({ x: 450, y: 300 }, W, H)).toBe('centre')
    expect(zoneFor({ x: 850, y: 300 }, W, H)).toBe('far right')
    expect(zoneFor({ x: 50, y: 560 }, W, H)).toBe('lower left')
    expect(zoneFor({ x: 450, y: 560 }, W, H)).toBe('bottom edge')
    expect(zoneFor({ x: 850, y: 560 }, W, H)).toBe('lower right')
  })

  it('varies with position rather than returning a constant', () => {
    const zones = new Set(
      [
        { x: 10, y: 10 },
        { x: 450, y: 300 },
        { x: 890, y: 590 }
      ].map(point => zoneFor(point, W, H))
    )

    expect(zones.size).toBe(3)
  })

  it('is scale-invariant: same fraction, different canvas, same zone', () => {
    expect(zoneFor({ x: 90, y: 60 }, 100, 100)).toBe(zoneFor({ x: 900, y: 600 }, 1_000, 1_000))
  })

  it('degrades instead of throwing on a zero-size canvas', () => {
    expect(zoneFor({ x: 0, y: 0 }, 0, 0)).toBe('upper left')
  })

  it('emits no raw pixel coordinates in its vocabulary', () => {
    expect(zoneFor({ x: 137, y: 421 }, W, H)).not.toMatch(/\d/)
  })
})

describe('describeWorkbenchSpace', () => {
  const nodes = [
    { id: 'planner', label: 'Planner' },
    { id: 'controller', label: 'Controller' },
    { id: 'sensor', label: 'Sensor' }
  ]

  const positions = {
    controller: { x: 450, y: 300 },
    planner: { x: 450, y: 120 },
    sensor: { x: 150, y: 300 }
  }

  it('gives each node a zone', () => {
    const out = describeWorkbenchSpace(nodes, positions, W, H)

    expect(out.controller.zone).toBe('centre')
    expect(out.planner.zone).toBe('top edge')
    expect(out.sensor.zone).toBe('far left')
  })

  it('describes relations from the subject point of view', () => {
    const out = describeWorkbenchSpace(nodes, positions, W, H)

    // Read as "<subject> is <relation> <other>".
    expect(out.sensor.near).toContain('left of: Controller')
    expect(out.controller.near).toContain('right of: Sensor')
    expect(out.controller.near).toContain('below: Planner')
    expect(out.planner.near).toContain('above: Controller')
  })

  it('omits nodes without a position rather than guessing', () => {
    const out = describeWorkbenchSpace([...nodes, { id: 'ghost', label: 'Ghost' }], positions, W, H)

    expect(out.ghost).toBeUndefined()
    expect(Object.keys(out)).toHaveLength(3)
  })

  it('never emits pixel coordinates', () => {
    const out = describeWorkbenchSpace(nodes, positions, W, H)

    expect(JSON.stringify(out)).not.toMatch(/450|300|120|150/)
  })

  it('suppresses relations that are too small to be meaningful', () => {
    const out = describeWorkbenchSpace(
      [
        { id: 'a', label: 'A' },
        { id: 'b', label: 'B' }
      ],
      { a: { x: 400, y: 300 }, b: { x: 405, y: 302 } },
      W,
      H
    )

    expect(out.a.near).toEqual([])
  })

  it('caps relation count', () => {
    const many = Array.from({ length: 8 }, (_, index) => ({
      id: `n${String(index)}`,
      label: `N${String(index)}`
    }))

    const pos = Object.fromEntries(
      many.map((node, index) => [node.id, { x: 100 + index * 60, y: 300 }])
    )

    const out = describeWorkbenchSpace(many, pos, W, H)

    for (const value of Object.values(out)) {
      expect(value.near.length).toBeLessThanOrEqual(2)
    }
  })
})

describe('describeLocation', () => {
  it('reads as speakable English', () => {
    expect(describeLocation({ near: ['left of: Controller'], zone: 'far left' })).toBe(
      'far left (left of: Controller)'
    )
    expect(describeLocation({ near: [], zone: 'centre' })).toBe('centre')
  })
})


describe('buildWorkbenchContext', () => {
  const base = {
    edges: [{ from: 'planner', label: 'drives', to: 'controller' }],
    kind: 'map',
    layout: {
      height: H,
      positions: { controller: { x: 450, y: 300 }, planner: { x: 120, y: 100 } },
      width: W
    },
    nodes: [
      { id: 'planner', kind: 'agent', label: 'Planner' },
      { id: 'controller', kind: 'system', label: 'Controller' }
    ],
    revision: 4
  }

  it('gives every node a coarse location and no pixels', () => {
    const parsed = JSON.parse(buildWorkbenchContext(base)) as {
      nodes: { location?: string }[]
    }

    expect(parsed.nodes.map(node => node.location)).toEqual(['upper left', 'centre'])
    expect(buildWorkbenchContext(base)).not.toMatch(/"x"|"y"|450|300/)
  })

  it('keeps edge ids so disconnect(edge_id) has a target', () => {
    // `disconnect` takes an edge_id, artifacts carry one, and the projection
    // used to strip it — so the tool existed and the model could never name a
    // target. Same orphan class as a renderer nobody dispatches to.
    const parsed = JSON.parse(
      buildWorkbenchContext({
        ...base,
        edges: [{ from: 'planner', id: 'planner-controller', label: 'drives', to: 'controller' }]
      })
    ) as { edges: { id?: string }[] }

    expect(parsed.edges[0].id).toBe('planner-controller')
  })

  it('tells the model what the user is pointing at', () => {
    const parsed = JSON.parse(buildWorkbenchContext({ ...base, selection: 'controller' })) as {
      pointing_at: null | string
      pointing_at_label: null | string
      pointing_at_location: null | string
    }

    expect(parsed.pointing_at).toBe('controller')
    expect(parsed.pointing_at_label).toBe('Controller')
    expect(parsed.pointing_at_location).toBe('centre')
  })

  it('sends an explicit null when the user is pointing at nothing', () => {
    const parsed = JSON.parse(buildWorkbenchContext(base)) as Record<string, unknown>

    expect('pointing_at' in parsed).toBe(true)
    expect(parsed.pointing_at).toBeNull()
  })

  it('refuses a selection that is not on the canvas', () => {
    const parsed = JSON.parse(buildWorkbenchContext({ ...base, selection: 'ghost' })) as {
      pointing_at: null | string
    }

    expect(parsed.pointing_at).toBeNull()
  })

  it('drops hidden nodes and their edges, and marks pins', () => {
    const parsed = JSON.parse(
      buildWorkbenchContext({ ...base, hidden: ['planner'], pinned: ['controller'] })
    ) as {
      edges: unknown[]
      hidden_from_view: string[]
      nodes: { id: string; pinned?: boolean }[]
    }

    expect(parsed.nodes).toHaveLength(1)
    expect(parsed.nodes[0].pinned).toBe(true)
    expect(parsed.edges).toHaveLength(0)
    expect(parsed.hidden_from_view).toEqual(['planner'])
  })

  it('still works with no layout yet (degrade, never hard-fail)', () => {
    const parsed = JSON.parse(buildWorkbenchContext({ ...base, layout: null })) as {
      nodes: { location?: string }[]
    }

    expect(parsed.nodes).toHaveLength(2)
    expect(parsed.nodes[0].location).toBeUndefined()
  })

  it('changes when the layout changes', () => {
    const moved = {
      ...base,
      layout: { ...base.layout, positions: { controller: { x: 20, y: 560 }, planner: { x: 120, y: 100 } } }
    }

    expect(buildWorkbenchContext(moved)).not.toBe(buildWorkbenchContext(base))
  })
})
