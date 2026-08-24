import { describe, expect, it, vi } from 'vitest'

import type { RealtimeMission } from './realtime-mission-controller'
import { createRealtimeMissionRuntime } from './realtime-mission-runtime'

const mission: RealtimeMission = {
  artifactId: 'research_1',
  delegationId: 'deleg_1',
  label: 'Claude Code architecture',
  missionId: 'mission_1',
  runtimeSessionId: 'runtime-1'
}

const ready = {
  artifactId: mission.artifactId,
  delegationId: mission.delegationId,
  missionId: mission.missionId
}

const setup = () => {
  const resume = vi.fn(() => true)
  const publish = vi.fn()
  const runtime = createRealtimeMissionRuntime({ publish, resume })
  runtime.focusSession('runtime-1')
  runtime.connectionOpened()
  runtime.startMission(mission)

  return { publish, resume, runtime }
}

describe('RealtimeMissionRuntime', () => {
  it('resumes exact ready research once and publishes the resuming state', () => {
    const { publish, resume, runtime } = setup()

    runtime.researchReady(ready)
    runtime.researchReady(ready)

    expect(resume).toHaveBeenCalledOnce()
    expect(resume).toHaveBeenCalledWith(expect.objectContaining({ type: 'response.create' }))
    expect(runtime.snapshot()?.state).toBe('resuming')
    expect(publish).toHaveBeenLastCalledWith(expect.objectContaining({ state: 'resuming' }))
  })

  it('waits for provider and audio boundaries before resuming', () => {
    const { resume, runtime } = setup()
    runtime.providerResponseStarted()
    runtime.assistantAudioStarted()

    runtime.researchReady(ready)
    expect(runtime.snapshot()?.state).toBe('awaiting_boundary')
    expect(resume).not.toHaveBeenCalled()

    runtime.providerResponseEnded('completed')
    expect(resume).not.toHaveBeenCalled()
    runtime.assistantAudioEnded()

    expect(resume).toHaveBeenCalledOnce()
    expect(runtime.snapshot()?.state).toBe('resuming')
  })

  it('does not resume between provider responses of the same semantic turn', () => {
    const { resume, runtime } = setup()
    runtime.providerResponseStarted()
    runtime.researchReady(ready)

    runtime.providerResponseEnded('completed', true)
    expect(resume).not.toHaveBeenCalled()

    runtime.providerResponseStarted()
    runtime.providerResponseEnded('completed', false)

    expect(resume).toHaveBeenCalledOnce()
  })

  it('keeps research alive during ordinary conversation but cancels a pending resume on barge-in', () => {
    const { resume, runtime } = setup()

    runtime.userSpeechStarted()
    runtime.userSpeechEnded()
    expect(runtime.snapshot()?.state).toBe('researching')

    runtime.providerResponseStarted()
    runtime.researchReady(ready)
    expect(runtime.snapshot()?.state).toBe('awaiting_boundary')

    runtime.userSpeechStarted()
    runtime.providerResponseEnded('cancelled')
    runtime.userSpeechEnded()

    expect(resume).not.toHaveBeenCalled()
    expect(runtime.snapshot()?.state).toBe('cancelled')
  })

  it('tracks automatic presentation through provider completion', () => {
    const { runtime } = setup()
    runtime.researchReady(ready)

    runtime.providerResponseStarted()
    expect(runtime.snapshot()?.state).toBe('presenting')

    runtime.providerResponseEnded('completed')
    expect(runtime.snapshot()?.state).toBe('complete')
  })

  it('cancels an automatic presentation when the user barges in', () => {
    const { runtime } = setup()
    runtime.researchReady(ready)
    runtime.providerResponseStarted()

    runtime.userSpeechStarted()
    runtime.providerResponseEnded('cancelled')

    expect(runtime.snapshot()?.state).toBe('cancelled')
  })

  it('cancels rather than presenting when the transport closes during resume', () => {
    const resume = vi.fn(() => false)
    const runtime = createRealtimeMissionRuntime({ publish: vi.fn(), resume })
    runtime.focusSession('runtime-1')
    runtime.connectionOpened()
    runtime.startMission(mission)

    runtime.researchReady(ready)

    expect(resume).toHaveBeenCalledOnce()
    expect(runtime.snapshot()?.state).toBe('cancelled')
  })
})
