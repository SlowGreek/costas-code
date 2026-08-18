import { beforeEach, describe, expect, it } from 'vitest'

import {
  $workbenchArtifact,
  $workbenchError,
  $workbenchVoiceActive,
  resetWorkbenchForTests,
  setWorkbenchArtifact,
  setWorkbenchError,
  setWorkbenchVoiceActive
} from './workbench'

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
