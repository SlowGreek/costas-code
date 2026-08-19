import { useStore } from '@nanostores/react'
import {
  type PointerEvent as ReactPointerEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef
} from 'react'

import type { WorkbenchCamera } from '@/lib/workbench-camera'
import {
  cameraViewBox,
  clampCamera,
  IDENTITY_CAMERA,
  isPanGesture,
  panCamera,
  visibleSize,
  wheelIntent,
  zoomAt,
  zoomStepFromWheel
} from '@/lib/workbench-camera'
import { focusedNodeId } from '@/lib/workbench-focus'
import {
  NODE_HALF_HEIGHT,
  NODE_HALF_WIDTH,
  NODE_HEIGHT,
  NODE_WIDTH,
  type Point
} from '@/lib/workbench-node-box'
import {
  $workbenchCamera,
  $workbenchDraggingNode,
  $workbenchDragOverride,
  $workbenchSelection,
  clearWorkbenchSelection,
  setWorkbenchCamera,
  setWorkbenchDragOverride,
  setWorkbenchSelection,
  type WorkbenchArtifact,
  type WorkbenchEdge,
  type WorkbenchNode
} from '@/store/workbench'

export type { Point }

interface MapRendererProps {
  artifact: WorkbenchArtifact
  height: number
  /**
   * Called once a drag GESTURE ENDS, with the node's new canvas centre. The
   * drag itself never waits for this: painting is renderer-local, and the
   * caller persists the resulting USER PIN optimistically (with rollback).
   * Omit to keep the canvas read-only.
   */
  onNodePinned?: (nodeId: string, point: Point) => void
  positions: Record<string, Point>
  width: number
}

/* ------------------------------------------------------------------ *
 * Design tokens (geometry + type scale). Colour comes from --ui-*.
 * ------------------------------------------------------------------ */

// Node box geometry lives in one place (`@/lib/workbench-node-box`) so the
// layout's collision radius and clamp inset are derived from the SAME numbers
// the renderer draws. Re-exported for existing importers.
export { NODE_HEIGHT, NODE_WIDTH }

export function nodeRingState(
  nodeId: string,
  state: { durable: null | string; selected: null | string }
): { durable: boolean; selected: boolean } {
  return {
    durable: state.durable === nodeId,
    selected: state.selected === nodeId
  }
}

const NODE_RADIUS = 12
const NODE_HALF_W = NODE_HALF_WIDTH
const NODE_HALF_H = NODE_HALF_HEIGHT

/** Type scale: 8 / 10 / 12 — one step per hierarchy level. */
const TYPE_LABEL = 12
const TYPE_KIND = 8.5
const TYPE_EDGE = 9.5

/**
 * Semantic accent per node `kind`. Every entry is an existing --ui-* custom
 * property so light/dark themes both work and nothing is hardcoded.
 */
const KIND_ACCENTS: Record<string, string> = {
  actor: 'var(--ui-purple)',
  agent: 'var(--ui-purple)',
  concept: 'var(--ui-blue)',
  constraint: 'var(--ui-orange)',
  decision: 'var(--ui-green)',
  goal: 'var(--ui-green)',
  idea: 'var(--ui-yellow)',
  insight: 'var(--ui-yellow)',
  question: 'var(--ui-cyan)',
  risk: 'var(--ui-red)',
  surface: 'var(--ui-cyan)',
  system: 'var(--ui-blue)',
  task: 'var(--ui-accent)'
}

export const accentForKind = (kind?: string): string =>
  (kind ? KIND_ACCENTS[kind.trim().toLowerCase()] : undefined) ?? 'var(--ui-accent)'

/* ------------------------------------------------------------------ *
 * Text fitting — measurement-free, deterministic, SSR/jsdom safe.
 * ------------------------------------------------------------------ */

const AVG_GLYPH = 0.56

