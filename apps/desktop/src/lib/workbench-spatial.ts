/**
 * Coarse spatial language for the workbench canvas.
 *
 * The voice model cannot use pixels: they mean nothing to a language model and
 * go stale on every relayout. What it CAN use is the same vocabulary a person
 * standing at a whiteboard uses — "the box on the left", "the one up top",
 * "just below the planner". This module turns laid-out positions into exactly
 * that vocabulary and nothing else.
 *
 * Pure: no React, no DOM, no store. Fully unit-testable.
 */

export interface SpatialPoint {
  x: number
  y: number
}

/**
 * The 3x3 bucket vocabulary, chosen so it reads naturally when SPOKEN:
 * "the one in the upper left", "the box on the far right", "the middle one".
 *
 * `centre` is deliberately the only cell without a compass word — a speaker
 * says "the middle one", not "the centre-centre one".
 */
export type SpatialZone =
  | 'bottom edge'
  | 'centre'
  | 'far left'
  | 'far right'
  | 'lower left'
  | 'lower right'
  | 'top edge'
  | 'upper left'
  | 'upper right'

const COLUMN_ZONES = ['left', 'centre', 'right'] as const
const ROW_ZONES = ['upper', 'middle', 'lower'] as const

type Column = (typeof COLUMN_ZONES)[number]
type Row = (typeof ROW_ZONES)[number]

const ZONE_TABLE: Record<Row, Record<Column, SpatialZone>> = {
  lower: { centre: 'bottom edge', left: 'lower left', right: 'lower right' },
  middle: { centre: 'centre', left: 'far left', right: 'far right' },
  upper: { centre: 'top edge', left: 'upper left', right: 'upper right' }
}

/** Split a 0..1 fraction into three equal bands. Out-of-range values clamp. */
const band = (fraction: number): 0 | 1 | 2 => {
  if (!Number.isFinite(fraction) || fraction < 1 / 3) {
    return 0
  }

  return fraction < 2 / 3 ? 1 : 2
}

export function zoneFor(point: SpatialPoint, width: number, height: number): SpatialZone {
  const safeWidth = width > 0 ? width : 1
  const safeHeight = height > 0 ? height : 1
  const column = COLUMN_ZONES[band(point.x / safeWidth)]
  const row = ROW_ZONES[band(point.y / safeHeight)]

  return ZONE_TABLE[row][column]
}

export interface SpatialNode {
  /** `left of: controller`, `below: planner` … at most two, cheapest first. */
  near: string[]
  zone: SpatialZone
}

export interface SpatialDescriptionOptions {
  /** Max neighbour relations emitted per node. Keeps the payload small. */
  maxRelations?: number
}

interface Placed {
  id: string
  label: string
  point: SpatialPoint
}

/**
 * Relations are emitted only when the axis is UNAMBIGUOUS: a node that is
 * 4px to the left of another is not "left of" it in any way a human would
 * accept, and a wrong relation is worse than no relation.
 */
const RELATION_MIN_GAP = 40
/** Only relate to genuinely nearby nodes; "left of" across the whole canvas is noise. */
const RELATION_MAX_DISTANCE_RATIO = 0.45

const relationBetween = (from: SpatialPoint, to: SpatialPoint): null | string => {
  const dx = to.x - from.x
  const dy = to.y - from.y

  // Pick the DOMINANT axis: a node that is both slightly up and far left is
  // described as "left of", which is what a person would say.
  if (Math.abs(dx) >= Math.abs(dy)) {
    if (Math.abs(dx) < RELATION_MIN_GAP) {
      return null
    }

    return dx > 0 ? 'left of' : 'right of'
  }

  if (Math.abs(dy) < RELATION_MIN_GAP) {
    return null
  }

  return dy > 0 ? 'above' : 'below'
}

/**
 * Describe every laid-out node in coarse, speakable spatial terms.
 *
 * Returns a map keyed by node id. Nodes with no position are omitted rather
 * than guessed — telling the model a location we do not have is the exact
 * "confidently wrong" failure this whole module exists to prevent.
 */
