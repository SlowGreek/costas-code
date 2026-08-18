import { useStore } from '@nanostores/react'
import { useEffect, useMemo, useRef, useState } from 'react'

import { useI18n } from '@/i18n'
import { placeWorkbenchNodes } from '@/lib/workbench-layout'
import { $gateway } from '@/store/gateway'
import { $activeSessionId } from '@/store/session'
import {
  $workbenchArtifact,
  $workbenchDrawing,
  $workbenchError,
  setWorkbenchArtifact,
  type WorkbenchArtifact,
  workbenchTrimNotice
} from '@/store/workbench'

import QuadrantRenderer from './kinds/quadrant-renderer'
import TimelineRenderer from './kinds/timeline-renderer'
import MapRenderer from './map/map-renderer'
import SketchRenderer from './sketch/sketch-renderer'

const DEFAULT_SIZE = { height: 420, width: 720 }

const samePositions = (
  left: Record<string, { x: number; y: number }>,
  right: Record<string, { x: number; y: number }>
) =>
  Object.keys(left).length === Object.keys(right).length &&
  Object.entries(left).every(([id, point]) => right[id]?.x === point.x && right[id]?.y === point.y)

export function WorkbenchPane() {
  const { t } = useI18n()
  const artifact = useStore($workbenchArtifact)
  const error = useStore($workbenchError)
  const drawing = useStore($workbenchDrawing)
  const runtimeSessionId = useStore($activeSessionId)
  const hostRef = useRef<HTMLDivElement | null>(null)
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

  // Fetching the artifact and subscribing to `artifact.updated` now live at app
  // level (see contrib/controller.tsx): the pane is not mounted until an
  // artifact exists, so a listener here could never observe the FIRST drawing.
  // The pane is a pure consumer of the atom.

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

    switch (artifact.kind) {
      case 'timeline':
        return <TimelineRenderer artifact={artifact} />

      case 'quadrant':
        return <QuadrantRenderer artifact={artifact} />

      case 'sketch':
        return <SketchRenderer artifact={artifact} />

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

  // Emptiness is per-kind: only `map` has nodes. Reading payload.nodes on a
  // timeline/quadrant/sketch artifact would wrongly show the waiting state
  // (or throw), so each kind reports its own emptiness.
  const isEmpty = (() => {
    if (!artifact) {
      return true
    }

    const payload = artifact.payload as {
      html?: unknown
      items?: unknown[]
      nodes?: unknown[]
    }

    switch (artifact.kind) {
      case 'quadrant':

      case 'timeline':
        return !payload.items?.length

      case 'sketch':
        return !payload.html

      default:
        return !payload.nodes?.length
    }
  })()

  const trimmed = workbenchTrimNotice(artifact)

  return (
    <div className="flex size-full min-h-0 flex-col" ref={hostRef}>
      <div className="flex h-9 shrink-0 items-center justify-between border-b border-(--ui-stroke-secondary) px-3 text-xs">
        <span className="font-medium tracking-tight text-foreground">{t.workbench.title}</span>
        <span className="flex items-center gap-2 font-mono text-[10px] tracking-wide text-(--ui-text-quaternary)">
          {drawing ? (
            // Non-blocking: it sits in the header chrome, so the existing
            // drawing below stays fully visible and interactive while the
            // diagrammer works.
            <span
              aria-live="polite"
              className="flex items-center gap-1 text-(--ui-text-tertiary)"
              data-testid="workbench-drawing"
            >
              <span
                aria-hidden="true"
                className="size-1.5 animate-pulse rounded-full bg-(--ui-text-tertiary)"
              />
              {t.workbench.drawing}
            </span>
          ) : null}
          {trimmed ? (
            <span
              data-testid="workbench-trimmed"
              title={t.workbench.trimmed(trimmed.shown, trimmed.total)}
            >
              {t.workbench.trimmed(trimmed.shown, trimmed.total)}
            </span>
          ) : null}
          <span>
            {artifact
              ? `${artifact.artifact_id} · ${artifact.kind} · rev ${artifact.semantic_rev}`
              : t.workbench.waiting}
          </span>
        </span>
      </div>

      {error ? (
        <div className="border-b border-destructive/20 bg-destructive/5 px-3 py-2 text-xs text-destructive">
          {t.workbench.paused}: {error}
        </div>
      ) : null}

      {isEmpty ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-1 p-6 text-center">
          <span className="text-sm font-medium text-(--ui-text-secondary)">
            {t.workbench.emptyTitle}
          </span>
          <span className="text-xs text-(--ui-text-quaternary)">{t.workbench.emptyBody}</span>
        </div>
      ) : (
        renderArtifact()
      )}
    </div>
  )
}