/** Wrap a label into at most `maxLines` lines that fit `maxWidth` px. */
export function fitLabel(label: string, maxWidth: number, fontSize: number, maxLines = 2): string[] {
  const perLine = Math.max(4, Math.floor(maxWidth / (fontSize * AVG_GLYPH)))
  const words = label.split(/\s+/).filter(Boolean)
  const lines: string[] = []
  let current = ''

  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word

    if (candidate.length <= perLine) {
      current = candidate

      continue
    }

    if (current) {
      lines.push(current)
    }

    current = word.length > perLine ? `${word.slice(0, perLine - 1)}…` : word

    if (lines.length === maxLines) {
      break
    }
  }

  if (current && lines.length < maxLines) {
    lines.push(current)
  }

  if (lines.length === 0) {
    return ['']
  }

  if (lines.length === maxLines && words.join(' ').length > lines.join(' ').length) {
    const last = lines[maxLines - 1] ?? ''

    lines[maxLines - 1] = last.length > perLine - 1 ? `${last.slice(0, perLine - 1)}…` : `${last}…`
  }

  return lines
}

/* ------------------------------------------------------------------ *
 * Edge routing — a curve that leaves and enters node borders cleanly.
 * ------------------------------------------------------------------ */

/** Clip a ray from a node centre to the node's rounded-rect border. */
export function borderPoint(from: Point, to: Point): Point {
  const dx = to.x - from.x
  const dy = to.y - from.y

  if (dx === 0 && dy === 0) {
    return { x: from.x + NODE_HALF_W, y: from.y }
  }

  const scale = Math.min(
    dx === 0 ? Number.POSITIVE_INFINITY : (NODE_HALF_W + 4) / Math.abs(dx),
    dy === 0 ? Number.POSITIVE_INFINITY : (NODE_HALF_H + 4) / Math.abs(dy)
  )

  return { x: from.x + dx * scale, y: from.y + dy * scale }
}

interface RoutedEdge {
  d: string
  label?: string
  labelPoint: Point
}

/**
 * Quadratic curve bowed perpendicular to the chord. `bow` is signed per
 * parallel edge so multi-edges between the same pair fan out instead of
 * stacking — the main defence against 40-node spaghetti.
 */
export function routeEdge(source: Point, target: Point, bow: number): RoutedEdge {
  const a = borderPoint(source, target)
  const b = borderPoint(target, source)
  const midX = (a.x + b.x) / 2
  const midY = (a.y + b.y) / 2
  const dx = b.x - a.x
  const dy = b.y - a.y
  const length = Math.hypot(dx, dy) || 1
  const offset = bow * Math.min(46, 12 + length * 0.09)
  const cx = midX + (-dy / length) * offset
  const cy = midY + (dx / length) * offset

  return {
    d: `M ${a.x.toFixed(2)} ${a.y.toFixed(2)} Q ${cx.toFixed(2)} ${cy.toFixed(2)} ${b.x.toFixed(2)} ${b.y.toFixed(2)}`,
    // Point on the quadratic at t = 0.5.
    labelPoint: { x: 0.25 * a.x + 0.5 * cx + 0.25 * b.x, y: 0.25 * a.y + 0.5 * cy + 0.25 * b.y }
  }
}

/** Assign each edge a signed bow index so parallel/antiparallel pairs separate. */
export function bowFactors(edges: WorkbenchEdge[]): Record<string, number> {
  const seen = new Map<string, number>()
  const out: Record<string, number> = {}

  for (const edge of edges) {
    const key = [edge.from, edge.to].sort().join('\u0000')
    const index = seen.get(key) ?? 0

    seen.set(key, index + 1)
    // 0 -> 0.45, 1 -> -0.45, 2 -> 0.9, 3 -> -0.9 …  never dead-straight,
    // a gentle constant bow reads far better than a naive line.
    out[edge.id] = (index % 2 === 0 ? 1 : -1) * (0.45 + Math.floor(index / 2) * 0.45)
  }

  return out
}

/* ------------------------------------------------------------------ */

