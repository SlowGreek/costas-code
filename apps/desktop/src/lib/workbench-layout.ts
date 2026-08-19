import { forceCenter, forceCollide, forceLink, forceManyBody, forceSimulation } from 'd3-force'

import type { WorkbenchGraph } from '@/store/workbench'

import { layeredLayout } from './workbench-layered-layout'
import {
  CLAMP_INSET_X,
  CLAMP_INSET_Y,
  clampCentre,
  HARD_SEPARATION_X,
  HARD_SEPARATION_Y,
  MIN_SEPARATION_X,
  MIN_SEPARATION_Y,
  NODE_HALF_DIAGONAL,
  NODE_HEIGHT,
  NODE_WIDTH,
  nodeRect,
  type Point,
  rectsIntersect,
  rectWithin
} from './workbench-node-box'

interface LayoutNode {
  id: string
  x: number
  y: number
}

interface LayoutLink {
  source: LayoutNode | string
  target: LayoutNode | string
}

const seededRandom = (text: string): (() => number) => {
  let seed = 2166136261

  for (let index = 0; index < text.length; index += 1) {
    seed ^= text.charCodeAt(index)
    seed = Math.imul(seed, 16777619)
  }

  return () => {
    seed += 0x6d2b79f5
    let value = seed

    value = Math.imul(value ^ (value >>> 15), value | 1)
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61)

    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296
  }
}

/**
 * Hash of the SEMANTIC payload: node ids, labels, kinds, and the FULL edge
 * list (id, endpoints, label).
 *
 * The old `structureChanged` check only looked at node identity and count, so
 * when the model reorganised the same nodes — precisely what "make it
 * prettier" produces — every node stayed pinned via fx/fy and the layout
 * physically could not move. `semantic_rev` incremented and the screen did
 * not: "it says it updated but it didn't change".
 */
export function hashWorkbenchGraph(graph: WorkbenchGraph): string {
  // Non-map payloads (timeline / quadrant / sketch) carry no nodes or edges,
  // and `pane.tsx` runs layout for every kind before dispatching to a
  // renderer — an unguarded read here crashed the whole workbench.
  const nodes = (graph?.nodes ?? [])
    .map(node => `${node.id}\u0001${node.label}\u0001${node.kind ?? ''}`)
    .sort()
    .join('\u0002')

  const edges = (graph?.edges ?? [])
    .map(edge => `${edge.id}\u0001${edge.from}\u0001${edge.to}\u0001${edge.label ?? ''}`)
    .sort()
    .join('\u0002')

  const text = `${nodes}\u0003${edges}`

  // FNV-1a, doubled with a second offset basis to cut accidental collisions.
  let a = 2166136261
  let b = 0x811c9dc5 ^ 0x5bf03635

  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index)

    a = Math.imul(a ^ code, 16777619)
    b = Math.imul(b ^ (code + index), 16777619)
  }

  return `${(a >>> 0).toString(36)}-${(b >>> 0).toString(36)}-${text.length.toString(36)}`
}

/**
 * Push overlapping boxes apart along their axis of least penetration until no
 * two rectangles intersect. Deterministic (fixed iteration order), and always
 * followed by a clamp so nothing is pushed off canvas.
 */
