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

import MapRenderer from './map/map-renderer'

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

  const renderArtifact = () => {
    if (!artifact) {
      return null
    }

    // TODO(integrator): when Agents B and C land their renderers, add these
    // imports at the top of this file and uncomment the cases below:
    //   import TimelineRenderer from './kinds/timeline-renderer'
    //   import QuadrantRenderer from './kinds/quadrant-renderer'
    //   import SketchRenderer from './sketch/sketch-renderer'
    switch (artifact.kind) {
      // case 'timeline': return <TimelineRenderer artifact={artifact} />   // Agent B
      // case 'quadrant': return <QuadrantRenderer artifact={artifact} />   // Agent B
      // case 'sketch':   return <SketchRenderer artifact={artifact} />     // Agent C
      default:
        return (
          <MapRenderer
            artifact={artifact}
            height={size.height}
            positions={positions}
            width={size.width}
          />
        )
    }
  }

  return (
    <div className="flex size-full min-h-0 flex-col" ref={hostRef}>
      <div className="flex h-9 shrink-0 items-center justify-between border-b border-(--ui-stroke-secondary) px-3 text-xs">
        <span className="font-medium tracking-tight text-foreground">Ideation workbench</span>
        <span className="font-mono text-[10px] tracking-wide text-(--ui-text-quaternary)">
          {artifact ? `map.main · rev ${artifact.semantic_rev}` : 'ambient · waiting'}
        </span>
      </div>

      {error ? (
        <div className="border-b border-destructive/20 bg-destructive/5 px-3 py-2 text-xs text-destructive">
          Ambient update paused: {error}
        </div>
      ) : null}

      {!artifact || artifact.payload.nodes.length === 0 ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-1 p-6 text-center">
          <span className="text-sm font-medium text-(--ui-text-secondary)">
            Start talking. The map will build itself.
          </span>
          <span className="text-xs text-(--ui-text-quaternary)">
            Ideas become nodes; relationships become edges.
          </span>
        </div>
      ) : (
        renderArtifact()
      )}
    </div>
  )
}
