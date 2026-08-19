import { useStore } from '@nanostores/react'
import { useEffect, useMemo, useRef, useState } from 'react'

import { useI18n } from '@/i18n'
import {
  applyUserPins,
  type DirectManipulationViewState,
  pruneViewStateToGraph,
  visibleGraph,
  withUserPin
} from '@/lib/workbench-edits'
import { placeWorkbenchNodes } from '@/lib/workbench-layout'
import type { Point } from '@/lib/workbench-node-box'
import { $gateway } from '@/store/gateway'
import { $activeSessionId } from '@/store/session'
import {
  $workbenchArtifact,
  $workbenchDrawing,
  $workbenchError,
  resetWorkbenchCameraFor,
  setWorkbenchArtifact,
  setWorkbenchDragOverride,
  setWorkbenchLayout,
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

  // AUTO-POSITIONS: whatever the layout engine produced. These are what gets
  // persisted into `view_state.positions`, and the layout stays free to move
  // them on every payload change.
  const autoPositions = useMemo(
    () =>
      artifact
        ? placeWorkbenchNodes(
            visibleGraph(artifact.payload, artifact.view_state),
            artifact.view_state.positions ?? {},
            size.width,
            size.height
          )
        : {},
    [artifact, size.height, size.width]
  )

  // USER PINS are overlaid AFTER layout (contract section 7). A different
  // concept from auto-positions, stored in a different key, never inferred
  // from the presence of a persisted position.
  const positions = useMemo(
    () => applyUserPins(autoPositions, artifact?.view_state),
    [artifact?.view_state, autoPositions]
  )

  // The camera belongs to the DRAWING, not to the pane. A different artifact
  // resets the view; the same artifact redrawing keeps it, so a `visualize`
  // never yanks the user back to fit mid-conversation.
  useEffect(() => {
    resetWorkbenchCameraFor(artifact?.artifact_id ?? null)
  }, [artifact?.artifact_id])

  // Publish where things actually ended up so the ONE context-freshness owner
  // can describe the canvas to the voice model without recomputing layout.
  // Deliberately AFTER pins are applied: the model must describe what the user
  // is actually looking at, not where the layout engine would have put things.
  //
  // WORLD units, deliberately: the camera must NOT leak in here or the
  // assistant's spatial language would change every time the user zoomed.
  useEffect(() => {
    setWorkbenchLayout(
      artifact && artifact.kind !== 'sketch' && Object.keys(positions).length > 0
        ? { height: size.height, positions, width: size.width }
        : null
    )
  }, [artifact, positions, size.height, size.width])

  useEffect(() => {
    const gateway = $gateway.get()
    const persisted = artifact?.view_state.positions ?? {}

    if (!gateway || !runtimeSessionId || !artifact || samePositions(persisted, autoPositions)) {
      return
    }

    let stale = false

    void gateway
      .request<{ artifact: WorkbenchArtifact }>('artifact.update_view', {
        session_id: runtimeSessionId,
        artifact_id: artifact.artifact_id,
        view_state: {
          ...artifact.view_state,
          positions: autoPositions,
          // Legacy bookkeeping only - NOT user intent. Real user pins live in
          // `user_pins` and are written by the drag path alone.
          pinned: Object.keys(autoPositions)
        },
        expected_rev: artifact.view_rev,
        updated_by: 'renderer'
      })
      .then(result => {
        // Only repaint if the SESSION on screen is still the one this persist
        // was started for. Without that check a write that began before a chat
        // switch lands afterwards and re-instates the previous chat's drawing
        // — the "workbench sticks when switching chats" report. The cleanup
        // flag alone is not enough: hydrate clearing the atom does not re-run
        // this effect, so nothing ever sets `stale`. Comparing artifact ids
        // would not work either; every session's artifact is `map.main`.
        if (!stale && $activeSessionId.get() === runtimeSessionId) {
          setWorkbenchArtifact(result.artifact)
        }
      })
      .catch(() => undefined)

    return () => {
      stale = true
    }
  }, [artifact, autoPositions, runtimeSessionId])

  // A drag has ALREADY painted by the time this runs. It writes the pin
  // optimistically and rolls the local override back only if the write fails.
  const handleNodePinned = (nodeId: string, point: Point) => {
    const gateway = $gateway.get()
    const current = $workbenchArtifact.get()

    if (!gateway || !runtimeSessionId || !current) {
      setWorkbenchDragOverride(nodeId, null)

      return
    }

    const nextViewState = pruneViewStateToGraph(
      withUserPin(current.view_state as DirectManipulationViewState, nodeId, point),
      current.payload
    )

    void gateway
      .request<{ artifact: WorkbenchArtifact }>('artifact.update_view', {
        session_id: runtimeSessionId,
        artifact_id: current.artifact_id,
        view_state: nextViewState,
        expected_rev: current.view_rev,
        updated_by: 'user-drag'
      })
      .then(result => {
        // Same session guard as the auto-persist above: a drag that resolves
        // after the user switched chats must not repaint the old drawing.
        if ($activeSessionId.get() === runtimeSessionId) {
          setWorkbenchArtifact(result.artifact)
        }

        // The pin is durable now, so the local override is redundant.
        setWorkbenchDragOverride(nodeId, null)
      })
      .catch(() => {
        // Rollback: drop the optimistic override rather than lying about a
        // saved pin.
        setWorkbenchDragOverride(nodeId, null)
      })
  }

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
            artifact={{
              ...artifact,
              payload: visibleGraph(artifact.payload, artifact.view_state)
            }}
            height={size.height}
            onNodePinned={handleNodePinned}
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
