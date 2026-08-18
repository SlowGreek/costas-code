import { useStore } from '@nanostores/react'
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'

import { onGatewayEvent } from '@/contrib/events'
import { placeWorkbenchNodes } from '@/lib/workbench-layout'
import { $gateway } from '@/store/gateway'
import { $activeSessionId } from '@/store/session'
import {
  $workbenchArtifact,
  $workbenchError,
  setWorkbenchArtifact,
  type WorkbenchArtifact
} from '@/store/workbench'

const NODE_WIDTH = 136
const NODE_HEIGHT = 52
const DEFAULT_SIZE = { height: 420, width: 720 }

const samePositions = (
  left: Record<string, { x: number; y: number }>,
  right: Record<string, { x: number; y: number }>
) =>
  Object.keys(left).length === Object.keys(right).length &&
  Object.entries(left).every(([id, point]) => right[id]?.x === point.x && right[id]?.y === point.y)

export function WorkbenchPane() {
  const artifact = useStore($workbenchArtifact)
  const error = useStore($workbenchError)
  const runtimeSessionId = useStore($activeSessionId)
  const hostRef = useRef<HTMLDivElement | null>(null)
  const renderedSessionRef = useRef(runtimeSessionId)
  const [size, setSize] = useState(DEFAULT_SIZE)

  useEffect(() => {
    const host = hostRef.current

    if (!host) {
      return
    }

    const observer = new ResizeObserver(entries => {
      const rect = entries[0]?.contentRect

      if (rect?.width && rect?.height) {
        setSize({ height: rect.height, width: rect.width })
      }
    })

    observer.observe(host)

    return () => observer.disconnect()
  }, [])

  useLayoutEffect(() => {
    if (renderedSessionRef.current !== runtimeSessionId) {
      // The atom is only a cache; never paint session A's graph while session B
      // is becoming active. Layout effect clears it before the browser paints.
      renderedSessionRef.current = runtimeSessionId
      setWorkbenchArtifact(null)
    }
  }, [runtimeSessionId])

  useEffect(() => {
    const gateway = $gateway.get()

    if (!gateway || !runtimeSessionId) {
      return
    }

    let stale = false

    void gateway
      .request<{ artifacts?: WorkbenchArtifact[] }>('artifact.list', { session_id: runtimeSessionId })
      .then(result => {
        const current = result.artifacts?.find(item => item.artifact_id === 'map.main')

        if (!stale && current) {
          setWorkbenchArtifact(current)
        }
      })
      .catch(() => undefined)

    return () => {
      stale = true
    }
  }, [runtimeSessionId])

  useEffect(
    () =>
      onGatewayEvent('artifact.updated', event => {
        if (event.session_id !== runtimeSessionId) {
          return
        }

        const next = (event.payload as { artifact?: WorkbenchArtifact } | undefined)?.artifact

        if (next?.artifact_id === 'map.main') {
          setWorkbenchArtifact(next)
        }
      }),
    [runtimeSessionId]
  )

  const positions = useMemo(
    () =>
      artifact
        ? placeWorkbenchNodes(
            artifact.payload,
            artifact.view_state.positions ?? {},
            size.width,
            size.height
          )
        : {},
    [artifact, size.height, size.width]
  )

  useEffect(() => {
    const gateway = $gateway.get()
    const persisted = artifact?.view_state.positions ?? {}

    if (!gateway || !runtimeSessionId || !artifact || samePositions(persisted, positions)) {
      return
    }

    let stale = false

    void gateway
      .request<{ artifact: WorkbenchArtifact }>('artifact.update_view', {
        session_id: runtimeSessionId,
        artifact_id: artifact.artifact_id,
        view_state: {
          ...artifact.view_state,
          positions,
          pinned: Object.keys(positions)
        },
        expected_rev: artifact.view_rev,
        updated_by: 'renderer'
      })
      .then(result => {
        if (!stale) {
          setWorkbenchArtifact(result.artifact)
        }
      })
      .catch(() => undefined)

    return () => {
      stale = true
    }
  }, [artifact, positions, runtimeSessionId])

  return (
    <div className="flex size-full min-h-0 flex-col" ref={hostRef}>
      <div className="flex h-9 shrink-0 items-center justify-between border-b border-(--ui-stroke-secondary) px-3 text-xs">
        <span className="font-medium text-foreground">Ideation workbench</span>
        <span className="text-(--ui-text-quaternary)">
          {artifact ? `map.main · rev ${artifact.semantic_rev}` : 'ambient · waiting'}
        </span>
      </div>

      {error ? (
        <div className="border-b border-destructive/20 bg-destructive/5 px-3 py-2 text-xs text-destructive">
          Ambient update paused: {error}
        </div>
      ) : null}

      {!artifact || artifact.payload.nodes.length === 0 ? (
        <div className="flex flex-1 items-center justify-center p-6 text-center text-sm text-(--ui-text-tertiary)">
          Start talking. The map will build itself.
        </div>
      ) : (
        <svg
          aria-label="Live ideation map"
          className="min-h-0 flex-1"
          data-testid="workbench-canvas"
          role="img"
          viewBox={`0 0 ${size.width} ${size.height}`}
        >
          <defs>
            <pattern height="32" id="workbench-grid" patternUnits="userSpaceOnUse" width="32">
              <path d="M 32 0 L 0 0 0 32" fill="none" stroke="var(--ui-stroke-secondary)" strokeWidth="0.5" />
            </pattern>
          </defs>
          <rect fill="url(#workbench-grid)" height="100%" opacity="0.45" width="100%" />

          {artifact.payload.edges.map(edge => {
            const from = positions[edge.from]
            const to = positions[edge.to]

            if (!from || !to) {
              return null
            }

            return (
              <g key={edge.id}>
                <line
                  stroke="var(--ui-text-quaternary)"
                  strokeWidth="1.5"
                  x1={from.x}
                  x2={to.x}
                  y1={from.y}
                  y2={to.y}
                />
                {edge.label ? (
                  <text
                    fill="var(--ui-text-tertiary)"
                    fontSize="10"
                    textAnchor="middle"
                    x={(from.x + to.x) / 2}
                    y={(from.y + to.y) / 2 - 6}
                  >
                    {edge.label}
                  </text>
                ) : null}
              </g>
            )
          })}

          {artifact.payload.nodes.map(node => {
            const point = positions[node.id]

            if (!point) {
              return null
            }

            return (
              <g key={node.id} transform={`translate(${point.x - NODE_WIDTH / 2} ${point.y - NODE_HEIGHT / 2})`}>
                <rect
                  fill="var(--ui-bg-secondary)"
                  height={NODE_HEIGHT}
                  rx="9"
                  stroke="var(--ui-accent)"
                  strokeWidth="1.5"
                  width={NODE_WIDTH}
                />
                <text fill="var(--ui-text-primary)" fontSize="11" fontWeight="600" textAnchor="middle" x={NODE_WIDTH / 2} y="22">
                  {node.label}
                </text>
                {node.kind ? (
                  <text fill="var(--ui-text-quaternary)" fontSize="8" textAnchor="middle" x={NODE_WIDTH / 2} y="38">
                    {node.kind}
                  </text>
                ) : null}
              </g>
            )
          })}
        </svg>
      )}
    </div>
  )
}
