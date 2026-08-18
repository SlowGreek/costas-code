import { beforeEach, describe, expect, it } from 'vitest'

import {
  $workbenchArtifact,
  $workbenchError,
  $workbenchVoiceActive,
  resetWorkbenchForTests,
  setWorkbenchArtifact,
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
})
