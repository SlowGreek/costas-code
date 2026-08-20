import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  $workbenchArtifact,
  $workbenchDrawing,
  resetWorkbenchForTests,
  setWorkbenchArtifact,
  setWorkbenchDrawing,
  setWorkbenchError,
  WORKBENCH_DRAWING_TIMEOUT_MS,
  type WorkbenchArtifact,
  workbenchTrimNotice
} from './workbench'

const artifact = (
  view_state: WorkbenchArtifact['view_state'] = {},
  updated_by = 'ambient'
): WorkbenchArtifact => ({
  artifact_id: 'map.main',
  kind: 'map',
  semantic_rev: 1,
  view_rev: 1,
  payload: { nodes: [{ id: 'voice', label: 'Voice' }], edges: [] },
  updated_by,
  view_state
})

describe('workbench drawing state', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    resetWorkbenchForTests()
  })

  afterEach(() => {
    resetWorkbenchForTests()
    vi.useRealTimers()
  })

  it('never blanks the canvas: the artifact survives a redraw', () => {
    setWorkbenchArtifact(artifact())
    setWorkbenchDrawing(true)

    expect($workbenchDrawing.get()).toBe(true)
    // The drawing on screen is untouched while the next one is produced.
    expect($workbenchArtifact.get()?.payload.nodes[0].id).toBe('voice')
  })

  it('clears on success', () => {
    setWorkbenchDrawing(true)
    setWorkbenchArtifact(artifact())

    expect($workbenchDrawing.get()).toBe(false)
  })

  it('keeps drawing active when an instant edit lands during generation', () => {
    setWorkbenchDrawing(true)
    setWorkbenchArtifact(artifact({}, 'voice-edit'))

    expect($workbenchArtifact.get()?.updated_by).toBe('voice-edit')
    expect($workbenchDrawing.get()).toBe(true)
  })

  it('clears on failure', () => {
    setWorkbenchDrawing(true)
    setWorkbenchError('visualizer exploded')

    expect($workbenchDrawing.get()).toBe(false)
  })

  it('does not get stuck if the completion event never arrives', () => {
    setWorkbenchDrawing(true)

    vi.advanceTimersByTime(WORKBENCH_DRAWING_TIMEOUT_MS - 1)
    expect($workbenchDrawing.get()).toBe(true)

    vi.advanceTimersByTime(1)
    expect($workbenchDrawing.get()).toBe(false)
  })

  it('restarts the safety timeout on a second draw', () => {
    setWorkbenchDrawing(true)
    vi.advanceTimersByTime(WORKBENCH_DRAWING_TIMEOUT_MS - 10)
    setWorkbenchDrawing(true)

    vi.advanceTimersByTime(20)
    expect($workbenchDrawing.get()).toBe(true)
  })
})

describe('workbenchTrimNotice', () => {
  it('discloses a trim recorded in view_state', () => {
    expect(workbenchTrimNotice(artifact({ trimmed: { shown: 40, total: 57 } }))).toEqual({
      shown: 40,
      total: 57
    })
  })

  it('stays silent when nothing was dropped', () => {
    expect(workbenchTrimNotice(artifact())).toBeNull()
    expect(workbenchTrimNotice(artifact({ trimmed: { shown: 12, total: 12 } }))).toBeNull()
    expect(workbenchTrimNotice(null)).toBeNull()
  })
})
