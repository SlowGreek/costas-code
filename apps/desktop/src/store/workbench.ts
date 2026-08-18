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

export function setWorkbenchVoiceActive(active: boolean): void {
  $workbenchVoiceActive.set(active)
}

export function setWorkbenchArtifact(artifact: null | WorkbenchArtifact): void {
  $workbenchArtifact.set(artifact)

  if (artifact) {
    $workbenchError.set(null)
  }
}

export function setWorkbenchError(error: null | string): void {
  $workbenchError.set(error)
}

export function resetWorkbenchForTests(): void {
  $workbenchArtifact.set(null)
  $workbenchError.set(null)
  $workbenchVoiceActive.set(false)
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