const degreeMap = (nodes: WorkbenchNode[], edges: WorkbenchEdge[]): Record<string, number> => {
  const degrees: Record<string, number> = Object.fromEntries(nodes.map(node => [node.id, 0]))

  for (const edge of edges) {
    if (edge.from in degrees) {
      degrees[edge.from] += 1
    }

    if (edge.to in degrees) {
      degrees[edge.to] += 1
    }
  }

  return degrees
}

/**
 * Map a client (viewport) point into canvas/world units.
 *
 * Pure and DOM-free so it is unit-testable: the caller supplies the SVG's
 * bounding rect. `preserveAspectRatio` defaults to `xMidYMid meet`, so the
 * viewBox is letterboxed inside the element — the scale is the SMALLER of the
 * two ratios and the leftover is split evenly as padding.
 *
 * The camera makes this correct when the view is zoomed or panned: the SVG is
 * showing a WINDOW of the world, so element pixels map through that window,
 * not through the full world. Every caller must pass the live camera or drag
 * and click-to-select land on the wrong node.
 */
export function clientToCanvas(
  client: Point,
  rect: { height: number; left: number; top: number; width: number },
  viewBox: { height: number; width: number },
  camera: WorkbenchCamera = IDENTITY_CAMERA
): Point {
  if (!rect.width || !rect.height || !viewBox.width || !viewBox.height) {
    return { x: client.x - rect.left, y: client.y - rect.top }
  }

  const safe = clampCamera(camera, viewBox)
  const view = visibleSize(safe, viewBox)

  const scale = Math.min(rect.width / view.width, rect.height / view.height)
  const padX = (rect.width - view.width * scale) / 2
  const padY = (rect.height - view.height * scale) / 2

  return {
    x: safe.x + (client.x - rect.left - padX) / scale,
    y: safe.y + (client.y - rect.top - padY) / scale
  }
}

/** Keep a dragged node's centre fully on canvas. */
export function clampToCanvas(point: Point, width: number, height: number): Point {
  return {
    x: Math.min(Math.max(point.x, NODE_HALF_W), Math.max(NODE_HALF_W, width - NODE_HALF_W)),
    y: Math.min(Math.max(point.y, NODE_HALF_H), Math.max(NODE_HALF_H, height - NODE_HALF_H))
  }
}