export function separateRects(
  points: Record<string, Point>,
  width: number,
  height: number,
  iterations = 200
): Record<string, Point> {
  const ids = Object.keys(points).sort()

  const current: Record<string, Point> = Object.fromEntries(
    ids.map(id => [id, { ...(points[id] as Point) }])
  )

  for (let pass = 0; pass < iterations; pass += 1) {
    let moved = false

    for (let i = 0; i < ids.length; i += 1) {
      for (let j = i + 1; j < ids.length; j += 1) {
        const a = current[ids[i] as string] as Point
        const b = current[ids[j] as string] as Point
        const dx = b.x - a.x
        const dy = b.y - a.y
        const overlapX = HARD_SEPARATION_X - Math.abs(dx)
        const overlapY = HARD_SEPARATION_Y - Math.abs(dy)

        if (overlapX <= 0 || overlapY <= 0) {
          continue
        }

        moved = true

        // Resolve along the cheaper axis.
        if (overlapX / HARD_SEPARATION_X < overlapY / HARD_SEPARATION_Y) {
          const shift = (overlapX / 2 + 0.5) * (dx === 0 ? (i % 2 === 0 ? 1 : -1) : Math.sign(dx))

          a.x -= shift
          b.x += shift
        } else {
          const shift = (overlapY / 2 + 0.5) * (dy === 0 ? (i % 2 === 0 ? 1 : -1) : Math.sign(dy))

          a.y -= shift
          b.y += shift
        }

        Object.assign(a, clampCentre(a, width, height))
        Object.assign(b, clampCentre(b, width, height))
      }
    }

    if (!moved) {
      return current
    }
  }

  return current
}

/** Deterministic grid packing — the guaranteed-correct last resort. */
export function gridLayout(ids: string[], width: number, height: number): Record<string, Point> {
  const usableWidth = Math.max(0, width - CLAMP_INSET_X * 2)
  const columns = Math.max(1, Math.floor(usableWidth / MIN_SEPARATION_X) + 1)
  const rows = Math.max(1, Math.ceil(ids.length / columns))

  const stepY = Math.min(
    MIN_SEPARATION_Y,
    rows > 1 ? (height - CLAMP_INSET_Y * 2) / (rows - 1) : MIN_SEPARATION_Y
  )

  const spanY = (rows - 1) * stepY
  const top = Math.max(CLAMP_INSET_Y, height / 2 - spanY / 2)
  const out: Record<string, Point> = {}

  ids.forEach((id, index) => {
    const row = Math.floor(index / columns)
    const column = index % columns
    const inRow = Math.min(columns, ids.length - row * columns)
    const spanX = (inRow - 1) * MIN_SEPARATION_X
    const left = Math.max(CLAMP_INSET_X, width / 2 - spanX / 2)

    out[id] = clampCentre({ x: left + column * MIN_SEPARATION_X, y: top + row * stepY }, width, height)
  })

  return out
}

const hasOverlap = (points: Record<string, Point>): boolean => {
  const ids = Object.keys(points)

  for (let i = 0; i < ids.length; i += 1) {
    for (let j = i + 1; j < ids.length; j += 1) {
      if (
        rectsIntersect(
          nodeRect(points[ids[i] as string] as Point),
          nodeRect(points[ids[j] as string] as Point)
        )
      ) {
        return true
      }
    }
  }

  return false
}

const withinCanvas = (point: Point, width: number, height: number): boolean =>
  rectWithin(nodeRect(point), width, height)

const forceLayout = (
  graph: WorkbenchGraph,
  existing: Record<string, Point>,
  width: number,
  height: number,
  seed: string
): Record<string, Point> => {
  const centerX = width / 2
  const centerY = height / 2
  const random = seededRandom(seed)

  const nodes: LayoutNode[] = graph.nodes.map((node, index) => {
    const persisted = existing[node.id]
    const angle = (index / Math.max(1, graph.nodes.length)) * Math.PI * 2
    const radius = NODE_HALF_DIAGONAL + index * 14

    // Persisted coordinates are the STARTING point, never a pin: that is what
    // lets a revised diagram visibly reflow instead of teleporting, while an
    // unchanged diagram is short-circuited earlier and stays pixel-identical.
    return {
      id: node.id,
      x: persisted?.x ?? centerX + Math.cos(angle) * radius,
      y: persisted?.y ?? centerY + Math.sin(angle) * radius
    }
  })

  const known = new Set(nodes.map(node => node.id))

  const links: LayoutLink[] = graph.edges
    .filter(edge => known.has(edge.from) && known.has(edge.to))
    .map(edge => ({ source: edge.from, target: edge.to }))

  const simulation = forceSimulation<LayoutNode>(nodes)
    .randomSource(random)
    .force(
      'link',
      forceLink<LayoutNode, LayoutLink>(links)
        .id(node => node.id)
        .distance(MIN_SEPARATION_X)
        .strength(0.3)
    )
    .force('charge', forceManyBody().strength(-620))
    // Collision radius must EXCEED the node half-diagonal or boxes overlap by
    // construction. This was 62 against a half-diagonal of ~81.
    .force('collision', forceCollide<LayoutNode>(NODE_HALF_DIAGONAL + 8).strength(1))
    .force('center', forceCenter(centerX, centerY).strength(0.08))
    .stop()

  for (let index = 0; index < 220; index += 1) {
    simulation.tick()
  }

  simulation.stop()

  return Object.fromEntries(
    nodes.map(node => [node.id, clampCentre({ x: node.x, y: node.y }, width, height)])
  )
}

