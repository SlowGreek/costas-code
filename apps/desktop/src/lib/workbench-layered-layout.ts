/**
 * Layered (Sugiyama-style) layout for the flow-shaped DAGs the diagrammer
 * keeps producing (Task/Context -> Controller -> Planner -> Tools -> Response).
 *
 * Force-directed layout is the right tool for an unstructured blob, but for a
 * pipeline it produces exactly that: a blob with crossing edges. Here we
 *
 *   1. assign a rank per node by LONGEST PATH from a source,
 *   2. order nodes within each rank by repeated barycentre sweeps to reduce
 *      edge crossings,
 *   3. position on a grid derived from the real node box size.
 *
 * Cyclic graphs return `null` so the caller falls back to the force layout.
 */

import type { WorkbenchGraph } from '@/store/workbench'

import {
  CLAMP_INSET_X,
  CLAMP_INSET_Y,
  MIN_SEPARATION_X,
  MIN_SEPARATION_Y,
  NODE_HEIGHT,
  NODE_WIDTH,
  type Point
} from './workbench-node-box'

/**
 * Longest-path ranking. Returns `null` if the graph contains a cycle, which is
 * the signal to fall back to force layout.
 */
export function assignRanks(graph: WorkbenchGraph): null | Record<string, number> {
  const ids = graph.nodes.map(node => node.id)
  const known = new Set(ids)
  const incoming = new Map<string, string[]>(ids.map(id => [id, []]))
  const outgoing = new Map<string, string[]>(ids.map(id => [id, []]))

  for (const edge of graph.edges) {
    if (!known.has(edge.from) || !known.has(edge.to) || edge.from === edge.to) {
      // Self loops and dangling edges are cycles / noise: not DAG-shaped.
      if (edge.from === edge.to && known.has(edge.from)) {
        return null
      }

      continue
    }

    outgoing.get(edge.from)?.push(edge.to)
    incoming.get(edge.to)?.push(edge.from)
  }

  // Kahn's algorithm gives us both a topological order and cycle detection.
  const indegree = new Map<string, number>(ids.map(id => [id, incoming.get(id)?.length ?? 0]))
  const queue = ids.filter(id => (indegree.get(id) ?? 0) === 0)
  const order: string[] = []

  while (queue.length > 0) {
    const id = queue.shift() as string

    order.push(id)

    for (const next of outgoing.get(id) ?? []) {
      const remaining = (indegree.get(next) ?? 0) - 1

      indegree.set(next, remaining)

      if (remaining === 0) {
        queue.push(next)
      }
    }
  }

  if (order.length !== ids.length) {
    return null
  }

  const ranks: Record<string, number> = Object.fromEntries(ids.map(id => [id, 0]))

  for (const id of order) {
    for (const next of outgoing.get(id) ?? []) {
      ranks[next] = Math.max(ranks[next], ranks[id] + 1)
    }
  }

  return ranks
}

const median = (values: number[]): null | number => {
  if (values.length === 0) {
    return null
  }

  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)

  return sorted.length % 2 === 1
    ? (sorted[middle] as number)
    : (((sorted[middle - 1] as number) + (sorted[middle] as number)) / 2)
}

/** Count edge crossings between two adjacent layers, for reporting/tests. */
export function countCrossings(
  layers: string[][],
  edges: { from: string; to: string }[]
): number {
  const index = new Map<string, { order: number; rank: number }>()

  layers.forEach((layer, rank) => {
    layer.forEach((id, order) => {
      index.set(id, { order, rank })
    })
  })

  const spans: { a: number; b: number }[] = []

  for (const edge of edges) {
    const from = index.get(edge.from)
    const to = index.get(edge.to)

    if (!from || !to || to.rank !== from.rank + 1) {
      continue
    }

    spans.push({ a: from.order, b: to.order })
  }

  let crossings = 0

  for (let i = 0; i < spans.length; i += 1) {
    for (let j = i + 1; j < spans.length; j += 1) {
      const p = spans[i] as { a: number; b: number }
      const q = spans[j] as { a: number; b: number }

      if ((p.a - q.a) * (p.b - q.b) < 0) {
        crossings += 1
      }
    }
  }

  return crossings
}

/**
 * Order nodes inside each rank with alternating down/up barycentre sweeps —
 * the standard, cheap crossing-reduction heuristic. Deterministic: ties keep
 * the previous order, which itself starts from stable input order.
 */