export default function MapRenderer({
  artifact,
  height,
  onNodePinned,
  positions,
  width
}: MapRendererProps) {
  const { edges, nodes } = artifact.payload
  const bows = useMemo(() => bowFactors(edges), [edges])
  const degrees = useMemo(() => degreeMap(nodes, edges), [edges, nodes])
  const maxDegree = useMemo(() => Math.max(1, ...Object.values(degrees)), [degrees])
  const dense = nodes.length > 24
  const selected = useStore($workbenchSelection)

  // What the ASSISTANT is pointing at, written by the `focus` voice tool.
  // Distinct from `selected`, which is what the USER clicked. Passing the live
  // node ids drops a focus whose node a redraw deleted — view_state survives
  // semantic updates untouched, so the old id lingers otherwise.
  const focused = focusedNodeId(
    artifact.view_state,
    nodes.map(node => node.id)
  )

  // Escape clears the pointing gesture — the same affordance as everywhere
  // else in the app, and the only way to say "I'm not pointing at anything"
  // without hunting for empty canvas.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        clearWorkbenchSelection()
      }
    }

    window.addEventListener('keydown', onKeyDown)

    return () => {
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [])

  const selectNode = useCallback((event: React.MouseEvent, nodeId: string) => {
    // Stop the background handler from immediately clearing what we just set.
    event.stopPropagation()
    setWorkbenchSelection(nodeId)
  }, [])

  const svgRef = useRef<SVGSVGElement | null>(null)
  const gestureRef = useRef<null | { grab: Point; nodeId: string; origin: Point }>(null)
  const dragOverride = useStore($workbenchDragOverride)
  const draggingNode = useStore($workbenchDraggingNode)
  const draggable = typeof onNodePinned === 'function'

  // Drag positions are applied at PAINT time, on top of whatever the layout
  // engine produced. The layout itself is never frozen by a drag.
  const paintPositions = useMemo(() => {
    if (Object.keys(dragOverride).length === 0) {
      return positions
    }

    const merged: Record<string, Point> = { ...positions }

    for (const [id, point] of Object.entries(dragOverride)) {
      if (id in merged) {
        merged[id] = point
      }
    }

    return merged
  }, [dragOverride, positions])

  const toCanvas = useCallback(
    (clientX: number, clientY: number): Point => {
      const rect = svgRef.current?.getBoundingClientRect()

      if (!rect) {
        return { x: clientX, y: clientY }
      }

      return clientToCanvas(
        { x: clientX, y: clientY },
        rect,
        { height, width },
        // Read the LIVE camera rather than closing over it: a stale camera
        // here sends the dragged node to the wrong world point.
        $workbenchCamera.get()
      )
    },
    [height, width]
  )

  const handlePointerDown = useCallback(
    (nodeId: string) => (event: ReactPointerEvent<SVGGElement>) => {
      if (!draggable || event.button !== 0) {
        return
      }

      const origin = paintPositions[nodeId]

      if (!origin) {
        return
      }

      // Do NOT preventDefault/stopPropagation on down: Track A's click and
      // selection handling must still see the event. A drag only asserts
      // itself once the pointer actually moves.
      gestureRef.current = {
        grab: toCanvas(event.clientX, event.clientY),
        nodeId,
        origin
      }
      event.currentTarget.setPointerCapture?.(event.pointerId)
    },
    [draggable, paintPositions, toCanvas]
  )

  const handlePointerMove = useCallback(
    (event: ReactPointerEvent<SVGGElement>) => {
      const gesture = gestureRef.current

      if (!gesture) {
        return
      }

      const now = toCanvas(event.clientX, event.clientY)

      const next = clampToCanvas(
        {
          x: gesture.origin.x + (now.x - gesture.grab.x),
          y: gesture.origin.y + (now.y - gesture.grab.y)
        },
        width,
        height
      )

      // Purely local: no await, no gateway, no model. This is the whole point.
      if ($workbenchDraggingNode.get() !== gesture.nodeId) {
        $workbenchDraggingNode.set(gesture.nodeId)
      }

      setWorkbenchDragOverride(gesture.nodeId, next)
    },
    [height, toCanvas, width]
  )

  const endGesture = useCallback(
    (event: ReactPointerEvent<SVGGElement>) => {
      const gesture = gestureRef.current

      gestureRef.current = null
      event.currentTarget.releasePointerCapture?.(event.pointerId)

      if (!gesture) {
        return
      }

      const moved = $workbenchDragOverride.get()[gesture.nodeId]

      $workbenchDraggingNode.set(null)

      if (!moved) {
        // A press with no movement is a click, not a drag: leave it to Track A.
        return
      }

      // Persist AFTER the paint; the override stays until the caller confirms
      // (or rolls back), so the node never snaps back mid-write.
      onNodePinned?.(gesture.nodeId, moved)
    },
    [onNodePinned]
  )

  // --- camera ---------------------------------------------------------
  //
  // Pan/zoom are PRESENTATION only: they change the viewBox and nothing else.
  // Node positions, pins and the spatial language handed to the model all
  // stay in world units, so the model's map of the canvas does not move when
  // the user zooms.

  const camera = useStore($workbenchCamera)
  const panRef = useRef<null | { camera: WorkbenchCamera; origin: Point; panning: boolean }>(null)

  useEffect(() => {
    const svg = svgRef.current

    if (!svg) {
      return
    }

    // Registered natively (not via onWheel) because React's synthetic wheel
    // listener is passive: preventDefault there is a no-op and the page
    // scrolls behind the canvas.
    const onWheel = (event: WheelEvent) => {
      const intent = wheelIntent(event)

      if (intent === 'none') {
        return
      }

      event.preventDefault()

      const world = { height, width }

      if (intent === 'zoom') {
        const focal = clientToCanvas(
          { x: event.clientX, y: event.clientY },
          svg.getBoundingClientRect(),
          world,
          $workbenchCamera.get()
        )

        setWorkbenchCamera(
          zoomAt(
            $workbenchCamera.get(),
            world,
            focal,
            zoomStepFromWheel($workbenchCamera.get().zoom, event.deltaY)
          )
        )

        return
      }

      setWorkbenchCamera(
        panCamera($workbenchCamera.get(), world, { x: -event.deltaX, y: -event.deltaY })
      )
    }

    svg.addEventListener('wheel', onWheel, { passive: false })

    return () => {
      svg.removeEventListener('wheel', onWheel)
    }
  }, [height, width])

  const handleCanvasPointerDown = useCallback((event: ReactPointerEvent<SVGSVGElement>) => {
    if (event.button !== 0) {
      return
    }

    panRef.current = {
      camera: $workbenchCamera.get(),
      origin: { x: event.clientX, y: event.clientY },
      panning: false
    }
  }, [])

  const handleCanvasPointerMove = useCallback(
    (event: ReactPointerEvent<SVGSVGElement>) => {
      const pan = panRef.current

      // A node drag owns the pointer: never pan underneath it.
      if (!pan || gestureRef.current) {
        return
      }

      const current = { x: event.clientX, y: event.clientY }

      if (!pan.panning && !isPanGesture(pan.origin, current)) {
        return
      }

      pan.panning = true

      const rect = svgRef.current?.getBoundingClientRect()
      // Convert element pixels to on-screen pixels of the letterboxed viewBox
      // so the content sticks to the pointer at any zoom.
      const scale = rect ? Math.min(rect.width / width, rect.height / height) : 1

      setWorkbenchCamera(
        panCamera(
          pan.camera,
          { height, width },
          { x: (current.x - pan.origin.x) / (scale || 1), y: (current.y - pan.origin.y) / (scale || 1) }
        )
      )
    },
    [height, width]
  )

  const endCanvasPan = useCallback(() => {
    panRef.current = null
  }, [])

  return (
    <svg
      aria-label="Live ideation map"
      className="min-h-0 flex-1"
      data-testid="workbench-canvas"
      onClick={() => {
        // A pan is not a click: only a press that never moved clears the
        // user's referent.
        if (panRef.current?.panning) {
          return
        }

        clearWorkbenchSelection()
      }}
      onPointerCancel={endCanvasPan}
      onPointerDown={handleCanvasPointerDown}
      onPointerMove={handleCanvasPointerMove}
      onPointerUp={endCanvasPan}
      ref={svgRef}
      role="img"
      style={{ touchAction: 'none' }}
      viewBox={cameraViewBox(camera, { height, width })}
    >
      <defs>
        <pattern height="32" id="workbench-grid" patternUnits="userSpaceOnUse" width="32">
          <path
            d="M 32 0 L 0 0 0 32"
            fill="none"
            stroke="var(--ui-stroke-secondary)"
            strokeWidth="0.5"
          />
        </pattern>

        <radialGradient cx="50%" cy="42%" id="workbench-vignette" r="78%">
          <stop offset="0%" stopColor="var(--ui-bg-elevated)" stopOpacity="0.55" />
          <stop offset="100%" stopColor="var(--ui-bg-elevated)" stopOpacity="0" />
        </radialGradient>

        <marker
          id="workbench-arrow"
          markerHeight="7"
          markerUnits="userSpaceOnUse"
          markerWidth="7"
          orient="auto-start-reverse"
          refX="6.2"
          refY="3.5"
        >
          <path d="M 0 0.6 L 6.6 3.5 L 0 6.4 z" fill="var(--ui-stroke-primary)" />
        </marker>

        <filter height="220%" id="workbench-node-shadow" width="180%" x="-40%" y="-60%">
          <feDropShadow
            dy="1.5"
            floodColor="var(--ui-bg-primary)"
            floodOpacity="0.5"
            stdDeviation="2.5"
          />
        </filter>

        <style>{`
          .wb-node { transition: transform 420ms cubic-bezier(.22,1,.36,1), opacity 260ms ease; }
          .wb-node-hit { cursor: pointer; }
          .wb-selected-ring { transition: opacity 160ms ease; }
          /* The assistant's referent. Deliberately distinct from the user's
             selection ring: a soft pulse reads as "I am talking about this"
             rather than "you clicked this". */
          .wb-focus-ring { animation: wb-focus-pulse 1.8s ease-in-out infinite; }
          @keyframes wb-focus-pulse {
            0%, 100% { opacity: 0.30; }
            50%      { opacity: 0.85; }
          }
          @media (prefers-reduced-motion: reduce) {
            .wb-focus-ring { animation: none; opacity: 0.7; }
          }
          .wb-edge { transition: d 420ms cubic-bezier(.22,1,.36,1), opacity 260ms ease; }
          .wb-enter { animation: wb-pop 340ms cubic-bezier(.22,1,.36,1) both; }
          @keyframes wb-pop { from { opacity: 0 } to { opacity: 1 } }
          @media (prefers-reduced-motion: reduce) {
            .wb-node, .wb-edge, .wb-enter { transition: none; animation: none; }
          }
        `}</style>
      </defs>

      <rect fill="url(#workbench-grid)" height="100%" opacity="0.4" width="100%" />
      <rect fill="url(#workbench-vignette)" height="100%" width="100%" />

      {/* Edges first so nodes always sit above the wiring. */}
      <g fill="none">
        {edges.map(edge => {
          const from = paintPositions[edge.from]
          const to = paintPositions[edge.to]

          if (!from || !to) {
            return null
          }

          const route = routeEdge(from, to, bows[edge.id] ?? 0.45)
          const label = dense ? undefined : edge.label
          const labelWidth = label ? label.length * TYPE_EDGE * AVG_GLYPH + 10 : 0

          return (
            <g className="wb-enter" key={edge.id}>
              <path
                className="wb-edge"
                d={route.d}
                markerEnd="url(#workbench-arrow)"
                opacity="0.75"
                stroke="var(--ui-stroke-primary)"
                strokeLinecap="round"
                strokeWidth="1.25"
              />
              {label ? (
                <g>
                  {/* Halo plate keeps edge labels legible over the wire. */}
                  <rect
                    fill="var(--ui-bg-primary)"
                    height={TYPE_EDGE + 7}
                    opacity="0.92"
                    rx={(TYPE_EDGE + 7) / 2}
                    width={labelWidth}
                    x={route.labelPoint.x - labelWidth / 2}
                    y={route.labelPoint.y - (TYPE_EDGE + 7) / 2}
                  />
                  <text
                    dominantBaseline="middle"
                    fill="var(--ui-text-tertiary)"
                    fontSize={TYPE_EDGE}
                    letterSpacing="0.02em"
                    textAnchor="middle"
                    x={route.labelPoint.x}
                    y={route.labelPoint.y + 0.5}
                  >
                    {label}
                  </text>
                </g>
              ) : null}
            </g>
          )
        })}
      </g>

      {nodes.map(node => {
        const point = paintPositions[node.id]

        if (!point) {
          return null
        }

        const accent = accentForKind(node.kind)

        const rings = nodeRingState(node.id, {
          durable: focused,
          selected
        })

        // Visual hierarchy: well-connected nodes read louder.
        const weight = (degrees[node.id] ?? 0) / maxDegree
        const lines = fitLabel(node.label, NODE_WIDTH - 22, TYPE_LABEL, node.kind ? 2 : 3)
        const textTop = NODE_HALF_H - ((lines.length - 1) * (TYPE_LABEL + 3)) / 2 - (node.kind ? 5 : 0)

        return (
          <g
            aria-label={node.label}
            aria-pressed={rings.selected}
            className={
              draggingNode === node.id ? 'wb-enter' : 'wb-node wb-node-hit wb-enter'
            }
            data-selected={rings.selected ? 'true' : undefined}
            data-testid={`workbench-node-${node.id}`}
            key={node.id}
            onClick={event => {
              selectNode(event, node.id)
            }}
            onPointerCancel={draggable ? endGesture : undefined}
            onPointerDown={draggable ? handlePointerDown(node.id) : undefined}
            onPointerMove={draggable ? handlePointerMove : undefined}
            onPointerUp={draggable ? endGesture : undefined}
            role="button"
            style={draggable ? { cursor: draggingNode === node.id ? 'grabbing' : 'grab' } : undefined}
            transform={`translate(${(point.x - NODE_HALF_W).toFixed(2)} ${(point.y - NODE_HALF_H).toFixed(2)})`}
          >
            <rect
              fill="var(--ui-bg-elevated)"
              filter="url(#workbench-node-shadow)"
              height={NODE_HEIGHT}
              rx={NODE_RADIUS}
              stroke="var(--ui-stroke-tertiary)"
              strokeWidth="1"
              width={NODE_WIDTH}
            />
            {/* Accent wash + spine carry `kind` without shouting. */}
            <rect
              fill={accent}
              height={NODE_HEIGHT}
              opacity={(0.05 + weight * 0.07).toFixed(3)}
              rx={NODE_RADIUS}
              width={NODE_WIDTH}
            />
            <rect
              fill={accent}
              height={NODE_HEIGHT - 14}
              opacity={(0.55 + weight * 0.45).toFixed(3)}
              rx="1.5"
              width="3"
              x="0.5"
              y="7"
            />

            {/* The assistant's referent, drawn outside the selection ring so
                "I'm talking about this" and "you clicked this" can both be
                true at once and stay visually distinct. */}
            {rings.durable ? (
              <rect
                className="wb-focus-ring"
                fill="none"
                height={NODE_HEIGHT + 18}
                pointerEvents="none"
                rx={NODE_RADIUS + 9}
                stroke="var(--ui-cyan)"
                strokeDasharray="6 4"
                strokeWidth="2"
                width={NODE_WIDTH + 18}
                x="-9"
                y="-9"
              />
            ) : null}

            {/* Selection ring: theme tokens only, drawn outside the box so it
                never competes with the kind accent. */}
            {rings.selected ? (
              <>
                <rect
                  className="wb-selected-ring"
                  fill="none"
                  height={NODE_HEIGHT + 10}
                  rx={NODE_RADIUS + 5}
                  stroke="var(--ui-accent)"
                  strokeWidth="2"
                  width={NODE_WIDTH + 10}
                  x="-5"
                  y="-5"
                />
                <rect
                  className="wb-selected-ring"
                  fill="var(--ui-accent)"
                  height={NODE_HEIGHT + 10}
                  opacity="0.12"
                  rx={NODE_RADIUS + 5}
                  width={NODE_WIDTH + 10}
                  x="-5"
                  y="-5"
                />
              </>
            ) : null}

            <text
              fill="var(--ui-text-primary)"
              fontSize={TYPE_LABEL}
              fontWeight="600"
              textAnchor="middle"
              x={NODE_HALF_W}
            >
              {lines.map((line, index) => (
                <tspan
                  dominantBaseline="middle"
                  key={line + String(index)}
                  x={NODE_HALF_W}
                  y={textTop + index * (TYPE_LABEL + 3)}
                >
                  {line}
                </tspan>
              ))}
            </text>

            {node.kind ? (
              <text
                dominantBaseline="middle"
                fill="var(--ui-text-quaternary)"
                fontSize={TYPE_KIND}
                fontWeight="600"
                letterSpacing="0.09em"
                textAnchor="middle"
                x={NODE_HALF_W}
                y={NODE_HEIGHT - 12}
              >
                {node.kind.toUpperCase()}
              </text>
            ) : null}
          </g>
        )
      })}
    </svg>
  )
}