const round = (points: Record<string, Point>): Record<string, Point> =>
  Object.fromEntries(
    Object.entries(points).map(([id, point]) => [
      id,
      { x: Number(point.x.toFixed(2)), y: Number(point.y.toFixed(2)) }
    ])
  )

/**
 * Place nodes.
 *
 * Stability vs responsiveness:
 * - Identical semantic payload (same ids, labels, kinds, edges) → the persisted
 *   positions are returned untouched, so "that box on the left" survives.
 * - ANY change → pins are released and the layout re-settles FROM the current
 *   positions, so it visibly reflows.
 *
 * Algorithm: layered (Sugiyama) for DAG-shaped flows, force-directed for
 * cyclic/unstructured graphs, followed in both cases by a rectangular
 * separation pass derived from the real node box, and a grid fallback that
 * guarantees zero overlap.
 */
let lastHash: string | undefined

/** Test seam: forget the memoised payload hash. */
export function resetWorkbenchLayoutMemo(): void {
  lastHash = undefined
}

export function placeWorkbenchNodes(
  graph: WorkbenchGraph,
  existing: Record<string, Point>,
  width: number,
  height: number,
  previousHash?: string
): Record<string, Point> {
  const safeWidth = Math.max(NODE_WIDTH * 2, width)
  const safeHeight = Math.max(NODE_HEIGHT * 3, height)
  const hash = hashWorkbenchGraph(graph)
  // Public entry point: a timeline / quadrant / sketch payload has no nodes at
  // all, and `pane.tsx` calls this for EVERY kind. Normalising here keeps every
  // downstream helper safe and returns {} for a non-graph payload.
  const ids = (graph?.nodes ?? []).map(node => node.id)

  if (ids.length === 0) {
    return {}
  }

  const persisted = Object.fromEntries(
    ids.filter(id => existing[id]).map(id => [id, { ...(existing[id] as Point) }])
  )

  const everyNodePersisted = Object.keys(persisted).length === ids.length
  // `pane.tsx` does not (and must not have to) thread a hash through, so the
  // last-seen payload hash is also remembered here. Either source proves the
  // graph is unchanged.
  const unchanged = (previousHash ?? lastHash) === hash

  lastHash = hash

  // Unchanged graph AND the picture on screen is already valid: return it
  // byte-for-byte, so "that box on the left" never moves under the user.
  if (
    unchanged &&
    everyNodePersisted &&
    !hasOverlap(persisted) &&
    Object.values(persisted).every(point => withinCanvas(point, safeWidth, safeHeight))
  ) {
    return round(persisted)
  }

  const layered = layeredLayout(graph, safeWidth, safeHeight)
  const base = layered ?? forceLayout(graph, existing, safeWidth, safeHeight, hash)
  const separated = separateRects(base, safeWidth, safeHeight)

  if (!hasOverlap(separated)) {
    return round(separated)
  }

  return round(gridLayout([...ids].sort(), safeWidth, safeHeight))
}
