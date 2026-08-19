import { atom } from 'nanostores'

import type { WorkbenchCamera } from '@/lib/workbench-camera'

import { IDENTITY_CAMERA } from '@/lib/workbench-camera'

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
  /**
   * How the map should be ARRANGED — a semantic hint, never coordinates.
   *
   * Kind says what sort of thing the diagram is; layout says what shape it
   * takes. Without it a loop, a pipeline and a hierarchy are all just "map",
   * so "show me this linearly" had nothing to change.
   */
  layout?: string
  nodes: WorkbenchNode[]
}

export interface WorkbenchViewState {
  /**
   * The node the ASSISTANT is talking about, written by the `focus` voice
   * tool. Distinct from the user's click selection: this is where the model is
   * pointing, `$workbenchSelection` is where the user is pointing.
   */
  focus?: string
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
  updated_by?: string
  view_rev: number
  view_state: WorkbenchViewState
}

export const $workbenchArtifact = atom<null | WorkbenchArtifact>(null)
export const $workbenchError = atom<null | string>(null)
export const $workbenchVoiceActive = atom(false)

/* --- shared referent state (Track A: selection + laid-out geometry) --- */

/**
 * The node the user is currently pointing at, or null.
 *
 * This is the whole point of the shared referent: the user clicks a box, and
 * "this one" / "that one" / "it" become resolvable for the voice model.
 */
export const $workbenchSelection = atom<null | string>(null)

export interface WorkbenchLayoutSnapshot {
  height: number
  positions: Record<string, { x: number; y: number }>
  width: number
}

/**
 * Where the renderer actually put things, published so non-render consumers
 * (the voice context pusher) can describe the canvas without recomputing the
 * layout — and without ever seeing these pixels leave the app.
 */
export const $workbenchLayout = atom<null | WorkbenchLayoutSnapshot>(null)

export function setWorkbenchSelection(nodeId: null | string): void {
  if ($workbenchSelection.get() !== nodeId) {
    $workbenchSelection.set(nodeId)
  }
}

export function clearWorkbenchSelection(): void {
  setWorkbenchSelection(null)
}

export function setWorkbenchLayout(snapshot: null | WorkbenchLayoutSnapshot): void {
  $workbenchLayout.set(snapshot)
}

/* --- end shared referent state --- */

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
  const current = $workbenchArtifact.get()

  if (artifact && current?.artifact_id === artifact.artifact_id) {
    const olderSemantic = artifact.semantic_rev < current.semantic_rev

    const olderViewAtSameSemantic =
      artifact.semantic_rev === current.semantic_rev && artifact.view_rev < current.view_rev

    if (olderSemantic || olderViewAtSameSemantic) {
      return
    }
  }

  $workbenchArtifact.set(artifact)

  // A selection that no longer exists is exactly the "confidently wrong"
  // referent we are trying to avoid, so drop it when the graph loses the node.
  const selected = $workbenchSelection.get()

  if (selected !== null) {
    const nodes = (artifact?.payload as undefined | { nodes?: { id: string }[] })?.nodes

    if (!nodes?.some(node => node.id === selected)) {
      $workbenchSelection.set(null)
    }
  }

  if (artifact) {
    $workbenchError.set(null)

    // Only the mute visualizer's own artifact proves the draw finished. An
    // instant voice edit can land while a conflict retry is still generating;
    // treating that edit as completion drops `redrawing` from voice context and
    // allows another full request into the same race.
    if (artifact.updated_by === 'ambient' || artifact.updated_by === 'ambient-diff') {
      setWorkbenchDrawing(false)
    }
  }
}

export function setWorkbenchError(error: null | string): void {
  $workbenchError.set(error)

  if (error) {
    setWorkbenchDrawing(false)
  }
}

// --- camera (viewport) ---
//
// Ephemeral PRESENTATION state, deliberately NOT persisted to `view_state`.
// `view_state` is backend truth shared with the model (focus, user_pins); a
// per-window camera is not, and writing it would make two windows fight over
// the same row and add a DB write on every wheel tick.

export const $workbenchCamera = atom<WorkbenchCamera>({ ...IDENTITY_CAMERA })

/** Which artifact the current camera belongs to, so a redraw can keep it. */
let cameraArtifactId: null | string = null

export function setWorkbenchCamera(camera: WorkbenchCamera): void {
  const current = $workbenchCamera.get()

  if (current.x === camera.x && current.y === camera.y && current.zoom === camera.zoom) {
    return
  }

  $workbenchCamera.set(camera)
}

/** Reset only when the artifact identity changes, never for a same-artifact redraw. */
export function resetWorkbenchCameraFor(artifactId: null | string): void {
  if (artifactId !== null && artifactId === cameraArtifactId) {
    return
  }

  cameraArtifactId = artifactId
  setWorkbenchCamera({ ...IDENTITY_CAMERA })
}

/** Clear every foreground workbench projection when ownership moves sessions. */
export function clearWorkbenchForSessionTransition(): void {
  setWorkbenchArtifact(null)
  setWorkbenchDrawing(false)
  $workbenchError.set(null)
  $workbenchLayout.set(null)
  resetWorkbenchCameraFor(null)
}

export function resetWorkbenchForTests(): void {
  $workbenchArtifact.set(null)
  $workbenchError.set(null)
  $workbenchVoiceActive.set(false)
  clearDrawingTimer()
  $workbenchDrawing.set(false)
  $workbenchSelection.set(null)
  $workbenchLayout.set(null)
  cameraArtifactId = null
  $workbenchCamera.set({ ...IDENTITY_CAMERA })
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
