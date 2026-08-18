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
 * Seat only nodes that have no persisted position.
 *
 * Existing coordinates become force-layout fixed points (`fx`/`fy`), so an
 * ambient semantic revision cannot make the diagram breathe under the user's
 * gaze. A graph-id seeded RNG keeps first placement deterministic in tests,
 * reconnects, and concurrent windows until the renderer persists it.
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
      ...(persisted ? { fx: persisted.x, fy: persisted.y } : {})
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
