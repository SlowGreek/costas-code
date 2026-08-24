import { describe, expect, it, vi } from 'vitest'

import {
  createRealtimeMissionController,
  type RealtimeMission,
  type RealtimeMissionBoundary
} from './realtime-mission-controller'

const mission: RealtimeMission = {
  artifactId: 'artifact-1',
  delegationId: 'delegation-1',
  label: 'market evidence',
  missionId: 'mission-1',
  runtimeSessionId: 'runtime-1'
}

const safeBoundary: RealtimeMissionBoundary = {
  assistantAudioPlaying: false,
  connectionOpen: true,
  focusedRuntimeSessionId: 'runtime-1',
  providerResponseActive: false,
  userSpeaking: false
}

const readyEvent = (value: RealtimeMission = mission) => ({
  artifactId: value.artifactId,
  delegationId: value.delegationId,
  missionId: value.missionId
})

const startReadyMission = (boundary: Partial<RealtimeMissionBoundary> = {}, value: RealtimeMission = mission) => {
  const onResume = vi.fn()
  const controller = createRealtimeMissionController({ onResume })
  controller.updateBoundary({ ...safeBoundary, ...boundary })
  controller.startMission(value)
  controller.researchReady(readyEvent(value))

  return { controller, onResume }
}

describe('RealtimeMissionController', () => {
  it('resumes a ready mission at a safe idle boundary', () => {
    const { controller, onResume } = startReadyMission()

    expect(controller.snapshot()).toMatchObject({ ...mission, state: 'resuming' })
    expect(onResume).toHaveBeenCalledOnce()
    expect(onResume).toHaveBeenCalledWith({
      missionId: mission.missionId,
      runtimeSessionId: mission.runtimeSessionId,
      event: {
        type: 'response.create',
        response: {
          instructions:
            "Background research for the current mission is ready. Call research_status for the current artifact, inspect relevant evidence with research_search and research_read, then continue the user's original mission."
        }
      }
    })
  })

  it.each([
    ['closed connection', { connectionOpen: false }, { connectionOpen: true }],
    ['unfocused runtime session', { focusedRuntimeSessionId: 'runtime-2' }, { focusedRuntimeSessionId: 'runtime-1' }],
    ['user speech', { userSpeaking: true }, { userSpeaking: false }],
    ['assistant audio playback', { assistantAudioPlaying: true }, { assistantAudioPlaying: false }],
    ['active provider response', { providerResponseActive: true }, { providerResponseActive: false }]
  ] as const)('waits for %s and resumes when that boundary clears', (_name, blocked, released) => {
    const { controller, onResume } = startReadyMission(blocked)

    expect(controller.snapshot()?.state).toBe('awaiting_boundary')
    expect(onResume).not.toHaveBeenCalled()

    controller.updateBoundary(released)

    expect(controller.snapshot()?.state).toBe('resuming')
    expect(onResume).toHaveBeenCalledOnce()
  })

  it('does not resume until every simultaneous boundary clears', () => {
    const { controller, onResume } = startReadyMission({
      assistantAudioPlaying: true,
      providerResponseActive: true,
      userSpeaking: true
    })

    controller.updateBoundary({ userSpeaking: false })
    controller.updateBoundary({ assistantAudioPlaying: false })
    expect(onResume).not.toHaveBeenCalled()

    controller.updateBoundary({ providerResponseActive: false })
    expect(onResume).toHaveBeenCalledOnce()
  })

  it('ignores duplicate ready and lifecycle events after resuming', () => {
    const { controller, onResume } = startReadyMission()

    controller.researchReady(readyEvent())
    controller.updateBoundary({ userSpeaking: true })
    controller.updateBoundary({ userSpeaking: false })
    controller.researchReady(readyEvent())

    expect(onResume).toHaveBeenCalledOnce()
    expect(controller.snapshot()?.state).toBe('resuming')
  })

  it('does not restart or resume twice when mission acceptance is duplicated', () => {
    const { controller, onResume } = startReadyMission()

    controller.startMission(mission)
    controller.researchReady(readyEvent())

    expect(controller.snapshot()?.state).toBe('resuming')
    expect(onResume).toHaveBeenCalledOnce()
  })

  it('ignores stale ready events and mismatched event identities', () => {
    const onResume = vi.fn()
    const controller = createRealtimeMissionController({ onResume })
    controller.updateBoundary(safeBoundary)
    controller.startMission(mission)

    controller.researchReady({ ...readyEvent(), missionId: 'mission-old' })
    controller.researchReady({ ...readyEvent(), artifactId: 'artifact-old' })
    controller.researchReady({ ...readyEvent(), delegationId: 'delegation-old' })

    expect(controller.snapshot()?.state).toBe('researching')
    expect(onResume).not.toHaveBeenCalled()
  })

  it('supersedes an older mission and ignores all late events for it', () => {
    const onResume = vi.fn()
    const controller = createRealtimeMissionController({ onResume })

    const newer = {
      ...mission,
      artifactId: 'artifact-2',
      delegationId: 'delegation-2',
      missionId: 'mission-2'
    }

    controller.updateBoundary({ ...safeBoundary, userSpeaking: true })
    controller.startMission(mission)
    controller.researchReady(readyEvent())

    controller.startMission(newer)
    controller.researchReady(readyEvent(mission))
    controller.researchFailed({ ...readyEvent(mission), error: 'late failure' })
    controller.updateBoundary({ userSpeaking: false })

    expect(controller.snapshot()).toMatchObject({ ...newer, state: 'researching' })
    expect(onResume).not.toHaveBeenCalled()

    controller.researchReady(readyEvent(newer))
    expect(onResume).toHaveBeenCalledOnce()
  })

  it('cancels by mission id before readiness and ignores later readiness', () => {
    const onResume = vi.fn()
    const controller = createRealtimeMissionController({ onResume })
    controller.updateBoundary(safeBoundary)
    controller.startMission(mission)

    controller.cancelMission(mission.missionId)
    controller.researchReady(readyEvent())

    expect(controller.snapshot()?.state).toBe('cancelled')
    expect(onResume).not.toHaveBeenCalled()
  })

  it('treats barge-in while awaiting a boundary as terminal cancellation', () => {
    const { controller, onResume } = startReadyMission({ providerResponseActive: true })

    controller.bargeIn()
    controller.updateBoundary({ providerResponseActive: false })

    expect(controller.snapshot()?.state).toBe('cancelled')
    expect(onResume).not.toHaveBeenCalled()
  })

  it('keeps background research alive while the user continues the conversation', () => {
    const onResume = vi.fn()
    const controller = createRealtimeMissionController({ onResume })
    controller.updateBoundary(safeBoundary)
    controller.startMission(mission)

    controller.bargeIn()

    expect(controller.snapshot()?.state).toBe('researching')
    expect(onResume).not.toHaveBeenCalled()
  })

  it('allows cancellation after automatic resume is issued but before presentation starts', () => {
    const { controller, onResume } = startReadyMission()
    expect(controller.snapshot()?.state).toBe('resuming')
    expect(onResume).toHaveBeenCalledOnce()

    controller.cancelMission(mission.missionId)
    controller.markPresenting(mission.missionId)

    expect(controller.snapshot()?.state).toBe('cancelled')
  })

  it('invalidates an awaiting mission when focus switches runtime sessions', () => {
    const { controller, onResume } = startReadyMission({ userSpeaking: true })

    controller.updateBoundary({ focusedRuntimeSessionId: 'runtime-2' })
    controller.updateBoundary({ focusedRuntimeSessionId: 'runtime-1', userSpeaking: false })

    expect(controller.snapshot()?.state).toBe('cancelled')
    expect(onResume).not.toHaveBeenCalled()
  })

  it('invalidates an awaiting mission when focus clears during a session switch', () => {
    const { controller, onResume } = startReadyMission({ userSpeaking: true })

    controller.updateBoundary({ focusedRuntimeSessionId: null })
    controller.updateBoundary({ focusedRuntimeSessionId: 'runtime-2' })
    controller.updateBoundary({ focusedRuntimeSessionId: 'runtime-1', userSpeaking: false })

    expect(controller.snapshot()?.state).toBe('cancelled')
    expect(onResume).not.toHaveBeenCalled()
  })

  it('allows a closed connection to reopen for the same focused session', () => {
    const { controller, onResume } = startReadyMission({ connectionOpen: false })

    controller.updateBoundary({ connectionOpen: true })

    expect(controller.snapshot()?.state).toBe('resuming')
    expect(onResume).toHaveBeenCalledOnce()
  })

  it('tracks the full successful presentation lifecycle', () => {
    const { controller } = startReadyMission({ providerResponseActive: true })
    expect(controller.snapshot()?.state).toBe('awaiting_boundary')

    controller.updateBoundary({ providerResponseActive: false })
    expect(controller.snapshot()?.state).toBe('resuming')

    controller.markPresenting(mission.missionId)
    expect(controller.snapshot()?.state).toBe('presenting')

    controller.markComplete(mission.missionId)
    expect(controller.snapshot()?.state).toBe('complete')
  })

  it.each(['researching', 'awaiting_boundary', 'resuming'] as const)('accepts a matching failure while %s', state => {
    const onResume = vi.fn()
    const controller = createRealtimeMissionController({ onResume })
    controller.updateBoundary(state === 'resuming' ? safeBoundary : { ...safeBoundary, providerResponseActive: true })
    controller.startMission(mission)

    if (state !== 'researching') {
      controller.researchReady(readyEvent())
    }

    controller.researchFailed({ ...readyEvent(), error: 'research unavailable' })

    expect(controller.snapshot()).toMatchObject({
      error: 'research unavailable',
      state: 'failed'
    })
  })

  it('keeps terminal states stable under late and duplicate events', () => {
    const { controller, onResume } = startReadyMission()
    controller.markPresenting(mission.missionId)
    controller.markComplete(mission.missionId)

    controller.researchFailed({ ...readyEvent(), error: 'late' })
    controller.cancelMission(mission.missionId)
    controller.bargeIn()
    controller.markPresenting(mission.missionId)
    controller.updateBoundary({ providerResponseActive: false })

    expect(controller.snapshot()?.state).toBe('complete')
    expect(onResume).toHaveBeenCalledOnce()
  })

  it('ignores lifecycle commands for a stale mission id', () => {
    const { controller } = startReadyMission()

    controller.cancelMission('mission-old')
    controller.markPresenting('mission-old')
    controller.markComplete('mission-old')

    expect(controller.snapshot()?.state).toBe('resuming')
  })
})
