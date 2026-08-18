/**
 * Direct manipulation model for the workbench canvas (Track B).
 *
 * THE CENTRAL DISTINCTION (contract §7) — two different concepts:
 *
 * - **Auto-position** (`view_state.positions`) — where the LAYOUT ENGINE put a
 *   node. Persisted only so an unchanged graph redraws identically. The layout
 *   is free to move these whenever the payload changes. `view_state.pinned` is
 *   written as "every node id" by the position-persist path, so it is
 *   auto-position bookkeeping and carries NO user intent.
 * - **User pin** (`view_state.user_pins`) — the user deliberately dragged this
 *   node here. Survives relayout, redraws and new revisions until explicitly
 *   unpinned.
 *
 * A user pin is NEVER inferred from the presence of a persisted position.
 * Conflating the two froze the layout permanently once already.
 *
 * Everything here is a pure function: no React, no gateway, no model calls.
 */

import type { WorkbenchGraph, WorkbenchViewState } from '@/store/workbench'

import type { Point } from './workbench-node-box'

/** Where user pins live. Deliberately NOT `positions` and NOT `pinned`. */
export const USER_PIN_KEY = 'user_pins' as const
/** Where user-hidden node ids live. */
export const HIDDEN_KEY = 'hidden' as const

export interface DirectManipulationViewState extends WorkbenchViewState {
  hidden?: string[]
  user_pins?: Record<string, Point>
}

const isFinitePoint = (value: unknown): value is Point => {
  if (!value || typeof value !== 'object') {
    return false
  }

  const point = value as { x?: unknown; y?: unknown }

  return (
    typeof point.x === 'number' &&
    typeof point.y === 'number' &&
    Number.isFinite(point.x) &&
    Number.isFinite(point.y)
  )
}

/** Read user pins defensively: an unknown/legacy view_state yields none. */
export function readUserPins(
  viewState: DirectManipulationViewState | null | undefined
): Record<string, Point> {
  const raw = viewState?.[USER_PIN_KEY]

  if (!raw || typeof raw !== 'object') {
    return {}
  }

  const out: Record<string, Point> = {}

  for (const [id, point] of Object.entries(raw)) {
    if (id && isFinitePoint(point)) {
      out[id] = { x: point.x, y: point.y }
    }
  }

  return out
}

export function readHidden(
  viewState: DirectManipulationViewState | null | undefined
): string[] {
  const raw = viewState?.[HIDDEN_KEY]

  if (!Array.isArray(raw)) {
    return []
  }

  return [...new Set(raw.filter((id): id is string => typeof id === 'string' && id.length > 0))]
}

export function isUserPinned(
  viewState: DirectManipulationViewState | null | undefined,
  nodeId: string
): boolean {
  return nodeId in readUserPins(viewState)
}

export function isHidden(
  viewState: DirectManipulationViewState | null | undefined,
  nodeId: string
): boolean {
  return readHidden(viewState).includes(nodeId)
}

/**
 * Overlay user pins on top of whatever the layout engine produced.
 *
 * This is the ONLY place a pin influences geometry, and it runs AFTER layout —
 * so the layout engine itself is never frozen (the bug we are not repeating).
 * Pins for nodes that no longer exist are ignored, not resurrected.
 */
export function applyUserPins(
  layoutPositions: Record<string, Point>,
  viewState: DirectManipulationViewState | null | undefined
): Record<string, Point> {
  const pins = readUserPins(viewState)
  const out: Record<string, Point> = { ...layoutPositions }

  for (const [id, point] of Object.entries(pins)) {
    if (id in layoutPositions) {
      out[id] = { x: point.x, y: point.y }
    }
  }

  return out
}

/** A user drag: record a pin. Returns a NEW view_state; `positions` untouched. */
export function withUserPin(
  viewState: DirectManipulationViewState,
  nodeId: string,
  point: Point
): DirectManipulationViewState {
  if (!nodeId || !isFinitePoint(point)) {
    return viewState
  }

  return {
    ...viewState,
    [USER_PIN_KEY]: {
      ...readUserPins(viewState),
      [nodeId]: { x: point.x, y: point.y }
    }
  }
}

/** Release a user pin; the node returns to layout-engine control. */
export function withoutUserPin(
  viewState: DirectManipulationViewState,
  nodeId: string
): DirectManipulationViewState {
  const pins = readUserPins(viewState)

  if (!(nodeId in pins)) {
    return viewState
  }

  delete pins[nodeId]

  return { ...viewState, [USER_PIN_KEY]: pins }
}

export function withHidden(
  viewState: DirectManipulationViewState,
  nodeId: string,
  hidden: boolean
): DirectManipulationViewState {
  const current = new Set(readHidden(viewState))

  if (hidden) {
    current.add(nodeId)
  } else {
    current.delete(nodeId)
  }

  return { ...viewState, [HIDDEN_KEY]: [...current].sort() }
}

