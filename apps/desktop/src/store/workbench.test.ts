import { beforeEach, describe, expect, it } from 'vitest'

import {
  $workbenchArtifact,
  $workbenchDrawing,
  $workbenchError,
  $workbenchVoiceActive,
  clearWorkbenchForSessionTransition,
  resetWorkbenchForTests,
  setWorkbenchArtifact,
  setWorkbenchDrawing,
  setWorkbenchError,
  setWorkbenchVoiceActive,
  shouldShowWorkbenchPane
} from './workbench'

const artifact = {
  artifact_id: 'map.main',
  kind: 'map',
  semantic_rev: 1,
  view_rev: 1,
  payload: { nodes: [{ id: 'voice', label: 'Voice' }], edges: [] },
  view_state: {}
}

describe('shouldShowWorkbenchPane', () => {
  beforeEach(resetWorkbenchForTests)

  it('stays closed while talking until visualize produces something', () => {
    // Voice alone must not open an empty canvas — the pane is the result of
    // the voice agent calling visualize, not a side effect of starting voice.
    setWorkbenchVoiceActive(true)
    expect(shouldShowWorkbenchPane($workbenchArtifact.get())).toBe(false)

    setWorkbenchArtifact(artifact)
    expect(shouldShowWorkbenchPane($workbenchArtifact.get())).toBe(true)
  })

  it('opens on the FIRST drawing, which the pane itself could never observe', () => {
    // Regression: the artifact.updated listener used to live inside the pane,
    // but the pane is not mounted until an artifact exists — so the first
    // visualize wrote a drawing and the canvas stayed shut forever.
    expect(shouldShowWorkbenchPane($workbenchArtifact.get())).toBe(false)

    // Simulates the app-level watcher receiving the first artifact.updated.
    setWorkbenchArtifact(artifact)

    expect(shouldShowWorkbenchPane($workbenchArtifact.get())).toBe(true)
  })

  it('keeps a drawing on screen after the voice session ends', () => {
    setWorkbenchVoiceActive(true)
    setWorkbenchArtifact(artifact)
    setWorkbenchVoiceActive(false)

    expect(shouldShowWorkbenchPane($workbenchArtifact.get())).toBe(true)
  })
})

describe('workbench store', () => {
  beforeEach(resetWorkbenchForTests)

  it('tracks the active voice posture and authoritative artifact cache', () => {
    setWorkbenchVoiceActive(true)
    setWorkbenchError('stale')
    setWorkbenchArtifact({
      artifact_id: 'map.main',
      kind: 'map',
      semantic_rev: 1,
      view_rev: 1,
      payload: { nodes: [{ id: 'voice', label: 'Voice' }], edges: [] },
      view_state: {}
    })

    expect($workbenchVoiceActive.get()).toBe(true)
    expect($workbenchArtifact.get()?.payload.nodes[0].id).toBe('voice')
    expect($workbenchError.get()).toBeNull()
  })

  it('rejects late artifact events that would move either revision backward', () => {
    setWorkbenchArtifact({ ...artifact, semantic_rev: 2, view_rev: 3 })

    setWorkbenchArtifact({ ...artifact, semantic_rev: 1, view_rev: 99 })
    expect($workbenchArtifact.get()?.semantic_rev).toBe(2)
    expect($workbenchArtifact.get()?.view_rev).toBe(3)

    setWorkbenchArtifact({ ...artifact, semantic_rev: 2, view_rev: 2 })
    expect($workbenchArtifact.get()?.view_rev).toBe(3)
  })

  it('clears the previous canvas and drawing state for a fresh session', () => {
    setWorkbenchArtifact({ ...artifact, semantic_rev: 7 })
    setWorkbenchDrawing(true)

    clearWorkbenchForSessionTransition()

    expect($workbenchArtifact.get()).toBeNull()
    expect($workbenchDrawing.get()).toBe(false)
  })
})