export function orderLayers(
  ranks: Record<string, number>,
  graph: WorkbenchGraph,
  sweeps = 6
): string[][] {
  const depth = Math.max(0, ...Object.values(ranks)) + 1
  const layers: string[][] = Array.from({ length: depth }, () => [])

  for (const node of graph.nodes) {
    layers[ranks[node.id] ?? 0]?.push(node.id)
  }

  const neighboursUp = new Map<string, string[]>()
  const neighboursDown = new Map<string, string[]>()

  for (const edge of graph.edges) {
    if (!(edge.from in ranks) || !(edge.to in ranks) || edge.from === edge.to) {
      continue
    }

    if (!neighboursUp.has(edge.to)) {
      neighboursUp.set(edge.to, [])
    }

    if (!neighboursDown.has(edge.from)) {
      neighboursDown.set(edge.from, [])
    }

    neighboursUp.get(edge.to)?.push(edge.from)
    neighboursDown.get(edge.from)?.push(edge.to)
  }

  const positionOf = (layer: string[]) => new Map(layer.map((id, order) => [id, order]))

  for (let sweep = 0; sweep < sweeps; sweep += 1) {
    const downward = sweep % 2 === 0

    if (downward) {
      for (let rank = 1; rank < layers.length; rank += 1) {
        const above = positionOf(layers[rank - 1] as string[])
        const current = layers[rank] as string[]

        const keys = new Map(
          current.map((id, order) => {
            const bary = median(
              (neighboursUp.get(id) ?? [])
                .map(other => above.get(other))
                .filter((value): value is number => value !== undefined)
            )

            return [id, bary ?? order]
          })
        )

        layers[rank] = [...current].sort(
          (a, b) => (keys.get(a) as number) - (keys.get(b) as number)
        )
      }
    } else {
      for (let rank = layers.length - 2; rank >= 0; rank -= 1) {
        const below = positionOf(layers[rank + 1] as string[])
        const current = layers[rank] as string[]

        const keys = new Map(
          current.map((id, order) => {
            const bary = median(
              (neighboursDown.get(id) ?? [])
                .map(other => below.get(other))
                .filter((value): value is number => value !== undefined)
            )

            return [id, bary ?? order]
          })
        )

        layers[rank] = [...current].sort(
          (a, b) => (keys.get(a) as number) - (keys.get(b) as number)
        )
      }
    }
  }

  return layers
}

/**
 * Full layered layout. Returns `null` for cyclic graphs (caller falls back to
 * the force layout) or when the canvas cannot hold the required grid.
 */
export function layeredLayout(
  graph: WorkbenchGraph,
  width: number,
  height: number
): null | Record<string, Point> {
  if (graph.nodes.length === 0) {
    return null
  }

  const ranks = assignRanks(graph)

  if (!ranks) {
    return null
  }

  const layers = orderLayers(ranks, graph)
  const usableWidth = width - CLAMP_INSET_X * 2
  const usableHeight = height - CLAMP_INSET_Y * 2
  const widest = Math.max(...layers.map(layer => layer.length))
  const rankCount = layers.length

  // Minimum steps that still guarantee non-intersecting boxes.
  const minRankStepX = NODE_WIDTH + 10
  const minSiblingStepY = NODE_HEIGHT + 10
  const minRankStepY = NODE_HEIGHT + 10
  const minSiblingStepX = NODE_WIDTH + 10

  const fitStep = (available: number, count: number, minimum: number, preferred: number) => {
    if (count <= 1) {
      return preferred
    }

    const step = Math.min(preferred, available / (count - 1))

    return step < minimum ? null : step
  }

  // Prefer a left-to-right flow (ranks along x). If the pipeline is too long
  // for the canvas, fall back to a top-to-bottom flow before giving up —
  // ranks are cheap vertically because the box is short.
  const horizontal =
    fitStep(usableWidth, rankCount, minRankStepX, MIN_SEPARATION_X) !== null &&
    fitStep(usableHeight, widest, minSiblingStepY, MIN_SEPARATION_Y) !== null

  const vertical =
    !horizontal &&
    fitStep(usableHeight, rankCount, minRankStepY, MIN_SEPARATION_Y) !== null &&
    fitStep(usableWidth, widest, minSiblingStepX, MIN_SEPARATION_X) !== null

  if (!horizontal && !vertical) {
    // Grid cannot fit without overlapping; let the caller's force layout plus
    // separation pass do the best it can.
    return null
  }

  const rankStep = horizontal
    ? (fitStep(usableWidth, rankCount, minRankStepX, MIN_SEPARATION_X) as number)
    : (fitStep(usableHeight, rankCount, minRankStepY, MIN_SEPARATION_Y) as number)

  const siblingStep = horizontal
    ? (fitStep(usableHeight, widest, minSiblingStepY, MIN_SEPARATION_Y) as number)
    : (fitStep(usableWidth, widest, minSiblingStepX, MIN_SEPARATION_X) as number)

  const rankSpan = (rankCount - 1) * rankStep
  const rankInset = horizontal ? CLAMP_INSET_X : CLAMP_INSET_Y
  const rankExtent = horizontal ? usableWidth : usableHeight
  const rankOrigin = rankInset + (rankExtent - rankSpan) / 2
  const siblingCentre = horizontal ? height / 2 : width / 2
  const out: Record<string, Point> = {}

  layers.forEach((layer, rank) => {
    const span = (layer.length - 1) * siblingStep
    const first = siblingCentre - span / 2
    const along = rankOrigin + rank * rankStep

    layer.forEach((id, order) => {
      const across = first + order * siblingStep

      out[id] = horizontal ? { x: along, y: across } : { x: across, y: along }
    })
  })

  return out
}
