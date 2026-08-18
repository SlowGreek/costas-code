import { atom } from 'nanostores'

export interface WorkbenchNode {
  id: string
  label: string
  kind?: string
}

export interface WorkbenchEdge {
  from: string
  id: string
  label?: string
  to: string
}

export interface WorkbenchGraph {
  edges: WorkbenchEdge[]
  nodes: WorkbenchNode[]
}

export interface WorkbenchViewState {
  pinned?: string[]
  positions?: Record<string, { x: number; y: number }>
  trimmed?: { shown: number; total: number }
  zoom?: number
}

export interface WorkbenchArtifact {
  artifact_id: string
  kind: string
  payload: WorkbenchGraph
  semantic_rev: number
  view_rev: number
  view_state: WorkbenchViewState
}

export const $workbenchArtifact = atom<null | WorkbenchArtifact>(null)
export const $workbenchError = atom<null | string>(null)
export const $workbenchVoiceActive = atom(false)

/**
 * Whether the diagrammer is mid-draw.
 *
 * Deliberately separate from `$workbenchArtifact`: the existing drawing must
 * stay on screen while the next one is being produced, so this is an overlay
 * signal, never a reason to blank the canvas.
 */
export const $workbenchDrawing = atom(false)

/**
 * Safety valve: a start event whose completion never arrives must not leave a
 * spinner up forever. The gateway emits both edges, but a dropped socket, a
 * crashed handler, or a session switch can swallow the second one.
 */
export const WORKBENCH_DRAWING_TIMEOUT_MS = 90_000

let drawingTimer: ReturnType<typeof setTimeout> | null = null

function clearDrawingTimer(): void {
  if (drawingTimer !== null) {
    clearTimeout(drawingTimer)
    drawingTimer = null
  }
}

export function setWorkbenchDrawing(drawing: boolean): void {
  clearDrawingTimer()

  if (drawing) {
    drawingTimer = setTimeout(() => {
      drawingTimer = null
      $workbenchDrawing.set(false)
    }, WORKBENCH_DRAWING_TIMEOUT_MS)
  }

  $workbenchDrawing.set(drawing)
}

/**
 * The honest "showing N of M" disclosure for an artifact, or null when nothing
 * was dropped. Lives in `view_state` because it describes what the canvas can
 * show, not what the ideas mean.
 */
export function workbenchTrimNotice(
  artifact: null | WorkbenchArtifact
): null | { shown: number; total: number } {
  const trimmed = artifact?.view_state?.trimmed

  if (
    !trimmed ||
    typeof trimmed.shown !== 'number' ||
    typeof trimmed.total !== 'number' ||
    trimmed.total <= trimmed.shown
  ) {
    return null
  }

  return { shown: trimmed.shown, total: trimmed.total }
}

export function setWorkbenchVoiceActive(active: boolean): void {
  $workbenchVoiceActive.set(active)
}

export function setWorkbenchArtifact(artifact: null | WorkbenchArtifact): void {
  $workbenchArtifact.set(artifact)

  if (artifact) {
    $workbenchError.set(null)
    // A drawing landing is itself proof the draw finished, even if the
    // completion event is lost.
    setWorkbenchDrawing(false)
  }
}

export function setWorkbenchError(error: null | string): void {
  $workbenchError.set(error)

  if (error) {
    setWorkbenchDrawing(false)
  }
}

export function resetWorkbenchForTests(): void {
  $workbenchArtifact.set(null)
  $workbenchError.set(null)
  $workbenchVoiceActive.set(false)
  clearDrawingTimer()
  $workbenchDrawing.set(false)
}

/**
 * Whether the workbench pane should be on screen.
 *
 * Deliberately independent of voice state: starting a conversation must NOT
 * open an empty canvas. The pane is the visible result of the voice agent
 * choosing to call `visualize`, so it appears only once an artifact exists.
 */
export function shouldShowWorkbenchPane(artifact: null | WorkbenchArtifact): boolean {
  return artifact !== null
}

// --- direct manipulation state (Track B) ---
//
// Drag/pin/hide must paint at pointer speed, so the in-flight state lives in
// the store and NOT in the artifact: a drag never awaits a gateway round trip.
// The artifact's `view_state.user_pins` is the durable record, written
// optimistically after the gesture ends and rolled back if the write fails.
//
// Note: `view_state.positions` (and the legacy `view_state.pinned`, which the
// position-persist path writes as "every node id") are AUTO-POSITION
// bookkeeping. A user pin is never inferred from them.

/** Node currently under an active drag gesture, or null. */
export const $workbenchDraggingNode = atom<null | string>(null)

/**
 * Live drag offsets, keyed by node id, in canvas units. Present only while a
 * gesture is in flight or a write is pending; the renderer adds these on top
 * of laid-out positions so the paint is instant and local.
 */
export const $workbenchDragOverride = atom<Record<string, { x: number; y: number }>>({})

export function setWorkbenchDragOverride(nodeId: string, point: null | { x: number; y: number }): void {
  const current = $workbenchDragOverride.get()

  if (point === null) {
    if (!(nodeId in current)) {
      return
    }

    const next = { ...current }
    delete next[nodeId]
    $workbenchDragOverride.set(next)

    return
  }

  $workbenchDragOverride.set({ ...current, [nodeId]: point })
}

export function clearWorkbenchDragState(): void {
  $workbenchDraggingNode.set(null)
  $workbenchDragOverride.set({})
}