export function describeWorkbenchSpace(
  nodes: { id: string; label?: string }[],
  positions: Record<string, SpatialPoint>,
  width: number,
  height: number,
  options: SpatialDescriptionOptions = {}
): Record<string, SpatialNode> {
  const maxRelations = options.maxRelations ?? 2
  const placed: Placed[] = []

  for (const node of nodes) {
    const point = positions[node.id]

    if (point && Number.isFinite(point.x) && Number.isFinite(point.y)) {
      placed.push({ id: node.id, label: node.label ?? node.id, point })
    }
  }

  const maxDistance = Math.hypot(width, height) * RELATION_MAX_DISTANCE_RATIO
  const out: Record<string, SpatialNode> = {}

  for (const subject of placed) {
    const candidates = placed
      .filter(other => other.id !== subject.id)
      .map(other => ({
        distance: Math.hypot(other.point.x - subject.point.x, other.point.y - subject.point.y),
        other
      }))
      .filter(entry => entry.distance <= maxDistance)
      .sort((a, b) => a.distance - b.distance)

    const near: string[] = []

    for (const { other } of candidates) {
      if (near.length >= maxRelations) {
        break
      }

      const relation = relationBetween(subject.point, other.point)

      if (relation) {
        near.push(`${relation}: ${other.label}`)
      }
    }

    out[subject.id] = { near, zone: zoneFor(subject.point, width, height) }
  }

  return out
}

/**
 * One-line English gloss for a single node, for when the model is asked to
 * speak the location out loud.
 */
export function describeLocation(spatial: SpatialNode): string {
  return spatial.near.length > 0 ? `${spatial.zone} (${spatial.near.join(', ')})` : spatial.zone
}

/* ------------------------------------------------------------------ *
 * The workbench context payload sent to the voice model.
 *
 * Pure so the ONE owner of context freshness (the realtime voice hook) has
 * nothing to test but its scheduling.
 * ------------------------------------------------------------------ */

export interface WorkbenchContextInput {
  /** A full redraw is in flight; prefer the instant tools over another one. */
  drawing?: boolean
  edges?: { from: string; id?: string; label?: string; to: string }[]
  hidden?: string[]
  kind: string
  layout?: null | { height: number; positions: Record<string, SpatialPoint>; width: number }
  nodes?: { id: string; kind?: string; label?: string }[]
  pinned?: string[]
  revision: number
  selection?: null | string
}

export interface WorkbenchContextNode {
  id: string
  kind?: string
  label?: string
  /** Coarse zone, e.g. `upper left`. Never pixels. */
  location?: SpatialZone
  near?: string[]
  pinned?: true
}

/**
 * Build the JSON summary handed to `updateWorkbenchContext`.
 *
 * `selection` is emitted as `pointing_at` because that is what it MEANS: the
 * user's finger, not an app-internal highlight flag.
 */
export function buildWorkbenchContext(input: WorkbenchContextInput): string {
  const nodes = input.nodes ?? []
  const hidden = new Set(input.hidden ?? [])
  const pinned = new Set(input.pinned ?? [])
  const visible = nodes.filter(node => !hidden.has(node.id))

  const spatial = input.layout
    ? describeWorkbenchSpace(visible, input.layout.positions, input.layout.width, input.layout.height)
    : {}

  const described: WorkbenchContextNode[] = visible.map(node => {
    const place = spatial[node.id]

    return {
      id: node.id,
      label: node.label,
      kind: node.kind,
      ...(place ? { location: place.zone, near: place.near } : {}),
      ...(pinned.has(node.id) ? { pinned: true as const } : {})
    }
  })

  const selection =
    input.selection && visible.some(node => node.id === input.selection) ? input.selection : null

  const selected = described.find(node => node.id === selection)

  return JSON.stringify({
    kind: input.kind,
    revision: input.revision,
    // Present only while true, so it reads as a live condition rather than a
    // permanent field the model learns to ignore.
    ...(input.drawing ? { redrawing: true } : {}),
    // `null` is meaningful and must be sent explicitly: it is how the model
    // learns the user STOPPED pointing at something.
    pointing_at: selection,
    pointing_at_label: selected?.label ?? null,
    pointing_at_location: selected?.location ?? null,
    nodes: described,
    edges: (input.edges ?? [])
      .filter(edge => !hidden.has(edge.from) && !hidden.has(edge.to))
      // The edge id is what makes `disconnect(edge_id)` callable. Without it
      // the tool exists and the model can never name a target — the same
      // orphan class as a renderer nobody dispatches to.
      .map(edge => ({
        ...(edge.id ? { id: edge.id } : {}),
        from: edge.from,
        to: edge.to,
        label: edge.label
      })),
    ...(hidden.size > 0 ? { hidden_from_view: [...hidden] } : {})
  })
}