/**
 * Drop pins/hides for nodes that no longer exist, so view_state cannot grow
 * unbounded across revisions. Called at persist time, never at paint time.
 */
export function pruneViewStateToGraph(
  viewState: DirectManipulationViewState,
  graph: WorkbenchGraph
): DirectManipulationViewState {
  const live = new Set(graph.nodes.map(node => node.id))

  const pins = Object.fromEntries(
    Object.entries(readUserPins(viewState)).filter(([id]) => live.has(id))
  )

  const hidden = readHidden(viewState).filter(id => live.has(id))

  return { ...viewState, [HIDDEN_KEY]: hidden, [USER_PIN_KEY]: pins }
}

/**
 * What the canvas should actually draw once user hides are applied. Hiding is
 * a VIEW concern: the semantic payload keeps the node, so unhiding is free and
 * the voice model still knows the idea exists.
 */
export function visibleGraph(
  graph: WorkbenchGraph,
  viewState: DirectManipulationViewState | null | undefined
): WorkbenchGraph {
  const hidden = new Set(readHidden(viewState))

  if (hidden.size === 0) {
    return graph
  }

  const nodes = graph.nodes.filter(node => !hidden.has(node.id))

  return {
    edges: graph.edges.filter(edge => !hidden.has(edge.from) && !hidden.has(edge.to)),
    nodes
  }
}

/* ------------------------------------------------------------------ *
 * Surgical semantic edits — the client-side mirror of the gateway op.
 * Pure, so the optimistic paint and the persisted result agree.
 * ------------------------------------------------------------------ */

export type SurgicalEdit =
  | { edge_id: string; op: 'disconnect' }
  | { from_id: string; label?: string; op: 'connect'; to_id: string }
  | { label: string; node_id: string; op: 'rename' }
  | { node_id: string; op: 'remove' }

export class SurgicalEditError extends Error {}

const MAX_LABEL = 200

export function connectionEdgeId(fromId: string, toId: string, existing: Set<string>): string {
  const base = `e-${fromId}-${toId}`

  if (!existing.has(base)) {
    return base
  }

  let index = 2

  while (existing.has(`${base}-${index}`)) {
    index += 1
  }

  return `${base}-${index}`
}

/** Apply one surgical edit to a graph. Throws on an edit that cannot apply. */
export function applySurgicalEdit(graph: WorkbenchGraph, edit: SurgicalEdit): WorkbenchGraph {
  const nodeIds = new Set(graph.nodes.map(node => node.id))

  switch (edit.op) {
    case 'connect': {
      if (!nodeIds.has(edit.from_id) || !nodeIds.has(edit.to_id)) {
        throw new SurgicalEditError('connect references an unknown node')
      }

      if (edit.from_id === edit.to_id) {
        throw new SurgicalEditError('connect requires two different nodes')
      }

      const label = (edit.label ?? '').trim().slice(0, MAX_LABEL)
      const id = connectionEdgeId(edit.from_id, edit.to_id, new Set(graph.edges.map(e => e.id)))

      return {
        edges: [...graph.edges, { from: edit.from_id, id, to: edit.to_id, ...(label ? { label } : {}) }],
        nodes: graph.nodes
      }
    }

    case 'disconnect': {
      if (!graph.edges.some(edge => edge.id === edit.edge_id)) {
        throw new SurgicalEditError(`unknown edge: ${edit.edge_id}`)
      }

      return { edges: graph.edges.filter(edge => edge.id !== edit.edge_id), nodes: graph.nodes }
    }

    case 'remove': {
      if (!nodeIds.has(edit.node_id)) {
        throw new SurgicalEditError(`unknown node: ${edit.node_id}`)
      }

      return {
        // Dangling edges are removed with the node: the graph must stay valid.
        edges: graph.edges.filter(
          edge => edge.from !== edit.node_id && edge.to !== edit.node_id
        ),
        nodes: graph.nodes.filter(node => node.id !== edit.node_id)
      }
    }

    case 'rename': {
      if (!nodeIds.has(edit.node_id)) {
        throw new SurgicalEditError(`unknown node: ${edit.node_id}`)
      }

      const label = edit.label.trim().slice(0, MAX_LABEL)

      if (!label) {
        throw new SurgicalEditError('rename requires a non-empty label')
      }

      return {
        edges: graph.edges,
        // Node ids are STABLE: a rename changes the label only (invariant §1).
        nodes: graph.nodes.map(node =>
          node.id === edit.node_id ? { ...node, label } : node
        )
      }
    }

    default:
      throw new SurgicalEditError('unsupported edit')
  }
}
