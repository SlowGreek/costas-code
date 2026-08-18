import { useMemo } from 'react'

import type { WorkbenchArtifact, WorkbenchEdge, WorkbenchNode } from '@/store/workbench'

export type Point = { x: number; y: number }

interface MapRendererProps {
  artifact: WorkbenchArtifact
  height: number
  positions: Record<string, Point>
  width: number
}

/* ------------------------------------------------------------------ *
 * Design tokens (geometry + type scale). Colour comes from --ui-*.
 * ------------------------------------------------------------------ */

export const NODE_WIDTH = 152
export const NODE_HEIGHT = 58
const NODE_RADIUS = 12
const NODE_HALF_W = NODE_WIDTH / 2
const NODE_HALF_H = NODE_HEIGHT / 2

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

export default function MapRenderer({ artifact, height, positions, width }: MapRendererProps) {
  const { edges, nodes } = artifact.payload
  const bows = useMemo(() => bowFactors(edges), [edges])
  const degrees = useMemo(() => degreeMap(nodes, edges), [edges, nodes])
  const maxDegree = useMemo(() => Math.max(1, ...Object.values(degrees)), [degrees])
  const dense = nodes.length > 24

  return (
    <svg
      aria-label="Live ideation map"
      className="min-h-0 flex-1"
      data-testid="workbench-canvas"
      role="img"
      viewBox={`0 0 ${width} ${height}`}
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
          const from = positions[edge.from]
          const to = positions[edge.to]

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
        const point = positions[node.id]

        if (!point) {
          return null
        }

        const accent = accentForKind(node.kind)
        // Visual hierarchy: well-connected nodes read louder.
        const weight = (degrees[node.id] ?? 0) / maxDegree
        const lines = fitLabel(node.label, NODE_WIDTH - 22, TYPE_LABEL, node.kind ? 2 : 3)
        const textTop = NODE_HALF_H - ((lines.length - 1) * (TYPE_LABEL + 3)) / 2 - (node.kind ? 5 : 0)

        return (
          <g
            className="wb-node wb-enter"
            key={node.id}
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
