import { forceCenter, forceCollide, forceLink, forceManyBody, forceSimulation } from 'd3-force'

import type { WorkbenchGraph } from '@/store/workbench'

interface LayoutNode {
  fx?: null | number
  fy?: null | number
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

const clamp = (value: number, minimum: number, maximum: number) =>
  Math.min(maximum, Math.max(minimum, value))

/**
 * Place nodes, keeping the picture stable without freezing it solid.
 *
 * Two competing needs. Stability: an unchanged graph must not shuffle, or the
 * user loses "that box on the left". Responsiveness: when the model revises
 * the diagram, the layout has to actually change — the renderer persists a
 * position for EVERY node, so treating all persisted coordinates as immutable
 * fixed points means a redraw can never improve anything, which reads to the
 * user as "it said it updated but nothing happened".
 *
 * So: persisted coordinates are always the STARTING point (that is what keeps
 * an unchanged graph pixel-identical), but they are only frozen as `fx`/`fy`
 * while the structure is the same. When nodes or edges change, everything is
 * released and the simulation re-settles from where it already was — the
 * diagram visibly reflows without teleporting.
 */
export function placeWorkbenchNodes(
  graph: WorkbenchGraph,
  existing: Record<string, { x: number; y: number }>,
  width: number,
  height: number
): Record<string, { x: number; y: number }> {
  const safeWidth = Math.max(240, width)
  const safeHeight = Math.max(180, height)
  const centerX = safeWidth / 2
  const centerY = safeHeight / 2
  const random = seededRandom(graph.nodes.map(node => node.id).sort().join('|'))

  // A node without a persisted position means the structure grew. An edge
  // count that no longer matches means relationships changed. Either way the
  // old layout is stale and must be allowed to move.
  const structureChanged =
    graph.nodes.some(node => !existing[node.id]) ||
    Object.keys(existing).length !== graph.nodes.length

  const nodes: LayoutNode[] = graph.nodes.map((node, index) => {
    const persisted = existing[node.id]
    const angle = (index / Math.max(1, graph.nodes.length)) * Math.PI * 2
    const radius = 70 + index * 12
    const x = persisted?.x ?? centerX + Math.cos(angle) * radius
    const y = persisted?.y ?? centerY + Math.sin(angle) * radius

    return {
      id: node.id,
      x,
      y,
      ...(persisted && !structureChanged ? { fx: persisted.x, fy: persisted.y } : {})
    }
  })

  const links: LayoutLink[] = graph.edges.map(edge => ({ source: edge.from, target: edge.to }))

  const simulation = forceSimulation<LayoutNode>(nodes)
    .randomSource(random)
    .force(
      'link',
      forceLink<LayoutNode, LayoutLink>(links)
        .id(node => node.id)
        .distance(145)
        .strength(0.35)
    )
    .force('charge', forceManyBody().strength(-420))
    .force('collision', forceCollide<LayoutNode>(62).strength(0.9))
    .force('center', forceCenter(centerX, centerY).strength(0.08))
    .stop()

  for (let index = 0; index < 120; index += 1) {
    simulation.tick()
  }

  simulation.stop()

  return Object.fromEntries(
    nodes.map(node => [
      node.id,
      {
        x: Number(clamp(node.x, 58, safeWidth - 58).toFixed(2)),
        y: Number(clamp(node.y, 42, safeHeight - 42).toFixed(2))
      }
    ])
  )
}
